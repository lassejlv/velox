//! The JavaScriptCore execution environment plus the small native surface we
//! expose to scripts (currently just `console`).

use std::os::raw::c_char;
use std::ptr;

use objc2::rc::Retained;
use objc2_foundation::{NSString, NSURL};
use objc2_javascript_core::{
    JSContext, JSContextRef, JSObjectCallAsFunction, JSObjectGetProperty,
    JSObjectMakeFunctionWithCallback, JSObjectRef, JSObjectSetProperty,
    JSStringCreateWithUTF8CString, JSStringGetMaximumUTF8CStringSize, JSStringGetUTF8CString,
    JSStringRelease, JSValue, JSValueRef,
};

use owo_colors::OwoColorize;

/// JavaScript shim that defines `console` on top of the native `__velox_log`
/// hook. Formatting (object stringification, arg joining) lives here in JS so
/// the Rust side only deals with finished text.
const CONSOLE_PRELUDE: &str = r#"
(function () {
  function inspect(a) {
    if (typeof a === 'string') return a;
    try { return __velox_inspect(a); } catch (e) { return String(a); }
  }
  // printf-style formatting matching Node's util.format / console.* semantics.
  function fmt(args) {
    if (args.length === 0) return '';
    var first = args[0];
    var i = 1;
    var out = '';
    if (typeof first === 'string' && first.indexOf('%') !== -1) {
      out = first.replace(/%[sdifjoOc%]/g, function (spec) {
        if (spec === '%%') return '%';
        if (i >= args.length) return spec; // not enough args: leave literal
        var arg = args[i++];
        switch (spec) {
          case '%s': return typeof arg === 'string' ? arg : (typeof arg === 'bigint' ? arg + 'n' : (arg !== null && typeof arg === 'object' ? inspect(arg) : String(arg)));
          case '%d': return typeof arg === 'bigint' ? arg + 'n' : String(Number(arg));
          case '%i': return typeof arg === 'bigint' ? arg + 'n' : String(parseInt(arg, 10));
          case '%f': return String(parseFloat(arg));
          case '%j': try { return JSON.stringify(arg); } catch (e) { return '[Circular]'; }
          case '%o':
          case '%O': return inspect(arg);
          case '%c': return ''; // CSS directive: ignored on a terminal
          default: return spec;
        }
      });
    } else {
      out = inspect(first);
    }
    for (; i < args.length; i++) out += ' ' + inspect(args[i]);
    return out;
  }

  var groupIndent = '';
  var counts = {};
  var timers = {};
  function emit(level, args) {
    var text = fmt(args);
    if (groupIndent) text = groupIndent + text.split('\n').join('\n' + groupIndent);
    __velox_log(level, text);
  }
  function make(level) { return function () { emit(level, arguments); }; }

  var console = {
    log: make('log'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
    trace: function () {
      var args = Array.prototype.slice.call(arguments);
      var msg = 'Trace' + (args.length ? ': ' + fmt(args) : '');
      var stack = new Error().stack || '';
      __velox_log('error', msg + '\n' + String(stack).split('\n').slice(2).join('\n'));
    },
    dir: function (obj, options) {
      try { __velox_log('log', groupIndent + __velox_inspect(obj)); }
      catch (e) { __velox_log('log', groupIndent + String(obj)); }
    },
    group: function () { if (arguments.length) emit('log', arguments); groupIndent += '  '; },
    groupCollapsed: function () { if (arguments.length) emit('log', arguments); groupIndent += '  '; },
    groupEnd: function () { groupIndent = groupIndent.slice(0, -2); },
    assert: function (cond) {
      if (cond) return;
      var rest = Array.prototype.slice.call(arguments, 1);
      __velox_log('error', 'Assertion failed' + (rest.length ? ': ' + fmt(rest) : ''));
    },
    count: function (label) {
      label = label === undefined ? 'default' : String(label);
      counts[label] = (counts[label] || 0) + 1;
      __velox_log('log', label + ': ' + counts[label]);
    },
    countReset: function (label) { counts[label === undefined ? 'default' : String(label)] = 0; },
    time: function (label) {
      label = label === undefined ? 'default' : String(label);
      timers[label] = (globalThis.performance && performance.now) ? performance.now() : Date.now();
    },
    timeEnd: function (label) {
      label = label === undefined ? 'default' : String(label);
      if (!(label in timers)) return;
      var now = (globalThis.performance && performance.now) ? performance.now() : Date.now();
      __velox_log('log', label + ': ' + (now - timers[label]).toFixed(3) + 'ms');
      delete timers[label];
    },
    timeLog: function (label) {
      label = label === undefined ? 'default' : String(label);
      if (!(label in timers)) return;
      var now = (globalThis.performance && performance.now) ? performance.now() : Date.now();
      __velox_log('log', label + ': ' + (now - timers[label]).toFixed(3) + 'ms');
    },
    table: function (data) {
      // Minimal: fall back to an inspected dump (full grid rendering is heavy).
      try { __velox_log('log', groupIndent + __velox_inspect(data)); }
      catch (e) { __velox_log('log', groupIndent + String(data)); }
    },
    dirxml: function () { emit('log', arguments); },
    clear: function () { if (globalThis.__velox_write) globalThis.__velox_write(1, '\x1b[2J\x1b[0f'); },
  };
  console.Console = function () { return console; };
  globalThis.console = console;
})();
"#;

/// Result of evaluating a chunk of JavaScript.
pub struct Evaluated {
    /// String form of the completion value, or `None` when it was `undefined`.
    pub display: Option<String>,
}

pub struct Runtime {
    context: Retained<JSContext>,
}

impl Runtime {
    pub fn new() -> Self {
        let context = unsafe { JSContext::new() };
        let runtime = Self { context };
        runtime.install_console();
        let ctx = runtime.global_context();
        crate::event_loop::install(ctx);
        crate::event_loop::install_unhandled_rejection(ctx);
        crate::fetch::install(ctx);
        let _ = runtime.eval(crate::fetch::FETCH_PRELUDE);
        // Node compatibility: native primitives + globals (process, Buffer, URL,
        // crypto, queueMicrotask, structuredClone, AbortController, …).
        crate::node::install(ctx);
        crate::server::install(ctx);
        crate::crypto::install(ctx);
        crate::sys::install(ctx);
        crate::worker::install(ctx);
        crate::vm::install(ctx);
        crate::shared::install(ctx);
        crate::sqlite::install(ctx);
        crate::udp::install(ctx);
        crate::sourcemap::install(ctx);
        let _ = runtime.eval(crate::node::GLOBALS_PRELUDE);
        let _ = runtime.eval(crate::node::BUFFER_PRELUDE);
        let _ = runtime.eval(crate::node::URL_PRELUDE);
        let _ = runtime.eval(crate::node::WEB_GLOBALS_PRELUDE);
        let _ = runtime.eval(crate::node::WEB_STREAMS_PRELUDE);
        let _ = runtime.eval(crate::node::WEB_FETCH_PRELUDE);
        let _ = runtime.eval(crate::crypto::CRYPTO_PRELUDE);
        // The `Velox` global (lazy node: builtins + serve/fs conveniences) — last,
        // since it leans on fetch, Buffer, Request/Response and the native loader.
        let _ = runtime.eval(crate::node::VELOX_PRELUDE);
        // Full `crypto.subtle` — after VELOX_PRELUDE so its lazy `require('node:crypto')` works.
        let _ = runtime.eval(crate::crypto::WEB_CRYPTO_PRELUDE);
        // If launched by `child_process.fork`, connect the IPC channel so
        // `process.send`/`process.on('message')` work. No-op otherwise.
        let _ = runtime.eval(crate::node::FORK_IPC_PRELUDE);
        runtime
    }

    /// Raw C-API context handle for the global execution context.
    fn global_context(&self) -> JSContextRef {
        unsafe { self.context.JSGlobalContextRef() as JSContextRef }
    }

    /// Raw context handle, for native subsystems that need it directly (e.g. a
    /// worker draining its inbound message queue before entering its loop).
    pub(crate) fn raw_context(&self) -> JSContextRef {
        self.global_context()
    }

    /// Drive the event loop (timers) until there is no more work. Returns
    /// `true` if a timer callback threw an uncaught exception.
    pub fn run_event_loop(&self) -> bool {
        crate::event_loop::run(self.global_context())
    }

    /// The exit code the script requested via `process.exitCode` (0 if unset).
    pub fn exit_code(&self) -> i32 {
        let script = NSString::from_str("(globalThis.process && (process.exitCode | 0)) || 0");
        let value = unsafe { self.context.evaluateScript(Some(&script)) };
        unsafe { self.context.setException(None) };
        value
            .map(|v| unsafe { v.toDouble() } as i32)
            .unwrap_or(0)
            .clamp(0, 255)
    }

    /// Evaluate JavaScript source. Returns the completion value (for the REPL)
    /// or a formatted JS exception message.
    pub fn eval(&self, source: &str) -> Result<Evaluated, String> {
        let script = NSString::from_str(source);
        // Evaluate under a synthetic URL so JSC emits line:col in error stacks;
        // `crate::sourcemap` maps those bundle positions back to source files.
        let url = NSURL::URLWithString(&NSString::from_str(crate::sourcemap::BUNDLE_URL));
        let value = unsafe {
            self.context
                .evaluateScript_withSourceURL(Some(&script), url.as_deref())
        };

        // A thrown exception is parked on the context rather than unwinding.
        if let Some(exception) = unsafe { self.context.exception() } {
            unsafe { self.context.setException(None) };
            return Err(format_exception(&exception));
        }

        // Format the completion value with the same inspector `console` uses,
        // so the REPL shows `{ a: 1 }` rather than `[object Object]`.
        let display = value.and_then(|v| unsafe {
            if v.isUndefined() {
                None
            } else {
                inspect_value(self.global_context(), v.JSValueRef())
            }
        });
        Ok(Evaluated { display })
    }

    /// Install `console` by registering the native `__velox_log(level, text)`
    /// function through the JSC C API, then running the JS prelude on top.
    fn install_console(&self) {
        unsafe {
            let ctx = self.context.JSGlobalContextRef() as JSContextRef;
            let global = JSContext::global_object(ctx);

            let name = JSStringCreateWithUTF8CString(c"__velox_log".as_ptr());
            let function = JSObjectMakeFunctionWithCallback(ctx, name, Some(velox_log));
            JSObjectSetProperty(
                ctx,
                global,
                name,
                function as JSValueRef,
                0,
                ptr::null_mut(),
            );
            JSStringRelease(name);
        }

        // Install the value inspector first so `console` can use it.
        let _ = self.eval(crate::inspect::INSPECT_PRELUDE);
        // Safe to ignore — the prelude has no completion value and can't throw.
        let _ = self.eval(CONSOLE_PRELUDE);
    }
}

/// Native implementation of `__velox_log(level, text)`. Both arguments are JS
/// strings produced by the `console` shim.
unsafe extern "C-unwind" fn velox_log(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this_object: JSObjectRef,
    argument_count: usize,
    arguments: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = if arguments.is_null() || argument_count == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(arguments as *const JSValueRef, argument_count) }
    };

    let level = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let text = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();

    print_console(&level, &text);
    unsafe { JSValue::new_undefined(ctx) }
}

/// Format a value with the global `__velox_inspect`, falling back to `None` if
/// the inspector is somehow unavailable.
unsafe fn inspect_value(ctx: JSContextRef, value: JSValueRef) -> Option<String> {
    unsafe {
        let global = JSContext::global_object(ctx);
        let name = JSStringCreateWithUTF8CString(c"__velox_inspect".as_ptr());
        let inspector = JSObjectGetProperty(ctx, global, name, ptr::null_mut());
        JSStringRelease(name);

        let inspector = JSValue::to_object(ctx, inspector, ptr::null_mut());
        if inspector.is_null() {
            return None;
        }

        let args = [value];
        let mut exception: JSValueRef = ptr::null();
        let result = JSObjectCallAsFunction(
            ctx,
            inspector,
            ptr::null_mut(),
            args.len(),
            args.as_ptr() as *mut JSValueRef,
            &mut exception,
        );
        if !exception.is_null() || result.is_null() {
            return None;
        }
        Some(js_value_to_string(ctx, result))
    }
}

/// Convert a `JSValueRef` to an owned Rust `String` via the C string API.
pub(crate) unsafe fn js_value_to_string(ctx: JSContextRef, value: JSValueRef) -> String {
    let string = unsafe { JSValue::to_string_copy(ctx, value, ptr::null_mut()) };
    if string.is_null() {
        return String::new();
    }

    let capacity = unsafe { JSStringGetMaximumUTF8CStringSize(string) };
    let mut buffer = vec![0u8; capacity];
    let written =
        unsafe { JSStringGetUTF8CString(string, buffer.as_mut_ptr() as *mut c_char, capacity) };
    unsafe { JSStringRelease(string) };

    if written == 0 {
        return String::new();
    }
    buffer.truncate(written - 1); // drop the trailing NUL
    String::from_utf8_lossy(&buffer).into_owned()
}

/// Render a console line to the right stream with a level-appropriate color.
fn print_console(level: &str, text: &str) {
    match level {
        "error" => eprintln!("{}", text.red()),
        "warn" => eprintln!("{}", text.yellow()),
        "info" => println!("{}", text.cyan()),
        "debug" => println!("{}", text.dimmed()),
        _ => println!("{text}"),
    }
}

/// Build a readable message from a thrown JS value, including a stack line.
fn format_exception(exception: &JSValue) -> String {
    let message = unsafe { exception.toString() }
        .map(|s| s.to_string())
        .unwrap_or_else(|| "<unprintable exception>".to_string());

    let stack = unsafe {
        exception
            .objectForKeyedSubscript(Some(&NSString::from_str("stack")))
            .and_then(|v| v.toString())
            .map(|s| s.to_string())
    };

    match stack {
        Some(stack) if !stack.is_empty() => {
            format!("{message}\n{}", crate::sourcemap::rewrite_stack(&stack))
        }
        _ => message,
    }
}

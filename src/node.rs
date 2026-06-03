//! A small Node.js compatibility layer.
//!
//! Two pieces:
//! * **Native primitives** — `__velox_write`, `__velox_cwd`, `__velox_isatty`,
//!   `__velox_platform`, `__velox_env_json`, `__velox_argv_json`, `__velox_exit`
//!   — the minimum host access the shims need.
//! * **`GLOBALS_PRELUDE`** — sets up `globalThis.process` and `globalThis.global`
//!   on top of those primitives, evaluated before user code.
//!
//! The `node:*` modules themselves are JS shims in `src/builtins/`, injected
//! into the bundle by `module.rs` when imported (see [`BUILTINS`]).

use std::ffi::{CStr, CString};
use std::io::Write;
use std::ptr;

use objc2_javascript_core::{
    JSContext, JSContextRef, JSObjectCallAsFunction, JSObjectGetProperty,
    JSObjectGetTypedArrayBytesPtr, JSObjectGetTypedArrayLength, JSObjectMakeTypedArray,
    JSObjectRef, JSStringCreateWithCharacters, JSStringCreateWithUTF8CString,
    JSStringGetCharactersPtr, JSStringGetLength, JSStringRelease, JSTypedArrayType, JSValue,
    JSValueRef,
};

use crate::event_loop::{arg_slice, register};
use crate::runtime::js_value_to_string;

/// Supported `node:*` builtins and their CommonJS shim source. Emitted into a
/// bundle (all of them) whenever any builtin is imported.
pub const BUILTINS: &[(&str, &str)] = &[
    ("util", include_str!("builtins/util.js")),
    ("path", include_str!("builtins/path.js")),
    ("process", include_str!("builtins/process.js")),
    ("tty", include_str!("builtins/tty.js")),
    ("readline", include_str!("builtins/readline.js")),
    (
        "readline/promises",
        include_str!("builtins/readline_promises.js"),
    ),
    ("os", include_str!("builtins/os.js")),
    ("events", include_str!("builtins/events.js")),
    ("fs", include_str!("builtins/fs.js")),
    ("buffer", include_str!("builtins/buffer_module.js")),
    ("net", include_str!("builtins/net.js")),
    ("http", include_str!("builtins/http.js")),
    ("url", include_str!("builtins/url_module.js")),
    ("crypto", include_str!("builtins/crypto.js")),
    ("stream", include_str!("builtins/stream.js")),
    (
        "stream/promises",
        include_str!("builtins/stream_promises.js"),
    ),
    ("perf_hooks", include_str!("builtins/perf_hooks.js")),
    ("worker_threads", include_str!("builtins/worker_threads.js")),
    ("async_hooks", include_str!("builtins/async_hooks.js")),
    (
        "diagnostics_channel",
        include_str!("builtins/diagnostics_channel.js"),
    ),
    ("module", include_str!("builtins/module_module.js")),
    ("http2", include_str!("builtins/http2.js")),
    ("dgram", include_str!("builtins/dgram.js")),
    ("console", include_str!("builtins/console_module.js")),
    (
        "internal/errors",
        include_str!("builtins/internal_errors.js"),
    ),
    ("ws", include_str!("builtins/ws.js")),
    ("assert", include_str!("builtins/assert.js")),
    ("querystring", include_str!("builtins/querystring.js")),
    ("string_decoder", include_str!("builtins/string_decoder.js")),
    ("timers", include_str!("builtins/timers.js")),
    (
        "timers/promises",
        include_str!("builtins/timers_promises.js"),
    ),
    ("fs/promises", include_str!("builtins/fs_promises.js")),
    ("zlib", include_str!("builtins/zlib.js")),
    ("dns", include_str!("builtins/dns.js")),
    ("dns/promises", include_str!("builtins/dns_promises.js")),
    ("child_process", include_str!("builtins/child_process.js")),
    ("cluster", include_str!("builtins/cluster.js")),
    ("sqlite", include_str!("builtins/sqlite.js")),
    ("better-sqlite3", include_str!("builtins/better_sqlite3.js")),
    ("tls", include_str!("builtins/tls.js")),
    ("https", include_str!("builtins/https.js")),
    ("vm", include_str!("builtins/vm.js")),
    ("v8", include_str!("builtins/v8.js")),
    ("_http_common", include_str!("builtins/_http_common.js")),
    ("constants", include_str!("builtins/constants.js")),
    ("velox-test", include_str!("builtins/test.js")),
    ("velox-bench", include_str!("builtins/bench.js")),
    (
        "stream/consumers",
        include_str!("builtins/stream_consumers.js"),
    ),
];

/// Installs the global `Buffer` (and `TextEncoder`/`TextDecoder`). Evaluated at
/// startup so `Buffer` is available without importing `node:buffer`.
pub const BUFFER_PRELUDE: &str = include_str!("builtins/buffer.js");

/// Installs the global `URL`/`URLSearchParams`. Evaluated at startup.
pub const URL_PRELUDE: &str = include_str!("builtins/url.js");

/// Installs Web/Node globals missing from bare JSC (`queueMicrotask`,
/// `structuredClone`, `AbortController`, `performance`, `atob`/`btoa`, …).
pub const WEB_GLOBALS_PRELUDE: &str = include_str!("builtins/web_globals.js");

/// Installs the `Velox` global (lazy `node:` builtins + `serve`/`fs`/`path`
/// conveniences) and a global CommonJS-style `require` for builtins.
pub const VELOX_PRELUDE: &str = include_str!("builtins/velox.js");

/// Connects the `child_process.fork` IPC channel when `VELOX_IPC_PORT` is set in
/// the environment (wiring `process.send`/`process.on('message')`); a no-op for
/// a normally-launched process.
pub const FORK_IPC_PRELUDE: &str = include_str!("builtins/fork_ipc.js");

/// Installs the WHATWG Streams globals (`ReadableStream`/`WritableStream`/
/// `TransformStream` + queuing strategies). Evaluated at startup before fetch.
pub const WEB_STREAMS_PRELUDE: &str = include_str!("builtins/web_streams.js");

/// Installs the WHATWG Fetch API globals (`Headers`/`Request`/`Response`/`Blob`/
/// `FormData`/`File`). Evaluated at startup.
pub const WEB_FETCH_PRELUDE: &str = include_str!("builtins/web_fetch.js");

/// Sets up `globalThis.process` and `globalThis.global`, used by user code and
/// the shims. Evaluated once at startup.
pub const GLOBALS_PRELUDE: &str = r#"
(function () {
  var env = {};
  try { env = JSON.parse(__velox_env_json()) || {}; } catch (e) {}
  var argv = ["velox"];
  try { argv = JSON.parse(__velox_argv_json()) || ["velox"]; } catch (e) {}

  function makeStream(fd) {
    return {
      fd: fd,
      writable: true,
      write: function (chunk) { __velox_write(fd, String(chunk)); return true; },
      end: function (chunk) { if (chunk != null) __velox_write(fd, String(chunk)); },
      get isTTY() { return !!__velox_isatty(fd); },
      get columns() { return 80; },
      get rows() { return 24; },
      // Minimal EventEmitter surface — no real events fire on the write streams,
      // but interactive libs (@clack/prompts) call output.on/off('resize', …)
      // and must not hit an undefined method.
      on: function () { return this; },
      addListener: function () { return this; },
      once: function () { return this; },
      off: function () { return this; },
      removeListener: function () { return this; },
      removeAllListeners: function () { return this; },
      prependListener: function () { return this; },
      emit: function () { return false; },
      listenerCount: function () { return 0; },
      listeners: function () { return []; },
      eventNames: function () { return []; },
      cork: function () {},
      uncork: function () {},
      getColorDepth: function () { return __velox_isatty(fd) ? 8 : 1; },
      hasColors: function () { return !!__velox_isatty(fd); },
    };
  }

  // A minimal stdin stream: starts a background reader when first consumed
  // (so scripts that don't read stdin still exit). Chunks/EOF arrive via the
  // __velox_stdin_data/_end dispatchers below.
  var stdinRegistry = {};
  var stdinToken = 1;
  function makeStdin() {
    var listeners = {};
    var started = false;
    var encoding = null;
    var token = stdinToken++;
    function emit(ev) {
      var l = listeners[ev];
      if (!l) return false;
      // Forward ALL arguments — `keypress` events carry (str, key); a single-arg
      // emit would drop the key object, breaking interactive prompts.
      var args = Array.prototype.slice.call(arguments, 1);
      var copy = l.slice();
      for (var i = 0; i < copy.length; i++) copy[i].apply(stream, args);
      return true;
    }
    function start() {
      if (started) return;
      started = true;
      stdinRegistry[token] = stream;
      __velox_stdin_start(token);
    }
    function on(ev, fn) {
      (listeners[ev] || (listeners[ev] = [])).push(fn);
      if (ev === "data" || ev === "end" || ev === "readable") start();
      return stream;
    }
    var stream = {
      readable: true,
      fd: 0,
      isRaw: false,
      get isTTY() { return !!__velox_isatty(0); },
      // Interactive prompts (inquirer/prompts/create-vite) put the terminal in
      // raw mode to read keypresses; the native sets termios and restores it on
      // exit. A no-op when stdin isn't a TTY.
      setRawMode: function (mode) {
        stream.isRaw = !!mode;
        if (typeof __velox_stdin_set_raw === "function") __velox_stdin_set_raw(!!mode);
        return stream;
      },
      ref: function () { return stream; },
      unref: function () { return stream; },
      on: on,
      addListener: on,
      once: function (ev, fn) {
        function wrap() { stream.removeListener(ev, wrap); return fn.apply(this, arguments); }
        wrap._fn = fn;
        return on(ev, wrap);
      },
      removeListener: function (ev, fn) {
        var l = listeners[ev];
        if (l) listeners[ev] = l.filter(function (f) { return f !== fn && f._fn !== fn; });
        return stream;
      },
      off: function (ev, fn) { return stream.removeListener(ev, fn); },
      removeAllListeners: function (ev) { if (ev) delete listeners[ev]; else listeners = {}; return stream; },
      listenerCount: function (ev) { return (listeners[ev] || []).length; },
      emit: emit,
      resume: function () { start(); return stream; },
      pause: function () { return stream; },
      setEncoding: function (e) { encoding = e; return stream; },
      read: function () { start(); return null; },
      pipe: function (dest) {
        on("data", function (c) { dest.write(c); });
        on("end", function () { if (dest.end) dest.end(); });
        return dest;
      },
      // No pipe-destination tracking; interactive libs (@clack/prompts) call
      // unpipe() during teardown and only need it to exist and not throw.
      unpipe: function () { return stream; },
      _encoding: function () { return encoding; },
      _emit: emit,
    };
    return stream;
  }

  var startMs = Date.now();
  var process = {
    platform: __velox_platform(),
    arch: "arm64",
    env: env,
    argv: argv,
    argv0: argv[0] || "velox",
    execArgv: [],
    execPath: argv[0] || "velox",
    pid: 1,
    ppid: 0,
    title: "velox",
    version: "v22.12.0",
    versions: { node: "22.12.0", velox: "0.1.0", v8: "12.4.254.21-node.21" },
    release: { name: "node" },
    exitCode: 0,
    stdout: makeStream(1),
    stderr: makeStream(2),
    stdin: makeStdin(),
    cwd: function () { return __velox_cwd(); },
    chdir: function () {},
    // Node 22: return a builtin module by id (or undefined for non-builtins).
    getBuiltinModule: function (id) { try { return require(id); } catch (e) { return undefined; } },
    exit: function (code) {
      var c = code === undefined ? (this.exitCode | 0) : (code | 0);
      try { this.emit('exit', c); } catch (e) {}
      __velox_exit(c);
    },
    nextTick: function (cb) {
      var extra = Array.prototype.slice.call(arguments, 1);
      Promise.resolve().then(function () { cb.apply(null, extra); });
    },
    // A real (minimal) EventEmitter so `process.on('exit'|'message'|
    // 'uncaughtException'|...)` actually fires. `_events` maps name -> fn[].
    _events: {},
    on: function (name, fn) {
      (this._events[name] || (this._events[name] = [])).push(fn);
      return this;
    },
    addListener: function (name, fn) { return this.on(name, fn); },
    once: function (name, fn) {
      var self = this;
      function wrap() { self.removeListener(name, wrap); return fn.apply(this, arguments); }
      wrap._origin = fn;
      return this.on(name, wrap);
    },
    off: function (name, fn) { return this.removeListener(name, fn); },
    removeListener: function (name, fn) {
      var list = this._events[name];
      if (list) this._events[name] = list.filter(function (f) { return f !== fn && f._origin !== fn; });
      return this;
    },
    removeAllListeners: function (name) {
      if (name === undefined) this._events = {}; else delete this._events[name];
      return this;
    },
    listeners: function (name) { return (this._events[name] || []).slice(); },
    listenerCount: function (name) { return (this._events[name] || []).length; },
    emit: function (name) {
      var list = this._events[name];
      if (!list || !list.length) return false;
      var args = Array.prototype.slice.call(arguments, 1);
      list.slice().forEach(function (fn) { try { fn.apply(globalThis.process, args); } catch (e) { __velox_log('error', String(e && e.stack || e)); } });
      return true;
    },
    emitWarning: function (w) {
      try { __velox_log('warn', '(velox) Warning: ' + (w && w.message ? w.message : w)); } catch (e) {}
    },
    hrtime: function (prev) {
      var ns = __velox_hrtime_ns();
      var s = Math.floor(ns / 1e9);
      var nano = Math.floor(ns - s * 1e9);
      if (prev) {
        var ds = s - prev[0], dn = nano - prev[1];
        if (dn < 0) { ds -= 1; dn += 1e9; }
        return [ds, dn];
      }
      return [s, nano];
    },
    uptime: function () { return __velox_hrtime_ns() / 1e9; },
    memoryUsage: function () { var m = __velox_mem_info_parse(); return { rss: m.rss, heapTotal: m.rss, heapUsed: m.rss, external: 0, arrayBuffers: 0 }; },
    cpuUsage: function (prev) {
      var parts = String(__velox_cpu_usage()).split(",");
      var user = Math.round(+parts[0]), system = Math.round(+parts[1]);
      if (prev) { user -= prev.user; system -= prev.system; }
      return { user: user, system: system };
    },
    resourceUsage: function () {
      var parts = String(__velox_cpu_usage()).split(",");
      return { userCPUTime: Math.round(+parts[0]), systemCPUTime: Math.round(+parts[1]), maxRSS: 0 };
    },
    getuid: function () { return 0; },
    getgid: function () { return 0; },
    geteuid: function () { return 0; },
    getegid: function () { return 0; },
    // umask() reports/sets the file-mode creation mask. velox doesn't apply one,
    // but fstream/npm-style packages call it at load; track the value so the
    // get/set contract holds (returns the previous mask on set).
    umask: function (mask) {
      var prev = process._umask === undefined ? 0o22 : process._umask;
      if (mask !== undefined) process._umask = typeof mask === "string" ? parseInt(mask, 8) : (mask | 0);
      return prev;
    },
    // Node exposes a small set of build-time feature flags; libraries probe
    // these (e.g. `process.features.tls`, `.inspector`) before using an API.
    features: { inspector: false, debug: false, uv: true, ipv6: true, tls_alpn: true, tls_sni: true, tls_ocsp: true, tls: true, cached_builtins: true, typescript: "transpile" },
  };
  process.hrtime.bigint = function () { return BigInt(Math.round(__velox_hrtime_ns())); };

  // memoryUsage().rss / availableMemory() are backed by one native that reports
  // current resident size (mach task_info) and free physical memory (mach
  // vm_statistics). Cached parse helper so the hot `.rss()` accessor is cheap.
  globalThis.__velox_mem_info_parse = function () {
    try { return JSON.parse(__velox_mem_info()); } catch (e) { return { rss: 0, available: 0 }; }
  };
  process.memoryUsage.rss = function () { return __velox_mem_info_parse().rss; };
  process.availableMemory = function () { return __velox_mem_info_parse().available; };
  process.constrainedMemory = function () { return 0; };

  // getActiveResourcesInfo() lists strings naming live event-loop resources.
  // velox doesn't expose per-handle bookkeeping to JS; report an empty list
  // (callers use it for diagnostics, not control flow).
  process.getActiveResourcesInfo = function () { return []; };

  // loadEnvFile([path]) parses a .env file and assigns to process.env, mirroring
  // Node 20.12+. Minimal dotenv: KEY=VALUE per line, # comments, optional quotes.
  process.loadEnvFile = function (path) {
    var fs = require('node:fs');
    var src = fs.readFileSync(path == null ? '.env' : path, 'utf8');
    src.split(/\r?\n/).forEach(function (line) {
      var m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) return;
      var v = m[2];
      if (v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
      else if (v[0] === "'" && v[v.length - 1] === "'") v = v.slice(1, -1);
      else { var h = v.indexOf(' #'); if (h !== -1) v = v.slice(0, h); v = v.trim(); }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    });
  };
  // Node tags `process` so `Object.prototype.toString.call(process)` is
  // `[object process]`; libraries (e.g. axios's adapter detection) rely on it.
  try { Object.defineProperty(process, Symbol.toStringTag, { value: "process", configurable: true }); } catch (e) {}

  globalThis.process = process;
  globalThis.global = globalThis;

  // Called by JSC's unhandled-rejection hook (src/event_loop.rs). Emits
  // process 'unhandledRejection'; with no listener, surfaces the error like
  // Node (print + non-zero exit) instead of the loop silently draining.
  globalThis.__velox_report_unhandled_rejection = function (reason, promise) {
    if (process.emit('unhandledRejection', reason, promise)) return;
    var msg = reason && reason.stack
      ? reason.stack
      : (reason && reason.message ? reason.message : String(reason));
    __velox_uncaught('Unhandled promise rejection: ' + msg);
  };

  // stdin chunk/EOF dispatchers (called by the host's reader thread).
  globalThis.__velox_stdin_data = function (token, latin1) {
    var s = stdinRegistry[token];
    if (!s) return;
    var buf = Buffer.from(latin1, "latin1");
    s._emit("data", s._encoding() ? buf.toString(s._encoding()) : buf);
  };
  globalThis.__velox_stdin_end = function (token) {
    var s = stdinRegistry[token];
    if (!s) return;
    delete stdinRegistry[token];
    s._emit("end");
  };
  // Stand-in for `import.meta` (the bundler rewrites `import.meta` to this).
  globalThis.__velox_meta = { url: "file:///velox", env: {} };
  // Builds the Error that native `fs` primitives throw on failure.
  globalThis.__velox_fs_error = function (code, message) {
    var e = new Error(message);
    e.code = code;
    e.errno = -1;
    e.syscall = "fs";
    return e;
  };
})();
"#;

/// Register the native primitives.
pub fn install(ctx: JSContextRef) {
    unsafe {
        register(ctx, c"__velox_write", velox_write);
        register(ctx, c"__velox_cwd", velox_cwd);
        register(ctx, c"__velox_platform", velox_platform);
        register(ctx, c"__velox_isatty", velox_isatty);
        register(ctx, c"__velox_env_json", velox_env_json);
        register(ctx, c"__velox_argv_json", velox_argv_json);
        register(ctx, c"__velox_exit", velox_exit);
        register(ctx, c"__velox_os_info", velox_os_info);
        register(ctx, c"__velox_hrtime_ns", velox_hrtime_ns);
        register(ctx, c"__velox_cpu_usage", velox_cpu_usage);
        register(ctx, c"__velox_mem_info", velox_mem_info);
        register(ctx, c"__velox_load_builtin", velox_load_builtin);

        register(ctx, c"__velox_read_file", fs_read_file);
        register(ctx, c"__velox_write_file", fs_write_file);
        register(ctx, c"__velox_exists", fs_exists);
        register(ctx, c"__velox_stat", fs_stat);
        register(ctx, c"__velox_statfs", fs_statfs);
        register(ctx, c"__velox_readdir", fs_readdir);
        register(ctx, c"__velox_mkdir", fs_mkdir);
        register(ctx, c"__velox_rm", fs_rm);
        register(ctx, c"__velox_rename", fs_rename);
        register(ctx, c"__velox_realpath", fs_realpath);
    }
}

/// `__velox_write(fd, text)` — write raw bytes to stdout (fd 1) or stderr (fd 2).
unsafe extern "C-unwind" fn velox_write(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let fd = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(1.0);
    let text = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();

    if fd as i64 == 2 {
        let mut err = std::io::stderr();
        let _ = err.write_all(text.as_bytes());
        let _ = err.flush();
    } else {
        let mut out = std::io::stdout();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
    unsafe { JSValue::new_undefined(ctx) }
}

unsafe extern "C-unwind" fn velox_cwd(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".to_string());
    unsafe { js_string(ctx, &cwd) }
}

unsafe extern "C-unwind" fn velox_platform(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    unsafe { js_string(ctx, node_platform()) }
}

/// `__velox_isatty(fd)` — is the given fd a terminal?
unsafe extern "C-unwind" fn velox_isatty(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    use std::io::IsTerminal;
    let args = arg_slice(argc, argv);
    let fd = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(-1.0);
    let is_tty = match fd as i64 {
        0 => std::io::stdin().is_terminal(),
        1 => std::io::stdout().is_terminal(),
        2 => std::io::stderr().is_terminal(),
        _ => false,
    };
    unsafe { JSValue::new_boolean(ctx, is_tty) }
}

unsafe extern "C-unwind" fn velox_env_json(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let mut json = String::from("{");
    for (i, (key, value)) in std::env::vars().enumerate() {
        if i > 0 {
            json.push(',');
        }
        json_escape(&key, &mut json);
        json.push(':');
        json_escape(&value, &mut json);
    }
    json.push('}');
    unsafe { js_string(ctx, &json) }
}

unsafe extern "C-unwind" fn velox_argv_json(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let mut json = String::from("[");
    for (i, arg) in std::env::args().enumerate() {
        if i > 0 {
            json.push(',');
        }
        json_escape(&arg, &mut json);
    }
    json.push(']');
    unsafe { js_string(ctx, &json) }
}

/// `__velox_exit(code)` — flush and terminate the process.
unsafe extern "C-unwind" fn velox_exit(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let code = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0);
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(code as i32);
}

thread_local! {
    /// Process-start instant for high-resolution timing.
    static HRTIME_START: std::time::Instant = std::time::Instant::now();
}

/// `__velox_hrtime_ns()` → nanoseconds since process start (monotonic).
unsafe extern "C-unwind" fn velox_hrtime_ns(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let ns = HRTIME_START.with(|s| s.elapsed().as_nanos()) as f64;
    unsafe { JSValue::new_number(ctx, ns) }
}

/// `__velox_cpu_usage()` → "user,system" CPU microseconds (via `getrusage`),
/// the basis for `process.cpuUsage()`/`resourceUsage()`.
unsafe extern "C-unwind" fn velox_cpu_usage(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let mut usage: libc::rusage = unsafe { std::mem::zeroed() };
    let user_us;
    let sys_us;
    if unsafe { libc::getrusage(libc::RUSAGE_SELF, &mut usage) } == 0 {
        user_us = usage.ru_utime.tv_sec as f64 * 1e6 + usage.ru_utime.tv_usec as f64;
        sys_us = usage.ru_stime.tv_sec as f64 * 1e6 + usage.ru_stime.tv_usec as f64;
    } else {
        user_us = 0.0;
        sys_us = 0.0;
    }
    unsafe { js_string(ctx, &format!("{user_us},{sys_us}")) }
}

/// `__velox_mem_info()` → JSON `{"rss":<bytes>,"available":<bytes>}`. RSS is the
/// process's current resident size (mach `task_info`/`MACH_TASK_BASIC_INFO`);
/// `available` is free + inactive physical pages (mach `host_statistics64`).
/// Backs `process.memoryUsage().rss`/`.rss()` and `process.availableMemory()`.
// `mach_task_self`/`mach_host_self` are deprecated in `libc` (it points at the
// `mach2` crate) but still the standard way to reach these mach calls without
// pulling in another dependency; they're macOS-stable.
#[allow(deprecated)]
unsafe extern "C-unwind" fn velox_mem_info(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let rss: u64 = unsafe {
        let mut info: libc::mach_task_basic_info = std::mem::zeroed();
        let mut count = (std::mem::size_of::<libc::mach_task_basic_info>()
            / std::mem::size_of::<libc::natural_t>())
            as libc::mach_msg_type_number_t;
        let kr = libc::task_info(
            libc::mach_task_self(),
            libc::MACH_TASK_BASIC_INFO,
            &mut info as *mut _ as libc::task_info_t,
            &mut count,
        );
        if kr == libc::KERN_SUCCESS {
            info.resident_size
        } else {
            0
        }
    };

    let available: u64 = unsafe {
        let page_size = libc::sysconf(libc::_SC_PAGESIZE) as u64;
        let mut vm: libc::vm_statistics64 = std::mem::zeroed();
        let mut count = (std::mem::size_of::<libc::vm_statistics64>()
            / std::mem::size_of::<libc::integer_t>())
            as libc::mach_msg_type_number_t;
        let kr = libc::host_statistics64(
            libc::mach_host_self(),
            libc::HOST_VM_INFO64,
            &mut vm as *mut _ as libc::host_info64_t,
            &mut count,
        );
        if kr == libc::KERN_SUCCESS {
            (vm.free_count as u64 + vm.inactive_count as u64) * page_size
        } else {
            0
        }
    };

    unsafe { js_string(ctx, &format!("{{\"rss\":{rss},\"available\":{available}}}")) }
}

/// `__velox_os_info()` → JSON of host facts (hostname, cpus, memory, loadavg).
unsafe extern "C-unwind" fn velox_os_info(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let hostname = {
        let mut buf = [0u8; 256];
        unsafe { libc::gethostname(buf.as_mut_ptr() as *mut libc::c_char, buf.len()) };
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    };
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    let totalmem = {
        let mut mem: u64 = 0;
        let mut size = std::mem::size_of::<u64>();
        let mut mib = [libc::CTL_HW, libc::HW_MEMSIZE];
        unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                &mut mem as *mut u64 as *mut libc::c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        mem
    };
    let mut load = [0f64; 3];
    unsafe { libc::getloadavg(load.as_mut_ptr(), 3) };

    let mut json = String::from("{\"hostname\":");
    json_escape(&hostname, &mut json);
    json.push_str(&format!(
        ",\"cpus\":{cpus},\"totalmem\":{totalmem},\"loadavg\":[{},{},{}],\"arch\":",
        load[0], load[1], load[2]
    ));
    json_escape(node_arch(), &mut json);
    json.push('}');
    unsafe { js_string(ctx, &json) }
}

/// `__velox_load_builtin(name)` → the JS source of a `node:` builtin shim (or
/// `""` if unknown). Backs the global `require`/`Velox` lazy module loader, which
/// evaluates the returned source as a CommonJS module on demand.
unsafe extern "C-unwind" fn velox_load_builtin(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let spec = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let name = spec.strip_prefix("node:").unwrap_or(&spec);
    let source = BUILTINS
        .iter()
        .chain(crate::oxc_helpers::OXC_HELPERS.iter())
        .find(|(n, _)| *n == name)
        .or_else(|| {
            let base = name.split('/').next().unwrap_or(name);
            BUILTINS.iter().find(|(n, _)| *n == base)
        })
        .map(|(_, src)| *src)
        .unwrap_or("");
    unsafe { js_string(ctx, source) }
}

/// Node's arch name (`arm64`/`x64`/…).
fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        "x86" => "ia32",
        other => other,
    }
}

/// Node's platform name (`darwin`/`win32`/`linux`).
fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

/// Build a JS string value from a Rust string (NULs are stripped).
pub(crate) unsafe fn js_string(ctx: JSContextRef, text: &str) -> JSValueRef {
    let cstring = CString::new(text.replace('\0', "")).unwrap_or_default();
    unsafe {
        let js = JSStringCreateWithUTF8CString(cstring.as_ptr());
        let value = JSValue::new_string(ctx, js);
        JSStringRelease(js);
        value
    }
}

/// Append `text` to `out` as a quoted, escaped JSON string.
fn json_escape(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

// ---------------------------------------------------------------------------
// fs native primitives
//
// File bytes cross the JS boundary as "latin1" strings (one UTF-16 unit per
// byte, 0..=255), which is binary-safe; the `fs` shim converts to/from Buffer.
// Errors are thrown by building an Error via the global `__velox_fs_error`.
// ---------------------------------------------------------------------------

/// `__velox_read_file(path)` → file bytes as a latin1 string.
unsafe extern "C-unwind" fn fs_read_file(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let path = path_arg(ctx, argc, argv);
    match std::fs::read(&path) {
        Ok(bytes) => unsafe { js_string_latin1(ctx, &bytes) },
        Err(e) => unsafe { fs_throw(ctx, exception, &e, &path, "open") },
    }
}

/// `__velox_write_file(path, latin1Data, append)`.
unsafe extern "C-unwind" fn fs_write_file(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let path = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let data = args
        .get(1)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default();
    let append = args
        .get(2)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(false);

    let result = if append {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .and_then(|mut f| f.write_all(&data))
    } else {
        std::fs::write(&path, &data)
    };
    match result {
        Ok(()) => unsafe { JSValue::new_undefined(ctx) },
        Err(e) => unsafe { fs_throw(ctx, exception, &e, &path, "open") },
    }
}

/// `__velox_exists(path)` → boolean.
unsafe extern "C-unwind" fn fs_exists(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let path = path_arg(ctx, argc, argv);
    unsafe { JSValue::new_boolean(ctx, std::path::Path::new(&path).exists()) }
}

/// `__velox_stat(path, followSymlinks)` → JSON of stat fields.
unsafe extern "C-unwind" fn fs_stat(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    use std::os::unix::fs::PermissionsExt;
    use std::time::UNIX_EPOCH;

    let args = arg_slice(argc, argv);
    let path = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let follow = args
        .get(1)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(true);

    let meta = if follow {
        std::fs::metadata(&path)
    } else {
        std::fs::symlink_metadata(&path)
    };
    match meta {
        Ok(m) => {
            let kind = if m.is_file() {
                "file"
            } else if m.is_dir() {
                "dir"
            } else if m.file_type().is_symlink() {
                "symlink"
            } else {
                "other"
            };
            let ms = |t: std::io::Result<std::time::SystemTime>| -> u128 {
                t.ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            };
            let json = format!(
                r#"{{"_type":"{}","size":{},"mode":{},"mtimeMs":{},"atimeMs":{},"ctimeMs":{},"birthtimeMs":{}}}"#,
                kind,
                m.len(),
                m.permissions().mode(),
                ms(m.modified()),
                ms(m.accessed()),
                ms(m.modified()),
                ms(m.created()),
            );
            unsafe { js_string(ctx, &json) }
        }
        Err(e) => unsafe { fs_throw(ctx, exception, &e, &path, "stat") },
    }
}

/// `__velox_statfs(path)` → JSON of filesystem stats (via `statvfs`). Backs
/// `fs.statfsSync`/`fs.statfs`. `type` is reported 0 (statvfs carries no fs-type
/// magic on macOS); the block/inode counts are the values callers actually use.
unsafe extern "C-unwind" fn fs_statfs(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let path = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let c_path = CString::new(path.replace('\0', "")).unwrap();
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut st) } == 0 {
        // bsize is the fundamental block size (f_frsize), falling back to f_bsize.
        let bsize = if st.f_frsize != 0 {
            st.f_frsize
        } else {
            st.f_bsize
        };
        let json = format!(
            r#"{{"type":0,"bsize":{},"blocks":{},"bfree":{},"bavail":{},"files":{},"ffree":{}}}"#,
            bsize, st.f_blocks, st.f_bfree, st.f_bavail, st.f_files, st.f_ffree,
        );
        unsafe { js_string(ctx, &json) }
    } else {
        let e = std::io::Error::last_os_error();
        unsafe { fs_throw(ctx, exception, &e, &path, "statfs") }
    }
}

/// `__velox_readdir(path)` → JSON array of entry names.
unsafe extern "C-unwind" fn fs_readdir(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let path = path_arg(ctx, argc, argv);
    match std::fs::read_dir(&path) {
        Ok(entries) => {
            let mut json = String::from("[");
            for (i, entry) in entries.flatten().enumerate() {
                if i > 0 {
                    json.push(',');
                }
                json_escape(&entry.file_name().to_string_lossy(), &mut json);
            }
            json.push(']');
            unsafe { js_string(ctx, &json) }
        }
        Err(e) => unsafe { fs_throw(ctx, exception, &e, &path, "scandir") },
    }
}

/// `__velox_mkdir(path, recursive)`.
unsafe extern "C-unwind" fn fs_mkdir(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let path = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let recursive = args
        .get(1)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(false);
    let result = if recursive {
        std::fs::create_dir_all(&path)
    } else {
        std::fs::create_dir(&path)
    };
    match result {
        Ok(()) => unsafe { JSValue::new_undefined(ctx) },
        Err(e) => unsafe { fs_throw(ctx, exception, &e, &path, "mkdir") },
    }
}

/// `__velox_rm(path, recursive, force)`.
unsafe extern "C-unwind" fn fs_rm(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let path = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let recursive = args
        .get(1)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(false);
    let force = args
        .get(2)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(false);

    let p = std::path::Path::new(&path);
    let result = if p.is_dir() {
        if recursive {
            std::fs::remove_dir_all(p)
        } else {
            std::fs::remove_dir(p)
        }
    } else {
        std::fs::remove_file(p)
    };
    match result {
        Ok(()) => unsafe { JSValue::new_undefined(ctx) },
        Err(e) if force && e.kind() == std::io::ErrorKind::NotFound => unsafe {
            JSValue::new_undefined(ctx)
        },
        Err(e) => unsafe { fs_throw(ctx, exception, &e, &path, "unlink") },
    }
}

/// `__velox_rename(from, to)`.
unsafe extern "C-unwind" fn fs_rename(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let from = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let to = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    match std::fs::rename(&from, &to) {
        Ok(()) => unsafe { JSValue::new_undefined(ctx) },
        Err(e) => unsafe { fs_throw(ctx, exception, &e, &from, "rename") },
    }
}

/// `__velox_realpath(path)` → canonical absolute path.
unsafe extern "C-unwind" fn fs_realpath(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let path = path_arg(ctx, argc, argv);
    match std::fs::canonicalize(&path) {
        Ok(p) => unsafe { js_string(ctx, &p.to_string_lossy()) },
        Err(e) => unsafe { fs_throw(ctx, exception, &e, &path, "realpath") },
    }
}

/// Read argument 0 as a path string.
fn path_arg(ctx: JSContextRef, argc: usize, argv: *mut JSValueRef) -> String {
    arg_slice(argc, argv)
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default()
}

/// Build a JS "latin1" string (one code unit per byte) from raw bytes.
pub(crate) unsafe fn js_string_latin1(ctx: JSContextRef, bytes: &[u8]) -> JSValueRef {
    let units: Vec<u16> = bytes.iter().map(|&b| b as u16).collect();
    unsafe {
        let js = JSStringCreateWithCharacters(units.as_ptr(), units.len());
        let value = JSValue::new_string(ctx, js);
        JSStringRelease(js);
        value
    }
}

/// Copy the bytes of a JS typed array (`Uint8Array`/`Buffer`) into a `Vec`.
/// Returns an empty vec if `value` is not a typed array. Avoids the latin1
/// string round-trip for binary socket I/O.
pub(crate) unsafe fn js_value_to_bytes(ctx: JSContextRef, value: JSValueRef) -> Vec<u8> {
    unsafe {
        let ty = JSValue::typed_array_type(ctx, value, ptr::null_mut());
        if ty == JSTypedArrayType::None || ty == JSTypedArrayType::ArrayBuffer {
            return Vec::new();
        }
        let obj = JSValue::to_object(ctx, value, ptr::null_mut());
        if obj.is_null() {
            return Vec::new();
        }
        let len = JSObjectGetTypedArrayLength(ctx, obj, ptr::null_mut());
        if len == 0 {
            return Vec::new();
        }
        let data = JSObjectGetTypedArrayBytesPtr(ctx, obj, ptr::null_mut());
        if data.is_null() {
            return Vec::new();
        }
        std::slice::from_raw_parts(data as *const u8, len).to_vec()
    }
}

/// Build a JS `Uint8Array` (a `Buffer` once wrapped in JS) holding `bytes`.
/// One copy, no per-byte char conversion (unlike `js_string_latin1`).
pub(crate) unsafe fn js_uint8array(ctx: JSContextRef, bytes: &[u8]) -> JSValueRef {
    unsafe {
        let obj = JSObjectMakeTypedArray(
            ctx,
            JSTypedArrayType::Uint8Array,
            bytes.len(),
            ptr::null_mut(),
        );
        if obj.is_null() {
            return JSValue::new_undefined(ctx);
        }
        if !bytes.is_empty() {
            let data = JSObjectGetTypedArrayBytesPtr(ctx, obj, ptr::null_mut());
            if !data.is_null() {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), data as *mut u8, bytes.len());
            }
        }
        obj as JSValueRef
    }
}

/// Decode a JS "latin1" string back to raw bytes (low byte of each code unit).
pub(crate) unsafe fn js_value_to_latin1(ctx: JSContextRef, value: JSValueRef) -> Vec<u8> {
    unsafe {
        let js = JSValue::to_string_copy(ctx, value, ptr::null_mut());
        if js.is_null() {
            return Vec::new();
        }
        let len = JSStringGetLength(js);
        let chars = JSStringGetCharactersPtr(js);
        let mut out = Vec::with_capacity(len);
        if !chars.is_null() {
            for &unit in std::slice::from_raw_parts(chars, len) {
                out.push((unit & 0xff) as u8);
            }
        }
        JSStringRelease(js);
        out
    }
}

/// Throw a Node-style fs error by setting the callback's exception out-param.
unsafe fn fs_throw(
    ctx: JSContextRef,
    exception: *mut JSValueRef,
    error: &std::io::Error,
    path: &str,
    syscall: &str,
) -> JSValueRef {
    let code = errno_code(error);
    let message = format!("{code}: {error}, {syscall} '{path}'");
    unsafe {
        let args = [js_string(ctx, code), js_string(ctx, &message)];
        let value = call_named(ctx, c"__velox_fs_error", &args);
        if !exception.is_null() {
            *exception = value;
        }
        JSValue::new_undefined(ctx)
    }
}

/// Map an I/O error to a Node `errno` code string.
fn errno_code(error: &std::io::Error) -> &'static str {
    use std::io::ErrorKind::*;
    match error.kind() {
        NotFound => "ENOENT",
        PermissionDenied => "EACCES",
        AlreadyExists => "EEXIST",
        _ => match error.raw_os_error() {
            Some(2) => "ENOENT",
            Some(13) => "EACCES",
            Some(17) => "EEXIST",
            Some(20) => "ENOTDIR",
            Some(21) => "EISDIR",
            Some(66) => "ENOTEMPTY",
            _ => "EIO",
        },
    }
}

/// Call a global JS function by name and return its result.
pub(crate) unsafe fn call_named(ctx: JSContextRef, name: &CStr, args: &[JSValueRef]) -> JSValueRef {
    unsafe {
        let global = JSContext::global_object(ctx);
        let name_str = JSStringCreateWithUTF8CString(name.as_ptr());
        let function_value = JSObjectGetProperty(ctx, global, name_str, ptr::null_mut());
        JSStringRelease(name_str);

        let function = JSValue::to_object(ctx, function_value, ptr::null_mut());
        if function.is_null() {
            return JSValue::new_undefined(ctx);
        }
        let mut exception: JSValueRef = ptr::null();
        let result = JSObjectCallAsFunction(
            ctx,
            function,
            ptr::null_mut(),
            args.len(),
            args.as_ptr() as *mut JSValueRef,
            &mut exception,
        );
        if result.is_null() {
            JSValue::new_undefined(ctx)
        } else {
            result
        }
    }
}

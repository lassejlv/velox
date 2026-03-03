use crate::builtins;
use crate::colors;
use crate::event_loop::EventLoop;
use crate::modules;
use crate::transpiler;
use rusty_v8 as v8;
use std::sync::Once;

static V8_INIT: Once = Once::new();

pub struct Runtime;

impl Runtime {
    pub fn new() -> Self {
        V8_INIT.call_once(|| {
            let platform = v8::new_default_platform(0, false).make_shared();
            v8::V8::initialize_platform(platform);
            v8::V8::initialize();
        });
        Self
    }

    pub fn execute(&mut self, filename: &str, source: &str) -> Result<String, String> {
        let isolate = &mut v8::Isolate::new(v8::CreateParams::default());

        // Set up module system callbacks on the isolate
        isolate.set_host_initialize_import_meta_object_callback(
            modules::host_initialize_import_meta_object_callback,
        );
        isolate.set_host_import_module_dynamically_callback(
            modules::host_import_module_dynamically_callback,
        );

        let handle_scope = &mut v8::HandleScope::new(isolate);
        let context = v8::Context::new(handle_scope);
        let scope = &mut v8::ContextScope::new(handle_scope, context);

        let event_loop = EventLoop::new();
        builtins::fetch::set_event_loop(event_loop.handle());
        builtins::timers::set_event_loop(event_loop.handle());
        builtins::fs::set_event_loop(event_loop.handle());
        builtins::exec::set_event_loop(event_loop.handle());

        builtins::setup(scope, context);

        // Check if the source uses ES module syntax
        if modules::is_module_source(source) {
            // Execute as ES module
            let tc_scope = &mut v8::TryCatch::new(scope);

            match modules::execute_module(tc_scope, filename, source) {
                Ok(_) => {}
                Err(e) => {
                    // Check if there's a V8 exception
                    if tc_scope.has_caught() {
                        return Err(format_exception(tc_scope, filename, source));
                    }
                    return Err(colors::error(&e));
                }
            }

            event_loop.run(tc_scope);
        } else {
            // Execute as classic script (wrapped in async IIFE)
            let js_source = if transpiler::is_typescript(filename) {
                transpiler::transpile_typescript(source, filename)?
            } else {
                source.to_string()
            };

            let wrapped_source = wrap_async(&js_source);
            let code =
                v8::String::new(scope, &wrapped_source).ok_or("Failed to create source string")?;
            let name = v8::String::new(scope, filename).unwrap();

            let origin = v8::ScriptOrigin::new(
                scope,
                name.into(),
                0,
                0,
                false,
                0,
                name.into(),
                false,
                false,
                false,
            );

            let tc_scope = &mut v8::TryCatch::new(scope);

            let script = match v8::Script::compile(tc_scope, code, Some(&origin)) {
                Some(script) => script,
                None => return Err(format_exception(tc_scope, filename, source)),
            };

            match script.run(tc_scope) {
                Some(_) => {}
                None => return Err(format_exception(tc_scope, filename, source)),
            }

            event_loop.run(tc_scope);
        }

        Ok(String::new())
    }
}

fn wrap_async(source: &str) -> String {
    format!(
        "(async () => {{\n{}\n}})().catch(e => console.error(e.stack || e.message || e));",
        source
    )
}

fn format_exception(
    tc_scope: &mut v8::TryCatch<v8::HandleScope>,
    filename: &str,
    source: &str,
) -> String {
    let Some(exception) = tc_scope.exception() else {
        return colors::error("unknown error");
    };

    let message = exception
        .to_string(tc_scope)
        .map(|m| m.to_rust_string_lossy(tc_scope))
        .unwrap_or_else(|| "unknown error".to_string());

    let (line, col) = tc_scope
        .message()
        .map(|m| {
            (
                m.get_line_number(tc_scope).unwrap_or(1),
                m.get_start_column() + 1,
            )
        })
        .unwrap_or((1, 1));

    let adjusted_line = if line > 1 { line - 1 } else { 1 };

    let location = colors::location(filename, adjusted_line, col);
    let source_line = source.lines().nth(adjusted_line - 1).unwrap_or("");
    let pointer = format!(
        "{}{}^{}",
        " ".repeat(col.saturating_sub(1)),
        colors::RED,
        colors::RESET
    );

    format!(
        "{}\n\n  {}{}{}\n  {}\n\n{}",
        colors::error(&message),
        colors::DIM,
        source_line,
        colors::RESET,
        pointer,
        location
    )
}

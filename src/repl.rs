use crate::builtins;
use crate::colors;
use crate::event_loop::EventLoop;
use crate::transpiler;
use rusty_v8 as v8;
use rustyline::error::ReadlineError;
use rustyline::history::DefaultHistory;
use rustyline::{Editor, Result as RlResult};
use std::sync::Once;

static V8_INIT: Once = Once::new();

pub fn run() {
    V8_INIT.call_once(|| {
        let platform = v8::new_default_platform(0, false).make_shared();
        v8::V8::initialize_platform(platform);
        v8::V8::initialize();
    });

    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    let handle_scope = &mut v8::HandleScope::new(isolate);
    let context = v8::Context::new(handle_scope);
    let scope = &mut v8::ContextScope::new(handle_scope, context);

    let event_loop = EventLoop::new();
    builtins::fetch::set_event_loop(event_loop.handle());
    builtins::timers::set_event_loop(event_loop.handle());
    builtins::fs::set_event_loop(event_loop.handle());
    builtins::exec::set_event_loop(event_loop.handle());
    builtins::setup(scope, context);

    println!(
        "{}Velox REPL{} - JavaScript/TypeScript Runtime",
        colors::BOLD,
        colors::RESET
    );
    println!(
        "Type {}.help{} for commands, {}.exit{} or Ctrl+C to quit\n",
        colors::DIM,
        colors::RESET,
        colors::DIM,
        colors::RESET
    );

    if let Err(e) = run_repl(scope, &event_loop) {
        eprintln!("{}", colors::error(&format!("REPL error: {}", e)));
    }

    println!("\nGoodbye!");
}

fn run_repl(scope: &mut v8::ContextScope<v8::HandleScope>, event_loop: &EventLoop) -> RlResult<()> {
    let mut rl: Editor<(), DefaultHistory> = Editor::new()?;

    // Try to load history from file
    let history_path = dirs_next().map(|p| p.join(".velox_history"));
    if let Some(ref path) = history_path {
        let _ = rl.load_history(path);
    }

    let mut input_buffer = String::new();
    let mut in_multiline = false;
    let mut typescript_mode = false;
    let mut line_number = 1;

    loop {
        let prompt = if in_multiline {
            "... ".to_string()
        } else {
            let mode = if typescript_mode { "ts" } else { "js" };
            format!("[{}] > ", mode)
        };

        match rl.readline(&prompt) {
            Ok(line) => {
                let line = line.trim_end();

                // Handle special commands (only when not in multiline mode)
                if !in_multiline {
                    match line {
                        ".exit" | ".quit" => break,
                        ".help" => {
                            print_help();
                            continue;
                        }
                        ".clear" => {
                            input_buffer.clear();
                            println!("Buffer cleared");
                            continue;
                        }
                        ".ts" => {
                            typescript_mode = true;
                            println!("TypeScript mode {}enabled{}", colors::GREEN, colors::RESET);
                            continue;
                        }
                        ".js" => {
                            typescript_mode = false;
                            println!("JavaScript mode {}enabled{}", colors::GREEN, colors::RESET);
                            continue;
                        }
                        "" => continue,
                        _ => {}
                    }
                }

                input_buffer.push_str(line);
                input_buffer.push('\n');

                // Check if we need more input
                if needs_more_input(&input_buffer) {
                    in_multiline = true;
                    continue;
                }

                in_multiline = false;
                let source = input_buffer.trim().to_string();
                input_buffer.clear();

                if source.is_empty() {
                    continue;
                }

                // Add to history
                let _ = rl.add_history_entry(&source);

                // Transpile TypeScript if needed
                let js_source = if typescript_mode {
                    match transpiler::transpile_typescript(&source, "<repl>.ts") {
                        Ok(code) => code,
                        Err(e) => {
                            eprintln!("{}", colors::error(&e));
                            continue;
                        }
                    }
                } else {
                    source.clone()
                };

                // Evaluate the input
                let result = eval_repl(scope, &js_source, line_number);
                line_number += source.lines().count();

                match result {
                    Ok(Some(output)) => {
                        println!("{}{}{}", colors::DIM, output, colors::RESET);
                    }
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("{}", colors::error(&e));
                    }
                }

                // Run event loop to handle any pending async operations
                event_loop.run(scope);
            }
            Err(ReadlineError::Interrupted) => {
                // Ctrl+C - clear current input
                if in_multiline {
                    input_buffer.clear();
                    in_multiline = false;
                    println!("^C");
                } else {
                    println!("^C (use .exit to quit)");
                }
            }
            Err(ReadlineError::Eof) => {
                // Ctrl+D
                break;
            }
            Err(err) => {
                eprintln!("{}", colors::error(&format!("readline error: {}", err)));
                break;
            }
        }
    }

    // Save history
    if let Some(ref path) = history_path {
        let _ = rl.save_history(path);
    }

    Ok(())
}

fn dirs_next() -> Option<std::path::PathBuf> {
    std::env::var_os("HOME").map(std::path::PathBuf::from)
}

fn eval_repl(
    scope: &mut v8::ContextScope<v8::HandleScope>,
    source: &str,
    line_offset: usize,
) -> Result<Option<String>, String> {
    let code = v8::String::new(scope, source).ok_or("Failed to create source string")?;
    let name = v8::String::new(scope, "<repl>").unwrap();

    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        line_offset as i32,
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
        None => return Err(format_exception(tc_scope)),
    };

    match script.run(tc_scope) {
        Some(result) => {
            // Handle promises - show their current state
            if result.is_promise() {
                let promise = v8::Local::<v8::Promise>::try_from(result).unwrap();
                match promise.state() {
                    v8::PromiseState::Fulfilled => {
                        let value = promise.result(tc_scope);
                        if value.is_undefined() {
                            Ok(None)
                        } else {
                            Ok(Some(stringify_value(tc_scope, value)))
                        }
                    }
                    v8::PromiseState::Rejected => {
                        let value = promise.result(tc_scope);
                        Err(value.to_rust_string_lossy(tc_scope))
                    }
                    v8::PromiseState::Pending => Ok(Some("Promise { <pending> }".to_string())),
                }
            } else if result.is_undefined() {
                Ok(None)
            } else {
                Ok(Some(stringify_value(tc_scope, result)))
            }
        }
        None => Err(format_exception(tc_scope)),
    }
}

fn stringify_value(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> String {
    if value.is_string() {
        let s = value.to_rust_string_lossy(scope);
        return format!("'{}'", s);
    }

    if value.is_function() {
        return "[Function]".to_string();
    }

    if value.is_null() {
        return "null".to_string();
    }

    if value.is_symbol() {
        return value.to_rust_string_lossy(scope);
    }

    if value.is_object() || value.is_array() {
        let global = scope.get_current_context().global(scope);
        let json_key = v8::String::new(scope, "JSON").unwrap();
        let stringify_key = v8::String::new(scope, "stringify").unwrap();

        if let Some(json) = global.get(scope, json_key.into()) {
            if let Some(json_obj) = json.to_object(scope) {
                if let Some(stringify) = json_obj.get(scope, stringify_key.into()) {
                    if let Ok(func) = v8::Local::<v8::Function>::try_from(stringify) {
                        let null = v8::null(scope);
                        let indent = v8::Integer::new(scope, 2);
                        if let Some(result) =
                            func.call(scope, json.into(), &[value, null.into(), indent.into()])
                        {
                            if !result.is_undefined() {
                                return result.to_rust_string_lossy(scope);
                            }
                        }
                    }
                }
            }
        }
        // If JSON.stringify fails (e.g., circular reference), fall back to toString
        return value.to_rust_string_lossy(scope);
    }

    value.to_rust_string_lossy(scope)
}

fn format_exception(tc_scope: &mut v8::TryCatch<v8::HandleScope>) -> String {
    tc_scope
        .exception()
        .map(|e| {
            e.to_string(tc_scope)
                .map(|m| m.to_rust_string_lossy(tc_scope))
        })
        .flatten()
        .unwrap_or_else(|| "Unknown error".to_string())
}

fn needs_more_input(input: &str) -> bool {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut string_char = ' ';
    let mut escape_next = false;
    let mut in_template_literal = false;

    for c in input.chars() {
        if escape_next {
            escape_next = false;
            continue;
        }

        if c == '\\' && in_string {
            escape_next = true;
            continue;
        }

        if !in_string && !in_template_literal {
            match c {
                '"' | '\'' => {
                    in_string = true;
                    string_char = c;
                }
                '`' => {
                    in_template_literal = true;
                }
                '{' | '(' | '[' => depth += 1,
                '}' | ')' | ']' => depth -= 1,
                _ => {}
            }
        } else if in_string && c == string_char {
            in_string = false;
        } else if in_template_literal && c == '`' {
            in_template_literal = false;
        }
    }

    depth > 0 || in_string || in_template_literal
}

fn print_help() {
    println!("\n{}REPL Commands:{}", colors::BOLD, colors::RESET);
    println!("  {}.exit{}   - Exit the REPL", colors::CYAN, colors::RESET);
    println!(
        "  {}.clear{}  - Clear the input buffer",
        colors::CYAN,
        colors::RESET
    );
    println!(
        "  {}.help{}   - Show this help message",
        colors::CYAN,
        colors::RESET
    );
    println!(
        "  {}.ts{}     - Enable TypeScript mode",
        colors::CYAN,
        colors::RESET
    );
    println!(
        "  {}.js{}     - Enable JavaScript mode (default)",
        colors::CYAN,
        colors::RESET
    );
    println!("\n{}Features:{}", colors::BOLD, colors::RESET);
    println!("  - Arrow keys for navigation and history");
    println!("  - Multi-line input with automatic bracket detection");
    println!("  - Async/await support (event loop runs after each command)");
    println!("  - TypeScript transpilation with .ts mode");
    println!("  - Command history saved to ~/.velox_history");
    println!();
}

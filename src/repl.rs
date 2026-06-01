//! Interactive read-eval-print loop.

use std::path::Path;

use owo_colors::OwoColorize;
use rustyline::DefaultEditor;
use rustyline::error::ReadlineError;

use crate::runtime::Runtime;
use crate::transpile::{has_top_level_await, is_await_expression, transpile};
use crate::ui;

pub fn start() {
    ui::banner();

    let runtime = Runtime::new();
    let mut editor = match DefaultEditor::new() {
        Ok(editor) => editor,
        Err(error) => {
            eprintln!("failed to start REPL: {error}");
            return;
        }
    };

    // Each entry is transpiled as standalone TypeScript.
    let origin = Path::new("repl.ts");

    loop {
        match editor.readline(&ui::prompt()) {
            Ok(line) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let _ = editor.add_history_entry(trimmed);

                match trimmed {
                    ".exit" | ".quit" => break,
                    ".help" => {
                        ui::repl_help();
                        continue;
                    }
                    ".clear" => {
                        print!("\x1b[2J\x1b[H");
                        continue;
                    }
                    _ => {}
                }

                // Top-level `await` lines are wrapped in an async IIFE and the
                // event loop drained until they settle. A bare expression's
                // resolved value is displayed; a declaration is rewritten so it
                // persists across entries (like `var` does).
                if has_top_level_await(&line) {
                    eval_await(&runtime, origin, &line);
                    continue;
                }

                let js = match transpile(origin, &line) {
                    Ok(js) => js,
                    Err(diagnostics) => {
                        ui::report_diagnostics("input", &diagnostics);
                        continue;
                    }
                };

                match runtime.eval(&js) {
                    Ok(outcome) => {
                        if let Some(display) = outcome.display {
                            println!("{} {}", "=>".dimmed(), display.bright_white());
                        }
                        // Drain any timers/promises scheduled by this entry.
                        runtime.run_event_loop();
                    }
                    Err(error) => ui::report_runtime_error(&error),
                }
            }
            Err(ReadlineError::Interrupted) => continue, // Ctrl-C clears the line
            Err(ReadlineError::Eof) => break,            // Ctrl-D exits
            Err(error) => {
                eprintln!("input error: {error}");
                break;
            }
        }
    }

    println!("{}", "bye 👋".dimmed());
}

/// Evaluate a top-level-await line: run it inside an async IIFE that stashes its
/// resolved value (or rejection) on globals, drain the event loop so the promise
/// settles, then fetch and display the result.
fn eval_await(runtime: &Runtime, origin: &Path, line: &str) {
    let trimmed = line.trim().trim_end_matches(';');
    // A bare expression captures its value for display; a statement/declaration
    // runs for effect, with a leading `const`/`let`/`var` rebound to a global so
    // the binding persists between REPL entries.
    let body = if is_await_expression(line) {
        format!("globalThis.__rv = ({trimmed});")
    } else {
        format!("globalThis.__rv = undefined; {}", persist_declaration(line))
    };
    let wrapper = format!(
        "globalThis.__re = undefined; globalThis.__rv = undefined; \
         (async function () {{ {body} }})()\
           .then(function () {{}}, function (e) {{ globalThis.__re = e; }});"
    );
    let js = match transpile(origin, &wrapper) {
        Ok(js) => js,
        Err(diagnostics) => {
            ui::report_diagnostics("input", &diagnostics);
            return;
        }
    };
    if let Err(error) = runtime.eval(&js) {
        ui::report_runtime_error(&error);
        return;
    }
    runtime.run_event_loop();

    // Re-throw a rejection as an error, else return the resolved value (clearing
    // the temporaries so they don't leak between entries).
    const FETCH: &str = "(function () { \
        if (globalThis.__re !== undefined) { var e = globalThis.__re; globalThis.__re = undefined; throw e; } \
        var v = globalThis.__rv; globalThis.__rv = undefined; return v; })()";
    match runtime.eval(FETCH) {
        Ok(outcome) => {
            if let Some(display) = outcome.display {
                println!("{} {}", "=>".dimmed(), display.bright_white());
            }
        }
        Err(error) => ui::report_runtime_error(&error),
    }
}

/// Rebind a leading `const`/`let`/`var NAME =` to `globalThis.NAME =` so a
/// top-level-await declaration persists across REPL entries (an async IIFE would
/// otherwise scope it away). Non-simple forms (destructuring, multiple bindings)
/// are left as-is.
fn persist_declaration(line: &str) -> String {
    let t = line.trim_start();
    for kw in ["const ", "let ", "var "] {
        if let Some(rest) = t.strip_prefix(kw)
            && let Some(eq) = rest.find('=')
        {
            let name = rest[..eq].trim();
            if !name.is_empty()
                && name
                    .chars()
                    .all(|c| c.is_alphanumeric() || c == '_' || c == '$')
            {
                return format!("globalThis.{name} ={}", &rest[eq + 1..]);
            }
        }
    }
    line.to_string()
}

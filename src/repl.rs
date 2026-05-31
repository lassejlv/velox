//! Interactive read-eval-print loop.

use std::path::Path;

use owo_colors::OwoColorize;
use rustyline::DefaultEditor;
use rustyline::error::ReadlineError;

use crate::runtime::Runtime;
use crate::transpile::transpile;
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

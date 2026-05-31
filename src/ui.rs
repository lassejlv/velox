//! Terminal presentation: banner, prompts, and error rendering.

use owo_colors::OwoColorize;
use oxc::diagnostics::OxcDiagnostic;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Splash shown when the REPL starts.
pub fn banner() {
    let logo = r#"
┌───────────────────────────────────┐
│   ╦  ╦┌─┐┬  ┌─┐─┐ ┬                │
│   ╚╗╔╝├┤ │  │ │┌┴┬┘                │
│    ╚╝ └─┘┴─┘└─┘┴ └─                │
└───────────────────────────────────┘"#;
    println!("{}", logo.cyan().bold());
    println!(
        "  {} {}  ·  {} on JavaScriptCore",
        "velox".bright_white().bold(),
        format!("v{VERSION}").dimmed(),
        "TypeScript".cyan(),
    );
    println!("  {}\n", "type .help for commands, .exit to quit".dimmed());
}

/// Commands available inside the REPL.
pub fn repl_help() {
    let rows = [
        (".help", "show this help"),
        (".clear", "clear the screen"),
        (".exit", "quit the REPL (or press Ctrl-D)"),
    ];
    for (cmd, desc) in rows {
        println!("  {:<8} {}", cmd.green().bold(), desc.dimmed());
    }
}

/// The REPL prompt string (ANSI-colored).
pub fn prompt() -> String {
    format!("{} ", "velox›".green().bold())
}

/// Render a transpiler/parse failure.
pub fn report_diagnostics(origin: &str, diagnostics: &[OxcDiagnostic]) {
    eprintln!(
        "{} {} in {}",
        "✖".red().bold(),
        pluralize(diagnostics.len(), "error", "errors"),
        origin.bold(),
    );
    for diagnostic in diagnostics {
        for (i, line) in format!("{diagnostic}").lines().enumerate() {
            let marker = if i == 0 { "›" } else { " " };
            eprintln!("  {} {}", marker.red(), line.red());
        }
    }
}

/// Render an uncaught JavaScript exception.
pub fn report_runtime_error(message: &str) {
    let mut lines = message.lines();
    if let Some(first) = lines.next() {
        eprintln!("{} {}", "✖ Uncaught".red().bold(), first.bright_red());
    }
    for line in lines {
        eprintln!("    {}", line.dimmed());
    }
}

/// Render a module-resolution / bundling failure.
pub fn report_module_error(message: &str) {
    let mut lines = message.lines();
    if let Some(first) = lines.next() {
        eprintln!("{} {}", "✖".red().bold(), first.red());
    }
    for line in lines {
        eprintln!("  {}", line.red());
    }
}

fn pluralize(n: usize, singular: &str, plural: &str) -> String {
    if n == 1 {
        format!("{n} {singular}")
    } else {
        format!("{n} {plural}")
    }
}

//! Terminal presentation: banner, prompts, and error rendering.

use owo_colors::{OwoColorize, Stream::Stdout, Style};
use oxc::diagnostics::OxcDiagnostic;

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The home screen shown by a bare `velox` (and `velox help`): logo, grouped
/// commands, common flags, and a few copy-pasteable examples. Colors are applied
/// only when stdout is a TTY that supports them (honors `NO_COLOR`).
pub fn about() {
    let logo = r#"  ╦  ╦┌─┐┬  ┌─┐─┐ ┬
  ╚╗╔╝├┤ │  │ │┌┴┬┘
   ╚╝ └─┘┴─┘└─┘┴ └─"#;
    let cyan_bold = Style::new().cyan().bold();
    let cmd_style = Style::new().green().bold();
    println!("{}", logo.if_supports_color(Stdout, |t| t.style(cyan_bold)));
    println!(
        "  {} {}  A fast TypeScript & JavaScript runtime on JavaScriptCore\n",
        "velox".if_supports_color(Stdout, |t| t.style(Style::new().bright_white().bold())),
        format!("v{VERSION}").if_supports_color(Stdout, |t| t.dimmed()),
    );
    println!(
        "  {} velox {} {}\n",
        "Usage:".if_supports_color(Stdout, |t| t.bold()),
        "<command>".if_supports_color(Stdout, |t| t.cyan()),
        "[...flags] [...args]".if_supports_color(Stdout, |t| t.dimmed()),
    );

    let section = |title: &str, rows: &[(&str, &str)]| {
        println!("  {}", title.if_supports_color(Stdout, |t| t.bold()));
        for (cmd, desc) in rows {
            println!(
                "    {:<24} {}",
                cmd.if_supports_color(Stdout, |t| t.style(cmd_style)),
                desc.if_supports_color(Stdout, |t| t.dimmed()),
            );
        }
        println!();
    };

    section(
        "Run",
        &[
            ("velox <file>", "run a .ts / .tsx / .js / .jsx file"),
            ("velox run <script>", "run a package.json script"),
            ("velox repl", "start the interactive REPL"),
            ("velox -e <code>", "evaluate a snippet and exit"),
        ],
    );
    section(
        "Package management",
        &[
            ("velox install", "install dependencies from package.json"),
            ("velox add <pkg>...", "add packages and install them"),
            ("velox remove <pkg>...", "remove packages"),
            ("velox update", "upgrade dependencies in range"),
            ("velox outdated", "list dependencies with newer versions"),
            ("velox x <pkg> [args]", "run a package executable (npx-style)"),
        ],
    );
    section(
        "Project",
        &[
            ("velox init [dir]", "scaffold a new velox project"),
            ("velox test [pattern]", "run tests (describe / it / expect)"),
            ("velox bench [pattern]", "run benchmarks"),
            ("velox build <entry>", "compile to a standalone executable"),
        ],
    );
    section(
        "Flags",
        &[
            ("-w, --watch", "re-run on file changes"),
            (
                "--env-file <path>",
                "load environment variables before running",
            ),
            ("-v, --version", "print the version"),
            ("-h, --help", "print help for any command"),
        ],
    );

    println!("  {}", "Examples".if_supports_color(Stdout, |t| t.bold()));
    for ex in [
        "velox run dev",
        "velox add hono zod",
        "velox x drizzle-kit generate",
        "velox build src/main.ts",
    ] {
        println!(
            "    {} {}",
            "$".if_supports_color(Stdout, |t| t.dimmed()),
            ex.if_supports_color(Stdout, |t| t.cyan()),
        );
    }
    println!(
        "\n  {}\n",
        "Run `velox <command> --help` for more on a command."
            .if_supports_color(Stdout, |t| t.dimmed()),
    );
}

/// Splash shown when the REPL starts. Shares the home-screen logo so the brand
/// is consistent between `velox` and `velox repl`.
pub fn banner() {
    let logo = r#"  ╦  ╦┌─┐┬  ┌─┐─┐ ┬
  ╚╗╔╝├┤ │  │ │┌┴┬┘
   ╚╝ └─┘┴─┘└─┘┴ └─"#;
    println!("{}", logo.if_supports_color(Stdout, |t| t.style(Style::new().cyan().bold())));
    println!(
        "  {} {}  ·  {} REPL on JavaScriptCore",
        "velox".if_supports_color(Stdout, |t| t.style(Style::new().bright_white().bold())),
        format!("v{VERSION}").if_supports_color(Stdout, |t| t.dimmed()),
        "TypeScript".if_supports_color(Stdout, |t| t.cyan()),
    );
    println!(
        "  {}\n",
        "top-level await ready · .help for commands · .exit or Ctrl-D to quit"
            .if_supports_color(Stdout, |t| t.dimmed()),
    );
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

/// A bareword that's a near-miss for a subcommand (`velox buld`) — show the
/// likely intended command rather than a cryptic file-not-found.
pub fn report_unknown_command(input: &str, suggestion: &str) {
    eprintln!(
        "{} no such file or command {}",
        "✖".if_supports_color(Stdout, |t| t.style(Style::new().red().bold())),
        format!("`{input}`").if_supports_color(Stdout, |t| t.bold()),
    );
    eprintln!(
        "  did you mean {}?",
        format!("velox {suggestion}").if_supports_color(Stdout, |t| t.style(Style::new().green().bold())),
    );
    eprintln!(
        "  run {} to see all commands",
        "velox help".if_supports_color(Stdout, |t| t.cyan()),
    );
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

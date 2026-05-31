//! velox — a tiny TypeScript/JavaScript runtime built on Apple's
//! JavaScriptCore, transpiling with oxc and bundling relative ES modules.

mod crypto;
mod event_loop;
mod fetch;
mod init;
mod inspect;
mod module;
mod node;
mod pkg;
mod repl;
mod runtime;
mod server;
mod shared;
mod sys;
mod transpile;
mod udp;
mod ui;
mod vm;
mod worker;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::Parser;

use crate::runtime::Runtime;

#[derive(Parser)]
#[command(
    name = "velox",
    version,
    about = "A tiny TypeScript/JavaScript runtime on JavaScriptCore",
    after_help = "Commands:\n  init [DIR]              Scaffold a new velox project\n  install                Install dependencies from package.json\n  add [--dev] <pkg>...   Add packages and install them\n  remove <pkg>...        Remove packages\n  run [script]           Run a package.json script\n\nRun `velox <command> --help` for details."
)]
struct Cli {
    /// Script to run (.ts/.tsx/.js/.jsx). Omit to start the REPL.
    file: Option<PathBuf>,

    /// Evaluate the given TypeScript/JavaScript string and exit.
    #[arg(short = 'e', long = "eval", value_name = "CODE")]
    eval: Option<String>,

    /// Load environment variables from a `.env` file before running.
    #[arg(long = "env-file", value_name = "PATH")]
    env_file: Option<PathBuf>,

    /// Re-run the script whenever it (or one of its imports) changes.
    #[arg(short = 'w', long = "watch")]
    watch: bool,
}

fn main() -> ExitCode {
    // Subcommands (init / install / add / remove) are handled before clap so
    // they don't collide with the positional `file` arg — `velox script.ts`
    // keeps working unchanged.
    let raw: Vec<String> = std::env::args().collect();
    if let Some(code) = dispatch_subcommand(&raw) {
        return code;
    }

    let cli = Cli::parse();
    if let Some(path) = &cli.env_file {
        load_env_file(path);
    }
    if let Some(code) = cli.eval {
        return run_source(&code, "[eval].ts");
    }
    match cli.file {
        Some(path) if cli.watch => watch_loop(&path),
        Some(path) => run_file(&path),
        None => {
            repl::start();
            ExitCode::SUCCESS
        }
    }
}

/// Handle the project/package subcommands (`init`, `install`, `add`, `remove`).
/// Returns `Some(code)` when a subcommand ran, or `None` to fall through to the
/// normal run-a-file / REPL path.
fn dispatch_subcommand(raw: &[String]) -> Option<ExitCode> {
    let cmd = raw.get(1).map(String::as_str)?;
    let rest = &raw[raw.len().min(2)..];
    let has_help = rest.iter().any(|a| a == "-h" || a == "--help");
    let positionals = || {
        rest.iter()
            .filter(|a| !a.starts_with('-'))
            .cloned()
            .collect::<Vec<_>>()
    };

    match cmd {
        "init" => {
            if has_help {
                println!("Usage: velox init [DIR]\n\n  Scaffold a new velox project in DIR (default: current directory).\n\nOptions:\n  --no-install   Skip installing @types/node.");
                return Some(ExitCode::SUCCESS);
            }
            let no_install = rest.iter().any(|a| a == "--no-install");
            let dir = positionals().into_iter().next();
            Some(init::run(dir.as_deref(), no_install))
        }
        "install" | "i" => {
            if has_help {
                println!("Usage: velox install\n\n  Install all dependencies from package.json into node_modules.");
                return Some(ExitCode::SUCCESS);
            }
            // `velox install <pkg>` is an alias for `add` (npm-compatible).
            let pkgs = positionals();
            if pkgs.is_empty() {
                Some(pkg::install())
            } else {
                let dev = rest.iter().any(|a| a == "--dev" || a == "-D" || a == "--save-dev");
                Some(pkg::add(&pkgs, dev))
            }
        }
        "add" | "a" => {
            if has_help {
                println!("Usage: velox add [--dev] <pkg>[@version]...\n\n  Add packages to package.json and install them.\n\nOptions:\n  -D, --dev   Save to devDependencies.");
                return Some(ExitCode::SUCCESS);
            }
            let dev = rest.iter().any(|a| a == "--dev" || a == "-D" || a == "--save-dev");
            Some(pkg::add(&positionals(), dev))
        }
        "remove" | "rm" | "uninstall" | "un" => {
            if has_help {
                println!("Usage: velox remove <pkg>...\n\n  Remove packages from package.json and node_modules.");
                return Some(ExitCode::SUCCESS);
            }
            Some(pkg::remove(&positionals()))
        }
        "run" | "run-script" => {
            if has_help {
                println!("Usage: velox run [SCRIPT] [-- args...]\n\n  Run a package.json script (no SCRIPT lists them). pre/post hooks run too.");
                return Some(ExitCode::SUCCESS);
            }
            // First token after `run` is the script name; the remainder (minus a
            // leading `--`) is passed through to the script verbatim.
            let name = rest.first().filter(|a| !a.starts_with('-'));
            let extra: Vec<String> = match name {
                Some(_) => {
                    let after = &rest[1..];
                    let after = match after.first() {
                        Some(sep) if sep == "--" => &after[1..],
                        _ => after,
                    };
                    after.to_vec()
                }
                None => Vec::new(),
            };
            Some(pkg::run_script(name.map(String::as_str), &extra))
        }
        _ => None,
    }
}

/// Parse a `.env` file and set each `KEY=VALUE` into the process environment
/// (so `process.env` picks them up). Supports `#` comments, `export` prefixes,
/// blank lines, and single/double-quoted values.
fn load_env_file(path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        ui::report_runtime_error(&format!("--env-file: cannot read {}", path.display()));
        return;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let mut value = value.trim();
        // Strip matching surrounding quotes.
        if (value.starts_with('"') && value.ends_with('"') && value.len() >= 2)
            || (value.starts_with('\'') && value.ends_with('\'') && value.len() >= 2)
        {
            value = &value[1..value.len() - 1];
        }
        if !key.is_empty() {
            unsafe { std::env::set_var(key, value) };
        }
    }
}

/// `--watch`: run the script, then re-run whenever any bundled source file's
/// modification time changes. Polls (kqueue file watching isn't wired for this
/// top-level loop); cheap for the handful of files a bundle touches.
fn watch_loop(path: &Path) -> ExitCode {
    use std::collections::HashMap;
    use std::time::{Duration, SystemTime};

    fn mtimes(files: &[PathBuf]) -> HashMap<PathBuf, SystemTime> {
        files
            .iter()
            .filter_map(|f| {
                std::fs::metadata(f)
                    .and_then(|m| m.modified())
                    .ok()
                    .map(|t| (f.clone(), t))
            })
            .collect()
    }

    loop {
        print!("\x1b[2J\x1b[H"); // clear screen
        eprintln!("\x1b[2m[velox] running {} (watch)\x1b[0m", path.display());
        // Determine the files to watch from the bundle graph; fall back to the
        // entry alone if bundling failed.
        let watched = match module::bundle_with_deps(path) {
            Ok((_, deps)) => deps,
            Err(_) => vec![path.to_path_buf()],
        };
        let _ = run_file(path);
        let mut snapshot = mtimes(&watched);
        eprintln!(
            "\x1b[2m[velox] watching {} file(s); Ctrl-C to exit\x1b[0m",
            snapshot.len()
        );
        // Poll for changes.
        loop {
            std::thread::sleep(Duration::from_millis(150));
            let current = mtimes(&watched);
            if current != snapshot {
                snapshot = current;
                break; // re-run
            }
        }
    }
}

/// Run a source string (from `--eval`) through the full pipeline. Staged as a
/// hidden file in the current dir (PID-unique) so relative imports resolve
/// against the cwd, like `node -e`; cleaned up afterward.
fn run_source(code: &str, _label: &str) -> ExitCode {
    let name = format!(".velox-eval-{}.ts", std::process::id());
    let path = std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(name);
    if let Err(e) = std::fs::write(&path, code) {
        ui::report_runtime_error(&format!("failed to stage eval source: {e}"));
        return ExitCode::FAILURE;
    }
    let result = run_file(&path);
    let _ = std::fs::remove_file(&path);
    result
}

fn run_file(path: &Path) -> ExitCode {
    // Resolve + transpile + bundle the entry and its relative imports into a
    // single script (JSC's evaluator does not accept ESM syntax directly).
    let js = match module::bundle(path) {
        Ok(js) => js,
        Err(error) => {
            ui::report_module_error(&error.to_string());
            return ExitCode::FAILURE;
        }
    };

    let runtime = Runtime::new();
    match runtime.eval(&js) {
        Ok(_) => {
            // Run queued timers/promises to completion.
            if runtime.run_event_loop() {
                ExitCode::FAILURE
            } else {
                // Honor `process.exitCode` set by the script.
                ExitCode::from(runtime.exit_code() as u8)
            }
        }
        Err(error) => {
            ui::report_runtime_error(&error);
            ExitCode::FAILURE
        }
    }
}

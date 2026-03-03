mod builtins;
mod colors;
mod event_loop;
mod repl;
mod runtime;
mod transpiler;

use runtime::Runtime;
use std::env;
use std::fs;
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        // No arguments - start REPL
        repl::run();
        return;
    }

    match args[1].as_str() {
        "run" => {
            if args.len() < 3 {
                eprintln!("{}", colors::error("missing file argument"));
                print_usage(&args[0]);
                process::exit(1);
            }
            // Collect script arguments (everything after the script path)
            let script_args: Vec<String> = args[3..].to_vec();
            run_file(&args[2], script_args);
        }
        "repl" => {
            repl::run();
        }
        _ => {
            eprintln!(
                "{}",
                colors::error(&format!("unknown command '{}'", args[1]))
            );
            print_usage(&args[0]);
            process::exit(1);
        }
    }
}

fn print_usage(program: &str) {
    eprintln!(
        "\n{}Usage:{} {} <command> [args]",
        colors::BOLD,
        colors::RESET,
        program
    );
    eprintln!("\n{}Commands:{}", colors::BOLD, colors::RESET);
    eprintln!("  run <file>    Run a JavaScript/TypeScript file");
    eprintln!("  repl          Start interactive REPL");
    eprintln!("\nRun with no arguments to start REPL");
}

fn run_file(path: &str, script_args: Vec<String>) {
    let source = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) => {
            eprintln!(
                "{}",
                colors::error(&format!("cannot read '{}': {}", path, e))
            );
            process::exit(1);
        }
    };

    // Get exec path and set args for Velox.args/Velox.execPath
    let exec_path = env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| String::from("velox"));
    builtins::process::set_args(exec_path, script_args);

    let mut runtime = Runtime::new();

    if let Err(e) = runtime.execute(path, &source) {
        eprintln!("{}", e);
        process::exit(1);
    }
}

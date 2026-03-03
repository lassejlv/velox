mod builtins;
mod colors;
mod event_loop;
mod modules;
mod repl;
mod runtime;
mod transpiler;

use runtime::Runtime;
use std::env;
use std::fs;
use std::path::Path;
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

            // Parse flags and collect script arguments
            let mut import_map_path: Option<String> = None;
            let mut script_path: Option<String> = None;
            let mut script_args: Vec<String> = Vec::new();
            let mut i = 2;

            while i < args.len() {
                if args[i] == "--import-map" && i + 1 < args.len() {
                    import_map_path = Some(args[i + 1].clone());
                    i += 2;
                } else if script_path.is_none() {
                    script_path = Some(args[i].clone());
                    i += 1;
                } else {
                    script_args.push(args[i].clone());
                    i += 1;
                }
            }

            let script_path = match script_path {
                Some(p) => p,
                None => {
                    eprintln!("{}", colors::error("missing file argument"));
                    print_usage(&args[0]);
                    process::exit(1);
                }
            };

            run_file(&script_path, script_args, import_map_path);
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
        "\n{}Usage:{} {} <command> [options] [args]",
        colors::BOLD,
        colors::RESET,
        program
    );
    eprintln!("\n{}Commands:{}", colors::BOLD, colors::RESET);
    eprintln!("  run <file>    Run a JavaScript/TypeScript file");
    eprintln!("  repl          Start interactive REPL");
    eprintln!("\n{}Options:{}", colors::BOLD, colors::RESET);
    eprintln!("  --import-map <file>    Load import map from JSON file");
    eprintln!("\nRun with no arguments to start REPL");
}

fn run_file(path: &str, script_args: Vec<String>, import_map_path: Option<String>) {
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

    // Load import map if specified
    if let Some(map_path) = import_map_path {
        if let Err(e) = modules::load_import_map(Path::new(&map_path)) {
            eprintln!(
                "{}",
                colors::error(&format!("failed to load import map: {}", e))
            );
            process::exit(1);
        }
    } else {
        // Auto-detect import map (look for import_map.json or deno.json in cwd or script dir)
        let script_dir = Path::new(path).parent().unwrap_or(Path::new("."));
        for name in ["import_map.json", "importmap.json", "deno.json"] {
            let map_path = script_dir.join(name);
            if map_path.exists() {
                if let Err(e) = modules::load_import_map(&map_path) {
                    eprintln!(
                        "{}",
                        colors::error(&format!("warning: failed to load {}: {}", name, e))
                    );
                }
                break;
            }
        }
    }

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

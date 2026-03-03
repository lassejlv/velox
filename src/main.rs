mod builtins;
mod colors;
mod event_loop;
mod modules;
mod repl;
mod runtime;
mod transpiler;
mod watch;

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
            let mut watch_mode = false;
            let mut i = 2;

            while i < args.len() {
                match args[i].as_str() {
                    "--import-map" if i + 1 < args.len() => {
                        import_map_path = Some(args[i + 1].clone());
                        i += 2;
                    }
                    "--watch" | "-w" => {
                        watch_mode = true;
                        i += 1;
                    }
                    _ if script_path.is_none() => {
                        script_path = Some(args[i].clone());
                        i += 1;
                    }
                    _ => {
                        script_args.push(args[i].clone());
                        i += 1;
                    }
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

            if watch_mode {
                watch::run_watch(&script_path, script_args, import_map_path);
            } else {
                run_file(&script_path, script_args, import_map_path);
            }
        }
        "fmt" => {
            run_fmt(&args[2..]);
        }
        "check" => {
            run_check(&args[2..]);
        }
        "test" => {
            run_test(&args[2..]);
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
    eprintln!("  fmt [files]   Format source files");
    eprintln!("  check [files] Type-check source files");
    eprintln!("  test [files]  Run test files");
    eprintln!("  repl          Start interactive REPL");
    eprintln!("\n{}Options:{}", colors::BOLD, colors::RESET);
    eprintln!("  --watch, -w            Watch for file changes and re-run");
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

fn run_fmt(args: &[String]) {
    use crate::transpiler::format_file;

    if args.is_empty() {
        // Format all .ts/.js files in current directory
        format_directory(".");
    } else {
        for arg in args {
            let path = Path::new(arg);
            if path.is_dir() {
                format_directory(arg);
            } else if path.is_file() {
                if let Err(e) = format_file(arg) {
                    eprintln!(
                        "{}",
                        colors::error(&format!("Failed to format {}: {}", arg, e))
                    );
                } else {
                    println!("{}formatted{} {}", colors::GREEN, colors::RESET, arg);
                }
            }
        }
    }
}

fn format_directory(dir: &str) {
    use crate::transpiler::format_file;

    let walker = walkdir(dir);
    let mut count = 0;

    for entry in walker {
        let path = entry.to_string_lossy();
        if is_formattable(&path) {
            if let Err(e) = format_file(&path) {
                eprintln!(
                    "{}",
                    colors::error(&format!("Failed to format {}: {}", path, e))
                );
            } else {
                count += 1;
            }
        }
    }

    println!(
        "{}Formatted {} file(s){}",
        colors::GREEN,
        count,
        colors::RESET
    );
}

fn walkdir(dir: &str) -> Vec<std::path::PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                // Skip node_modules and hidden directories
                if !name.starts_with('.') && name != "node_modules" {
                    files.extend(walkdir(&path.to_string_lossy()));
                }
            } else if path.is_file() {
                files.push(path);
            }
        }
    }
    files
}

fn is_formattable(path: &str) -> bool {
    let extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
    extensions.iter().any(|ext| path.ends_with(ext))
}

fn run_check(args: &[String]) {
    // Type checking would require a full TypeScript type checker
    // For now, we just parse and report syntax errors
    use crate::transpiler::check_syntax;

    let files: Vec<String> = if args.is_empty() {
        walkdir(".")
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .filter(|p| is_formattable(p))
            .collect()
    } else {
        args.to_vec()
    };

    let mut errors = 0;

    for file in &files {
        if let Err(e) = check_syntax(file) {
            eprintln!("{}", e);
            errors += 1;
        }
    }

    if errors == 0 {
        println!(
            "{}No errors found in {} file(s){}",
            colors::GREEN,
            files.len(),
            colors::RESET
        );
    } else {
        eprintln!(
            "{}Found errors in {} file(s){}",
            colors::RED,
            errors,
            colors::RESET
        );
        process::exit(1);
    }
}

fn run_test(args: &[String]) {
    // Find test files and run them
    let test_files: Vec<String> = if args.is_empty() {
        walkdir(".")
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .filter(|p| is_test_file(p))
            .collect()
    } else {
        args.to_vec()
    };

    if test_files.is_empty() {
        println!("No test files found");
        return;
    }

    println!(
        "{}Running {} test file(s)...{}\n",
        colors::CYAN,
        test_files.len(),
        colors::RESET
    );

    let mut passed = 0;
    let mut failed = 0;

    for file in &test_files {
        println!("{}TEST{} {}", colors::CYAN, colors::RESET, file);

        // Clear module cache before each test (each test has its own isolate)
        modules::clear_cache();

        // Auto-detect import map for test file
        let script_dir = Path::new(file).parent().unwrap_or(Path::new("."));
        for name in ["import_map.json", "importmap.json", "deno.json"] {
            let map_path = script_dir.join(name);
            if map_path.exists() {
                let _ = modules::load_import_map(&map_path);
                break;
            }
        }

        let source = match fs::read_to_string(file) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("{}", colors::error(&format!("Cannot read {}: {}", file, e)));
                failed += 1;
                continue;
            }
        };

        let exec_path = env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| String::from("velox"));
        builtins::process::set_args(exec_path, vec![]);

        let mut runtime = Runtime::new();

        match runtime.execute(file, &source) {
            Ok(_) => {
                println!("  {}PASS{}\n", colors::GREEN, colors::RESET);
                passed += 1;
            }
            Err(e) => {
                eprintln!("  {}FAIL{}\n  {}\n", colors::RED, colors::RESET, e);
                failed += 1;
            }
        }
    }

    println!(
        "\n{}Results:{} {} passed, {} failed",
        colors::BOLD,
        colors::RESET,
        passed,
        failed
    );

    if failed > 0 {
        process::exit(1);
    }
}

fn is_test_file(path: &str) -> bool {
    let name = Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    (name.contains(".test.")
        || name.contains(".spec.")
        || name.contains("_test.")
        || name.starts_with("test_"))
        && is_formattable(path)
}

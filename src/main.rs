mod builtins;
mod colors;
mod event_loop;
mod modules;
mod permissions;
mod pkg;
mod repl;
mod runtime;
mod shutdown;
mod transpiler;
mod watch;

use runtime::Runtime;
use std::env;
use std::fs;
use std::path::Path;
use std::process;

fn main() {
    // Initialize graceful shutdown handler (Ctrl+C)
    shutdown::init();

    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        // No arguments - start REPL
        repl::run();
        return;
    }

    match args[1].as_str() {
        "run" => {
            run_target(&args[0], &args[2..]);
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
        "add" => {
            run_add(&args[2..]);
        }
        "install" => {
            run_install(&args[2..]);
        }
        "cache" => {
            run_cache(&args[2..]);
        }
        "x" => {
            run_x(&args[2..]);
        }
        "create" => {
            run_create(&args[2..]);
        }
        "snapshot" => {
            run_snapshot(&args[2..]);
        }
        "init" => {
            run_init(&args[2..]);
        }
        "repl" => {
            repl::run();
        }
        _ => {
            run_target(&args[0], &args[1..]);
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
    eprintln!("  run <target>  Run a file or package.json script");
    eprintln!("  init [dir]    Initialize a new Velox project in the current directory or a target directory");
    eprintln!("  add <pkg>     Add package(s) to package.json/node_modules");
    eprintln!("  install       Install dependencies from package.json");
    eprintln!("  cache         Manage package cache (dir/info/clear)");
    eprintln!("  x <pkg>       Run a package binary (npx alternative)");
    eprintln!("  create <name> Run create-<name> package (bun create style)");
    eprintln!("  snapshot      Build/load V8 startup snapshot");
    eprintln!("  fmt [files]   Format source files");
    eprintln!("  check [files] Type-check source files");
    eprintln!("  test [files]  Run test files");
    eprintln!("  repl          Start interactive REPL");
    eprintln!("\n{}Options:{}", colors::BOLD, colors::RESET);
    eprintln!("  --watch, -w            Watch for file changes and re-run");
    eprintln!("  --import-map <file>    Load import map from JSON file");
    eprintln!("\n{}Shortcuts:{}", colors::BOLD, colors::RESET);
    eprintln!(
        "  {0} <target> [args]    Same as `{0} run <target> [args]`",
        program
    );
    eprintln!("\n{}Permissions:{}", colors::BOLD, colors::RESET);
    eprintln!("  --allow-all, -A        Allow all permissions");
    eprintln!("  --allow-read[=<path>]  Allow file system read access");
    eprintln!("  --allow-write[=<path>] Allow file system write access");
    eprintln!("  --allow-net[=<host>]   Allow network access");
    eprintln!("  --allow-run[=<prog>]   Allow running subprocesses");
    eprintln!("  --allow-env[=<var>]    Allow environment variable access");
    eprintln!("\nRun with no arguments to start REPL");
}

fn run_target(program: &str, args: &[String]) {
    if args.is_empty() {
        eprintln!("{}", colors::error("missing file argument"));
        print_usage(program);
        process::exit(1);
    }

    // Parse permission flags first
    let (perms, remaining_args) = permissions::parse_flags(args);
    permissions::init(perms);

    // Parse other flags and collect script arguments
    let mut import_map_path: Option<String> = None;
    let mut script_path: Option<String> = None;
    let mut script_args: Vec<String> = Vec::new();
    let mut watch_mode = false;
    let mut i = 0;

    while i < remaining_args.len() {
        match remaining_args[i].as_str() {
            "--import-map" if i + 1 < remaining_args.len() => {
                import_map_path = Some(remaining_args[i + 1].clone());
                i += 2;
            }
            "--watch" | "-w" => {
                watch_mode = true;
                i += 1;
            }
            _ if script_path.is_none() => {
                script_path = Some(remaining_args[i].clone());
                i += 1;
            }
            _ => {
                script_args.push(remaining_args[i].clone());
                i += 1;
            }
        }
    }

    let script_path = match script_path {
        Some(p) => p,
        None => {
            eprintln!("{}", colors::error("missing file argument"));
            print_usage(program);
            process::exit(1);
        }
    };

    if Path::new(&script_path).is_file() {
        if watch_mode {
            watch::run_watch(&script_path, script_args, import_map_path);
        } else {
            run_file(&script_path, script_args, import_map_path);
        }
    } else {
        if watch_mode || import_map_path.is_some() {
            eprintln!(
                "{}",
                colors::error(
                    "--watch and --import-map are only supported when running a file path"
                )
            );
            process::exit(1);
        }

        match pkg::run_project_script(&script_path, &script_args) {
            Ok(code) => {
                if code != 0 {
                    process::exit(code);
                }
            }
            Err(e) => {
                eprintln!("{}", colors::error(&e));
                process::exit(1);
            }
        }
    }
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

fn run_snapshot(args: &[String]) {
    let mut out_path = String::from("velox.snapshot.bin");
    let mut mode: Option<&str> = None;
    let mut i = 0usize;

    while i < args.len() {
        match args[i].as_str() {
            "build" if mode.is_none() => {
                mode = Some("build");
                i += 1;
            }
            "--out" if i + 1 < args.len() => {
                out_path = args[i + 1].clone();
                i += 2;
            }
            "-h" | "--help" => {
                println!("Usage: velox snapshot build [--out <path>]");
                println!("Default output: velox.snapshot.bin (current directory)");
                println!("Runtime auto-loads ./velox.snapshot.bin or VELOX_SNAPSHOT_PATH");
                return;
            }
            other => {
                eprintln!("{}", colors::error(&format!("unknown option '{}'", other)));
                process::exit(1);
            }
        }
    }

    if mode != Some("build") {
        eprintln!("{}", colors::error("missing subcommand 'build'"));
        eprintln!("Usage: velox snapshot build [--out <path>]");
        process::exit(1);
    }

    let out = Path::new(&out_path);
    match Runtime::build_snapshot(out) {
        Ok(size) => {
            println!(
                "{}snapshot built{} {} ({} bytes)",
                colors::GREEN,
                colors::RESET,
                out.display(),
                size
            );
        }
        Err(e) => {
            eprintln!("{}", colors::error(&e));
            process::exit(1);
        }
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

fn run_add(args: &[String]) {
    if args.is_empty() {
        eprintln!("{}", colors::error("missing package name"));
        eprintln!("\nUsage: velox add [options] <pkg...>");
        eprintln!("Options:");
        eprintln!("  -D, --dev    Add as dev dependency");
        eprintln!("  -E, --exact  Pin exact version");
        process::exit(1);
    }

    let mut packages: Vec<String> = Vec::new();
    let mut dev = false;
    let mut exact = false;

    for arg in args {
        match arg.as_str() {
            "-D" | "--dev" => dev = true,
            "-E" | "--exact" => exact = true,
            "-h" | "--help" => {
                println!("Usage: velox add [options] <pkg...>");
                println!("Options:");
                println!("  -D, --dev    Add as dev dependency");
                println!("  -E, --exact  Pin exact version");
                return;
            }
            _ if arg.starts_with('-') => {
                eprintln!("{}", colors::error(&format!("unknown option '{}'", arg)));
                process::exit(1);
            }
            _ => packages.push(arg.clone()),
        }
    }

    if packages.is_empty() {
        eprintln!("{}", colors::error("missing package name"));
        process::exit(1);
    }

    println!(
        "{}Installing:{} {}",
        colors::CYAN,
        colors::RESET,
        packages.join(", ")
    );

    if let Err(e) = pkg::add_packages(&packages, pkg::AddOptions { dev, exact }) {
        eprintln!("{}", colors::error(&e));
        process::exit(1);
    }
}

fn run_x(args: &[String]) {
    if args.is_empty() {
        eprintln!("{}", colors::error("missing package name"));
        eprintln!("\nUsage: velox x <pkg[@version]> [args...]");
        process::exit(1);
    }

    if matches!(args[0].as_str(), "-h" | "--help") {
        println!("Usage: velox x <pkg[@version]> [args...]");
        println!("Example: velox x cowsay hello");
        return;
    }

    let package_spec = &args[0];
    let cmd_args: Vec<String> = args[1..].to_vec();

    match pkg::run_package_binary(package_spec, &cmd_args) {
        Ok(code) => {
            if code != 0 {
                process::exit(code);
            }
        }
        Err(e) => {
            eprintln!("{}", colors::error(&e));
            process::exit(1);
        }
    }
}

fn run_create(args: &[String]) {
    if args.is_empty() {
        eprintln!("{}", colors::error("missing create package name"));
        eprintln!("\nUsage: velox create <name> [args...]");
        eprintln!("Example: velox create vite my-app");
        process::exit(1);
    }

    if matches!(args[0].as_str(), "-h" | "--help") {
        eprintln!("\nUsage: velox create <name> [args...]");
        println!("Example: velox create vite my-app");
        println!("Runs: velox x create-<name> [args...]");
        return;
    }

    let spec = map_create_name_to_package(&args[0]);
    let cmd_args: Vec<String> = args[1..].to_vec();

    match pkg::run_package_binary(&spec, &cmd_args) {
        Ok(code) => {
            if code != 0 {
                process::exit(code);
            }
        }
        Err(e) => {
            eprintln!("{}", colors::error(&e));
            process::exit(1);
        }
    }
}

fn map_create_name_to_package(input: &str) -> String {
    if input.starts_with("create-") || input.starts_with('@') {
        return input.to_string();
    }

    if let Some((name, version)) = split_unscoped_package_version(input) {
        return format!("create-{}@{}", name, version);
    }

    format!("create-{}", input)
}

fn split_unscoped_package_version(input: &str) -> Option<(&str, &str)> {
    let at_idx = input.rfind('@')?;
    if at_idx == 0 || at_idx + 1 >= input.len() {
        return None;
    }
    let name = &input[..at_idx];
    if name.contains('/') {
        return None;
    }
    let version = &input[at_idx + 1..];
    Some((name, version))
}

fn run_install(args: &[String]) {
    let mut include_dev = true;
    for arg in args {
        match arg.as_str() {
            "--prod" | "--production" => include_dev = false,
            "-h" | "--help" => {
                println!("Usage: velox install [--prod]");
                println!(
                    "  --prod, --production   Install only dependencies (exclude devDependencies)"
                );
                return;
            }
            _ => {
                eprintln!("{}", colors::error(&format!("unknown option '{}'", arg)));
                process::exit(1);
            }
        }
    }

    if let Err(e) = pkg::install_from_package_json(include_dev) {
        eprintln!("{}", colors::error(&e));
        process::exit(1);
    }
}

fn run_cache(args: &[String]) {
    let cmd = if args.is_empty() {
        "info"
    } else {
        args[0].as_str()
    };
    match cmd {
        "dir" => {
            println!("{}", pkg::cache_dir().display());
        }
        "info" => match pkg::cache_info() {
            Ok(info) => {
                println!("Cache path: {}", info.path.display());
                println!("Files: {}", info.files);
                println!("Size: {} bytes", info.bytes);
            }
            Err(e) => {
                eprintln!("{}", colors::error(&e));
                process::exit(1);
            }
        },
        "clear" => match pkg::cache_clear() {
            Ok(()) => println!("{}cache cleared{}", colors::GREEN, colors::RESET),
            Err(e) => {
                eprintln!("{}", colors::error(&e));
                process::exit(1);
            }
        },
        "-h" | "--help" => {
            println!("Usage: velox cache [info|dir|clear]");
            println!("  info   Show cache location and size (default)");
            println!("  dir    Print cache directory path");
            println!("  clear  Delete all cached metadata/tarballs/x cache");
        }
        _ => {
            eprintln!(
                "{}",
                colors::error(&format!("unknown cache command '{}'", cmd))
            );
            eprintln!("Run `velox cache --help` for usage.");
            process::exit(1);
        }
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

fn run_init(args: &[String]) {
    // Get project name from args or current directory name
    let project_name = if !args.is_empty() {
        args[0].clone()
    } else {
        env::current_dir()
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
            .unwrap_or_else(|| "velox-project".to_string())
    };

    // Check if we're initializing in a new directory or current directory
    let project_dir = if !args.is_empty() {
        let dir = Path::new(&args[0]);
        if !dir.exists() {
            if let Err(e) = fs::create_dir_all(dir) {
                eprintln!(
                    "{}",
                    colors::error(&format!("Failed to create directory: {}", e))
                );
                process::exit(1);
            }
        }
        dir.to_path_buf()
    } else {
        env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf())
    };

    println!(
        "{}Initializing Velox project in {}{}",
        colors::CYAN,
        project_dir.display(),
        colors::RESET
    );

    // Create velox.d.ts
    let velox_dts = include_str!("../templates/velox.d.ts");
    let velox_dts_path = project_dir.join("velox.d.ts");
    if !velox_dts_path.exists() {
        if let Err(e) = fs::write(&velox_dts_path, velox_dts) {
            eprintln!(
                "{}",
                colors::error(&format!("Failed to create velox.d.ts: {}", e))
            );
        } else {
            println!("  {} velox.d.ts", colors::green("created"));
        }
    } else {
        println!(
            "  {} velox.d.ts (already exists)",
            colors::yellow("skipped")
        );
    }

    // Create tsconfig.json
    let tsconfig = format!(
        r#"{{
  "compilerOptions": {{
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "lib": ["ES2022"],
    "types": ["./velox.d.ts"]
  }},
  "include": ["**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}}
"#
    );
    let tsconfig_path = project_dir.join("tsconfig.json");
    if !tsconfig_path.exists() {
        if let Err(e) = fs::write(&tsconfig_path, tsconfig) {
            eprintln!(
                "{}",
                colors::error(&format!("Failed to create tsconfig.json: {}", e))
            );
        } else {
            println!("  {} tsconfig.json", colors::green("created"));
        }
    } else {
        println!(
            "  {} tsconfig.json (already exists)",
            colors::yellow("skipped")
        );
    }

    // Create package.json if it doesn't exist
    let package_json = format!(
        r#"{{
  "name": "{}",
  "version": "1.0.0",
  "type": "module",
  "scripts": {{
    "start": "velox run main.ts",
    "dev": "velox run --watch main.ts",
    "test": "velox test",
    "fmt": "velox fmt",
    "check": "velox check"
  }}
}}
"#,
        project_name
    );
    let package_json_path = project_dir.join("package.json");
    if !package_json_path.exists() {
        if let Err(e) = fs::write(&package_json_path, package_json) {
            eprintln!(
                "{}",
                colors::error(&format!("Failed to create package.json: {}", e))
            );
        } else {
            println!("  {} package.json", colors::green("created"));
        }
    } else {
        println!(
            "  {} package.json (already exists)",
            colors::yellow("skipped")
        );
    }

    // Create main.ts entry file
    let main_ts = r#"// Welcome to Velox!
// Run with: velox run main.ts

console.log("Hello from Velox!");

// Example: Read environment variable
const name = Velox.env.get("USER") || "world";
console.log(`Hello, ${name}!`);

// Example: File system
// const content = await Velox.fs.readTextFile("./data.txt");

// Example: HTTP server
// Velox.serve({
//   port: 3000,
//   handler: (req) => new Response("Hello, World!"),
//   onListen: ({ port }) => console.log(`Server running at http://localhost:${port}`),
// });
"#;
    let main_ts_path = project_dir.join("main.ts");
    if !main_ts_path.exists() {
        if let Err(e) = fs::write(&main_ts_path, main_ts) {
            eprintln!(
                "{}",
                colors::error(&format!("Failed to create main.ts: {}", e))
            );
        } else {
            println!("  {} main.ts", colors::green("created"));
        }
    } else {
        println!("  {} main.ts (already exists)", colors::yellow("skipped"));
    }

    // Create .gitignore if it doesn't exist
    let gitignore = r#"# Dependencies
node_modules/

# Build output
dist/
build/

# Environment files
.env
.env.local

# OS files
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
"#;
    let gitignore_path = project_dir.join(".gitignore");
    if !gitignore_path.exists() {
        if let Err(e) = fs::write(&gitignore_path, gitignore) {
            eprintln!(
                "{}",
                colors::error(&format!("Failed to create .gitignore: {}", e))
            );
        } else {
            println!("  {} .gitignore", colors::green("created"));
        }
    } else {
        println!(
            "  {} .gitignore (already exists)",
            colors::yellow("skipped")
        );
    }

    println!(
        "\n{}Done!{} Your Velox project is ready.",
        colors::GREEN,
        colors::RESET
    );
    println!("\nNext steps:");
    if !args.is_empty() {
        println!("  {}cd {}{}", colors::CYAN, args[0], colors::RESET);
    }
    println!("  {}velox main.ts{}", colors::CYAN, colors::RESET);
    println!(
        "\nRun {}velox --help{} for more commands.",
        colors::CYAN,
        colors::RESET
    );
}

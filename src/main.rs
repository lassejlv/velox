//! velox — a tiny TypeScript/JavaScript runtime built on Apple's
//! JavaScriptCore, transpiling with oxc and bundling relative ES modules.

mod coverage;
mod crypto;
mod event_loop;
mod fetch;
mod init;
mod inspect;
mod module;
mod node;
mod oxc_helpers;
mod pkg;
mod repl;
mod runtime;
mod server;
mod shared;
mod sourcemap;
mod sqlite;
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
    after_help = "Commands:\n  init [DIR]              Scaffold a new velox project\n  install                Install dependencies from package.json\n  add [--dev] <pkg>...   Add packages and install them\n  remove <pkg>...        Remove packages\n  update [--latest]      Upgrade dependencies\n  outdated               List dependencies with newer versions\n  run [script]           Run a package.json script\n  test [pattern]         Run tests (describe/it/expect)\n  x <pkg> [args]         Run a package's executable (npx-style)\n  build <entry>          Compile to a standalone executable\n\nRun `velox <command> --help` for details."
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

    /// Arguments passed through to the script (available via `process.argv`).
    /// Everything after the file name — including flags — goes to the script.
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    #[allow(dead_code)] // surfaced to JS through `process.argv` (std::env::args).
    script_args: Vec<String>,
}

fn main() -> ExitCode {
    // A compiled standalone binary (`velox build`) carries its bundle appended
    // to this executable — run it directly, ignoring CLI parsing.
    if let Some(bundle) = embedded_bundle() {
        return run_bundle(&bundle);
    }

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
    // Auto-load conventional `.env` files (after `--env-file`, which wins).
    auto_load_env();
    if let Some(code) = cli.eval {
        return run_source(&code, "[eval].ts");
    }
    match cli.file {
        Some(path) if cli.watch => watch_loop(&path),
        Some(path) => run_file(&path),
        // A bare `velox` shows the home screen rather than dropping into the
        // REPL — the REPL now lives behind `velox repl` (Bun-style).
        None => {
            ui::about();
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
        "repl" => {
            if has_help {
                println!(
                    "Usage: velox repl\n\n  Start the interactive REPL (top-level await supported)."
                );
                return Some(ExitCode::SUCCESS);
            }
            repl::start();
            Some(ExitCode::SUCCESS)
        }
        // A bare `velox help` / `velox --help` / `velox -h` shows the home
        // screen; clap still handles `velox <command> --help` for per-command
        // usage (those have a non-empty `rest`/different `cmd`).
        "help" | "-h" | "--help" if rest.is_empty() => {
            ui::about();
            Some(ExitCode::SUCCESS)
        }
        // Accept `-v` too (clap's built-in short is `-V`); match Node/Bun.
        "-v" | "-V" | "--version" if rest.is_empty() => {
            println!("velox {}", env!("CARGO_PKG_VERSION"));
            Some(ExitCode::SUCCESS)
        }
        // Node-compat interactive mode: tools spawn `node -i` and parse the
        // banner/prompt, so emit Node's exact greeting and a `> ` REPL over
        // stdin/stdout (velox's own branded REPL stays behind `velox repl`).
        "-i" | "--interactive" if rest.is_empty() => Some(node_interactive_repl()),
        "init" => {
            if has_help {
                println!(
                    "Usage: velox init [DIR]\n\n  Scaffold a new velox project in DIR (default: current directory).\n\nOptions:\n  --no-install   Skip installing @types/node."
                );
                return Some(ExitCode::SUCCESS);
            }
            let no_install = rest.iter().any(|a| a == "--no-install");
            let dir = positionals().into_iter().next();
            Some(init::run(dir.as_deref(), no_install))
        }
        "install" | "i" => {
            if has_help {
                println!(
                    "Usage: velox install\n\n  Install all dependencies from package.json into node_modules."
                );
                return Some(ExitCode::SUCCESS);
            }
            // `velox install <pkg>` is an alias for `add` (npm-compatible).
            let pkgs = positionals();
            if pkgs.is_empty() {
                Some(pkg::install())
            } else {
                let dev = rest
                    .iter()
                    .any(|a| a == "--dev" || a == "-D" || a == "--save-dev");
                Some(pkg::add(&pkgs, dev))
            }
        }
        "add" | "a" => {
            if has_help {
                println!(
                    "Usage: velox add [--dev] <pkg>[@version]...\n\n  Add packages to package.json and install them.\n\nOptions:\n  -D, --dev   Save to devDependencies."
                );
                return Some(ExitCode::SUCCESS);
            }
            let dev = rest
                .iter()
                .any(|a| a == "--dev" || a == "-D" || a == "--save-dev");
            Some(pkg::add(&positionals(), dev))
        }
        "remove" | "rm" | "uninstall" | "un" => {
            if has_help {
                println!(
                    "Usage: velox remove <pkg>...\n\n  Remove packages from package.json and node_modules."
                );
                return Some(ExitCode::SUCCESS);
            }
            Some(pkg::remove(&positionals()))
        }
        "test" | "t" => {
            if has_help {
                println!(
                    "Usage: velox test [PATTERN...] [-t NAME] [--coverage] [--watch] [-u]\n\n  Run test files (*.test.* / *.spec.* / files under test/__tests__).\n  Globals describe/it/test/expect + before*/after* hooks are provided.\n  PATTERNs filter by file-path substring.\n\nOptions:\n  -t, --test-name-pattern N Only run tests whose name contains N.\n  --coverage                Report line/function coverage of the source under test.\n  --coverage-threshold=N    Fail if line or function coverage is below N%.\n  --coverage-lcov[=PATH]    Also write lcov (default coverage/lcov.info).\n  --reporter=json[=PATH]    Write machine-readable results (default test-results.json).\n  -u, --update              Update toMatchSnapshot snapshots.\n  -w, --watch               Re-run on change."
                );
                return Some(ExitCode::SUCCESS);
            }
            // -t / --test-name-pattern NAME (space or =form). Its value must be
            // excluded from the file-path patterns below.
            let (name_filter, test_patterns) = parse_test_name_filter(rest);
            // Any coverage sub-flag implies --coverage. Threshold/lcov take the
            // attached `=VALUE` form so a bare value isn't read as a pattern.
            let threshold =
                flag_eq_value(rest, "--coverage-threshold").and_then(|v| v.parse::<f64>().ok());
            // `--coverage-lcov` (default path) or `--coverage-lcov=PATH`.
            let lcov = flag_present(rest, "--coverage-lcov").then(|| {
                flag_eq_value(rest, "--coverage-lcov")
                    .unwrap_or_else(|| "coverage/lcov.info".to_string())
            });
            let coverage = rest.iter().any(|a| a == "--coverage" || a == "--cov")
                || threshold.is_some()
                || lcov.is_some();
            let watch = rest.iter().any(|a| a == "--watch" || a == "-w");
            let update = rest.iter().any(|a| a == "--update" || a == "-u");
            // --reporter=json[=PATH] (machine-readable results to a file).
            let reporter = flag_eq_value(rest, "--reporter");
            Some(cmd_test(
                &test_patterns,
                CoverageOpts {
                    on: coverage,
                    threshold,
                    lcov,
                },
                watch,
                update,
                name_filter,
                reporter,
            ))
        }
        "bench" | "benchmark" => {
            if has_help {
                println!(
                    "Usage: velox bench [PATTERN...] [--reporter=json]\n\n  Run benchmark files (*.bench.* / *.benchmark.* / files under bench/).\n  Globals bench/describe + before*/after* hooks are provided.\n  PATTERNs filter by path substring.\n\nOptions:\n  --reporter=json[=PATH]   Write machine-readable results (default bench-results.json)."
                );
                return Some(ExitCode::SUCCESS);
            }
            Some(cmd_bench(&positionals(), flag_eq_value(rest, "--reporter")))
        }
        "build" | "compile" => {
            if has_help {
                println!(
                    "Usage: velox build <entry> [--out NAME]\n\n  Bundle <entry> and its deps into a standalone, code-signed executable."
                );
                return Some(ExitCode::SUCCESS);
            }
            let positional = positionals();
            let Some(entry) = positional.first() else {
                eprintln!("velox build: missing entry file (try `velox build app.ts`)");
                return Some(ExitCode::FAILURE);
            };
            // `--out NAME` / `-o NAME`, else the entry's stem.
            let out = rest
                .iter()
                .position(|a| a == "--out" || a == "-o")
                .and_then(|i| rest.get(i + 1))
                .cloned()
                .unwrap_or_else(|| {
                    Path::new(entry)
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "app".to_string())
                });
            Some(build_executable(Path::new(entry), Path::new(&out)))
        }
        "outdated" => {
            if has_help {
                println!(
                    "Usage: velox outdated\n\n  Show direct dependencies that have a newer version available."
                );
                return Some(ExitCode::SUCCESS);
            }
            Some(pkg::outdated())
        }
        "update" | "up" | "upgrade" => {
            if has_help {
                println!(
                    "Usage: velox update [--latest] [pkg...]\n\n  Upgrade dependencies to the newest version in range (or, with --latest,\n  bump the range to the newest published version first)."
                );
                return Some(ExitCode::SUCCESS);
            }
            let latest = rest.iter().any(|a| a == "--latest" || a == "-L");
            Some(pkg::update(&positionals(), latest))
        }
        "x" | "exec" | "dlx" => {
            if has_help || rest.is_empty() {
                println!(
                    "Usage: velox x <pkg>[@version] [args...]\n\n  Download a package (and its deps) and run its executable with velox."
                );
                return Some(ExitCode::SUCCESS);
            }
            // First arg is the package spec; everything after is passed to the tool.
            let spec = rest[0].clone();
            let tool_args: Vec<String> = rest[1..].to_vec();
            Some(pkg::x(&spec, &tool_args))
        }
        "run" | "run-script" => {
            if has_help {
                println!(
                    "Usage: velox run [SCRIPT] [-- args...]\n\n  Run a package.json script (no SCRIPT lists them). pre/post hooks run too."
                );
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

/// Load an explicit `--env-file` (overrides existing variables; reports an error
/// if the file is missing).
fn load_env_file(path: &Path) {
    if !apply_env_file(path, true) {
        ui::report_runtime_error(&format!("--env-file: cannot read {}", path.display()));
    }
}

/// Auto-load conventional `.env` files from the current directory (Bun/Vite
/// style): `.env` and `.env.local`, plus `.env.<NODE_ENV>` and
/// `.env.<NODE_ENV>.local` when `NODE_ENV` is set. More specific files win, but
/// a variable already present in the real environment (or set by `--env-file`)
/// is never overwritten. Missing files are skipped silently.
fn auto_load_env() {
    let mut files: Vec<String> = Vec::new();
    if let Ok(mode) = std::env::var("NODE_ENV") {
        let mode = mode.trim();
        if !mode.is_empty() {
            files.push(format!(".env.{mode}.local"));
            files.push(format!(".env.{mode}"));
        }
    }
    files.push(".env.local".to_string());
    files.push(".env".to_string());
    // Highest priority first; never override an already-set variable.
    for file in files {
        apply_env_file(Path::new(&file), false);
    }
}

/// Parse a `.env` file and set its `KEY=VALUE` pairs into the process
/// environment (so `process.env` picks them up). When `override_existing` is
/// false, variables already present in the environment are left untouched.
/// Returns whether the file could be read. Supports `#` comments, `export`
/// prefixes, blank lines, and single/double-quoted values.
fn apply_env_file(path: &Path, override_existing: bool) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
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
        if key.is_empty() {
            continue;
        }
        if override_existing || std::env::var_os(key).is_none() {
            unsafe { std::env::set_var(key, value) };
        }
    }
    true
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

/// Node-compat `velox -i`: Node's exact greeting + a `> ` REPL on stdin/stdout
/// (the node:repl builtin drives evaluation). Tools that spawn `node -i` and
/// parse the banner/prompt — including Node's own test suite — depend on the
/// precise bytes, so keep the version in sync with `process.version` (node.rs).
fn node_interactive_repl() -> ExitCode {
    use std::io::Write;
    print!("Welcome to Node.js v22.12.0.\nType \".help\" for more information.\n> ");
    let _ = std::io::stdout().flush();
    run_source(
        "const repl = require('node:repl');\n\
         repl.start({ prompt: '> ', terminal: false, useColors: false });\n",
        "interactive",
    )
}

/// The primary subcommand names, used to offer a "did you mean" hint when a
/// bareword argument is a near-miss typo rather than a real file.
const COMMANDS: &[&str] = &[
    "init", "install", "add", "remove", "test", "bench", "build", "outdated", "update", "x", "run",
    "repl", "help",
];

/// The closest command within edit distance 2 of `name` (None if nothing close).
fn closest_command(name: &str) -> Option<&'static str> {
    COMMANDS
        .iter()
        .map(|c| (*c, levenshtein(name, c)))
        .filter(|(_, d)| *d <= 2)
        .min_by_key(|(_, d)| *d)
        .map(|(c, _)| c)
}

/// Classic Levenshtein edit distance (two-row DP).
fn levenshtein(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut curr = vec![0; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        curr[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            curr[j + 1] = (prev[j + 1] + 1).min(curr[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[b.len()]
}

fn run_file(path: &Path) -> ExitCode {
    // A bareword that doesn't exist on disk but is a near-miss for a subcommand
    // (`velox buld`, `velox instal`) is almost certainly a typo, not a file —
    // suggest the command instead of a cryptic "failed to read".
    if !path.exists()
        && let Some(name) = path.to_str()
        && !name.contains('/')
        && !name.contains('.')
        && let Some(suggestion) = closest_command(name)
    {
        ui::report_unknown_command(name, suggestion);
        return ExitCode::FAILURE;
    }

    // Resolve + transpile + bundle the entry and its relative imports into a
    // single script (JSC's evaluator does not accept ESM syntax directly).
    // Cached: a repeat run with unchanged sources skips re-bundling.
    let js = match module::bundle_cached(path) {
        Ok(js) => js,
        Err(error) => {
            ui::report_module_error(&error.to_string());
            return ExitCode::FAILURE;
        }
    };
    run_bundle(&js)
}

/// Evaluate an already-bundled script on a fresh runtime and drain the event
/// loop. Shared by `run_file`, `--eval`, and compiled (embedded) binaries.
fn run_bundle(js: &str) -> ExitCode {
    let runtime = Runtime::new();
    match runtime.eval(js) {
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

// --- `velox test` — built-in test runner ------------------------------------

/// Coverage options for a `velox test` run.
#[derive(Clone, Default)]
struct CoverageOpts {
    /// Collect + report coverage at all.
    on: bool,
    /// Fail the run if line or function coverage is below this percentage.
    threshold: Option<f64>,
    /// Also write an lcov report to this path.
    lcov: Option<String>,
}

/// `velox test [patterns]` — discover test files, run them through a generated
/// driver that loads the `velox-test` framework, and report. `--coverage`
/// instruments the source under test; `--watch` re-runs on change.
#[allow(clippy::too_many_arguments)]
fn cmd_test(
    patterns: &[String],
    cov: CoverageOpts,
    watch: bool,
    update: bool,
    name_filter: Option<String>,
    reporter: Option<String>,
) -> ExitCode {
    use owo_colors::OwoColorize;

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut files = Vec::new();
    discover_tests(&cwd, patterns, &mut files);
    files.sort();

    if files.is_empty() {
        eprintln!(
            "  {} no test files found{}",
            "✖".red().bold(),
            if patterns.is_empty() {
                " (looked for *.test.* / *.spec.* and files under test/, __tests__/)".to_string()
            } else {
                format!(" matching {}", patterns.join(", "))
            }
        );
        return ExitCode::FAILURE;
    }

    if watch {
        return watch_tests(
            &files,
            &cov,
            update,
            name_filter.as_deref(),
            reporter.as_deref(),
        );
    }
    run_tests_once(
        &files,
        &cov,
        update,
        name_filter.as_deref(),
        reporter.as_deref(),
    )
    .0
}

/// Bundle + run the discovered test files once. Returns the exit code and the
/// set of source files that went into the run (for `--watch`).
fn run_tests_once(
    files: &[PathBuf],
    cov: &CoverageOpts,
    update: bool,
    name_filter: Option<&str>,
    reporter: Option<&str>,
) -> (ExitCode, Vec<PathBuf>) {
    use owo_colors::OwoColorize;

    println!(
        "  {} {} {}{}\n",
        "velox".cyan().bold(),
        "test".dimmed(),
        format!(
            "· {} file{}",
            files.len(),
            if files.len() == 1 { "" } else { "s" }
        )
        .dimmed(),
        if cov.on {
            " · coverage".dimmed().to_string()
        } else {
            String::new()
        }
    );

    // Generate a driver that installs the test globals, loads each test file,
    // then runs the collected suite.
    let mut driver = String::from("const __t = require('velox-test');\n__t.register();\n");
    if update {
        driver.push_str("globalThis.__VELOX_SNAPSHOT = { update: true };\n");
    }
    if let Some(filter) = name_filter {
        driver.push_str(&format!(
            "globalThis.__VELOX_TEST_FILTER = {};\n",
            js_string_literal(filter)
        ));
    }
    if let Some(rep) = reporter {
        driver.push_str(&format!(
            "globalThis.__VELOX_TEST_REPORTER = {};\n",
            js_string_literal(rep)
        ));
    }
    for f in files {
        driver.push_str(&format!(
            "require({});\n",
            js_string_literal(&f.to_string_lossy())
        ));
    }
    driver.push_str("await __t.run();\n");

    // Stage as a hidden temp file (uncached so it doesn't pollute the bundle
    // cache), bundle + run it, then clean up.
    let driver_path = std::env::temp_dir().join(format!(".velox-test-{}.ts", std::process::id()));
    if std::fs::write(&driver_path, &driver).is_err() {
        return (fail_msg("test: could not stage driver"), Vec::new());
    }

    if cov.on {
        coverage::begin();
    }
    let built = module::bundle_with_deps(&driver_path);
    let collected = if cov.on { coverage::finish() } else { None };

    let result = match built {
        Ok((js, deps)) => {
            // Prepend the coverage prelude (counter + point table + reporter
            // options) so the injected `__VCOV(n)` calls resolve before any
            // module runs and `test.js` can find the config.
            let js = match &collected {
                Some(c) if !c.is_empty() => {
                    format!("{}{}{js}", c.prelude_js(), coverage_opts_js(cov))
                }
                _ => js,
            };
            (run_bundle(&js), deps)
        }
        Err(error) => {
            ui::report_module_error(&error.to_string());
            (ExitCode::FAILURE, Vec::new())
        }
    };
    let _ = std::fs::remove_file(&driver_path);
    result
}

/// JS assigning `globalThis.__VCOV_OPT` — the reporter config (threshold gate +
/// optional lcov path) that `test.js::printCoverage` reads.
fn coverage_opts_js(cov: &CoverageOpts) -> String {
    let threshold = match cov.threshold {
        Some(t) => t.to_string(),
        None => "null".to_string(),
    };
    let lcov = match &cov.lcov {
        Some(p) => js_string_literal(p),
        None => "null".to_string(),
    };
    format!("globalThis.__VCOV_OPT={{\"threshold\":{threshold},\"lcov\":{lcov}}};\n")
}

/// `velox test --watch`: run, then re-run whenever any source file that went
/// into the run changes (polling its mtimes, like the top-level `--watch`).
fn watch_tests(
    files: &[PathBuf],
    cov: &CoverageOpts,
    update: bool,
    name_filter: Option<&str>,
    reporter: Option<&str>,
) -> ExitCode {
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
        let (_, deps) = run_tests_once(files, cov, update, name_filter, reporter);
        // Watch the test files plus everything they pulled in; fall back to just
        // the test files if bundling failed.
        let watched: Vec<PathBuf> = if deps.is_empty() {
            files.to_vec()
        } else {
            deps
        };
        eprintln!(
            "\x1b[2m[velox] watching {} file(s); Ctrl-C to exit\x1b[0m",
            watched.len()
        );
        let mut snapshot = mtimes(&watched);
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

/// Recursively collect files under `root` matching `is_match` (skipping
/// node_modules / hidden / build dirs), filtered by path-substring `patterns`.
fn discover_files(
    root: &Path,
    patterns: &[String],
    is_match: &dyn Fn(&Path) -> bool,
    out: &mut Vec<PathBuf>,
) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if name.starts_with('.')
                || matches!(
                    name.as_str(),
                    "node_modules" | "dist" | "build" | "target" | "coverage"
                )
            {
                continue;
            }
            discover_files(&path, patterns, is_match, out);
        } else if is_match(&path)
            && (patterns.is_empty()
                || patterns
                    .iter()
                    .any(|p| path.to_string_lossy().contains(p.as_str())))
        {
            out.push(path);
        }
    }
}

/// A file is a test if it's named `*.test.*` / `*.spec.*` or lives under a
/// `test`/`tests`/`__tests__` directory, with a JS/TS extension.
fn discover_tests(root: &Path, patterns: &[String], out: &mut Vec<PathBuf>) {
    discover_files(root, patterns, &is_test_file, out);
}

fn has_js_ext(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs")
    )
}

fn is_test_file(path: &Path) -> bool {
    if !has_js_ext(path) {
        return false;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.contains(".test.") || name.contains(".spec.") {
        return true;
    }
    path.components()
        .any(|c| matches!(c.as_os_str().to_str(), Some("test" | "tests" | "__tests__")))
}

/// A file is a benchmark if it's named `*.bench.*` / `*.benchmark.*` or lives
/// under a `bench`/`benches`/`benchmarks` directory, with a JS/TS extension.
fn is_bench_file(path: &Path) -> bool {
    if !has_js_ext(path) {
        return false;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.contains(".bench.") || name.contains(".benchmark.") {
        return true;
    }
    path.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some("bench" | "benches" | "benchmarks")
        )
    })
}

/// `velox bench [patterns]` — discover benchmark files and run them through a
/// generated driver that loads the `velox-bench` framework.
fn cmd_bench(patterns: &[String], reporter: Option<String>) -> ExitCode {
    use owo_colors::OwoColorize;

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut files = Vec::new();
    discover_files(&cwd, patterns, &is_bench_file, &mut files);
    files.sort();

    if files.is_empty() {
        eprintln!(
            "  {} no benchmark files found{}",
            "✖".red().bold(),
            if patterns.is_empty() {
                " (looked for *.bench.* / *.benchmark.* and files under bench/, benchmarks/)"
                    .to_string()
            } else {
                format!(" matching {}", patterns.join(", "))
            }
        );
        return ExitCode::FAILURE;
    }

    println!(
        "  {} {} {}\n",
        "velox".cyan().bold(),
        "bench".dimmed(),
        format!(
            "· {} file{}",
            files.len(),
            if files.len() == 1 { "" } else { "s" }
        )
        .dimmed()
    );

    let mut driver = String::from("const __b = require('velox-bench');\n__b.register();\n");
    if let Some(rep) = &reporter {
        driver.push_str(&format!(
            "globalThis.__VELOX_BENCH_REPORTER = {};\n",
            js_string_literal(rep)
        ));
    }
    for f in &files {
        driver.push_str(&format!(
            "require({});\n",
            js_string_literal(&f.to_string_lossy())
        ));
    }
    driver.push_str("await __b.run();\n");

    let driver_path = std::env::temp_dir().join(format!(".velox-bench-{}.ts", std::process::id()));
    if std::fs::write(&driver_path, &driver).is_err() {
        return fail_msg("bench: could not stage driver");
    }
    let result = match module::bundle(&driver_path) {
        Ok(js) => run_bundle(&js),
        Err(error) => {
            ui::report_module_error(&error.to_string());
            ExitCode::FAILURE
        }
    };
    let _ = std::fs::remove_file(&driver_path);
    result
}

/// Encode a string as a JS string literal (double-quoted, escaped).
fn js_string_literal(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// Split out the `-t`/`--test-name-pattern` value (space or `=` form) and the
/// remaining file-path patterns. Done together so the filter's space-form value
/// isn't mistaken for a path pattern.
fn parse_test_name_filter(args: &[String]) -> (Option<String>, Vec<String>) {
    let mut filter = None;
    let mut patterns = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "-t" || a == "--test-name-pattern" {
            filter = args.get(i + 1).cloned();
            i += 2;
        } else if let Some(v) = a
            .strip_prefix("-t=")
            .or_else(|| a.strip_prefix("--test-name-pattern="))
        {
            filter = Some(v.to_string());
            i += 1;
        } else {
            if !a.starts_with('-') {
                patterns.push(a.clone());
            }
            i += 1;
        }
    }
    (filter, patterns)
}

/// Whether `name` appears in `args` as a bare flag or in `name=...` form.
fn flag_present(args: &[String], name: &str) -> bool {
    let eq = format!("{name}=");
    args.iter().any(|a| a == name || a.starts_with(&eq))
}

/// Value of `--flag=VALUE` only (the attached form).
fn flag_eq_value(args: &[String], name: &str) -> Option<String> {
    let eq = format!("{name}=");
    args.iter()
        .find_map(|a| a.strip_prefix(&eq).map(str::to_string))
}

fn fail_msg(msg: &str) -> ExitCode {
    use owo_colors::OwoColorize;
    eprintln!("  {} {msg}", "✖".red().bold());
    ExitCode::FAILURE
}

// --- `velox build` — standalone executables ---------------------------------
//
// A compiled binary is a copy of the velox executable with the bundled script
// appended, followed by a 16-byte trailer: `MAGIC (8) || payload_len (u64 LE)`.
// At startup velox reads just that trailer; if the magic matches it runs the
// embedded bundle instead of acting as a CLI. macOS code signatures cover only
// the Mach-O image (their `codeLimit`), so the inherited signature stays valid
// for the code and the JIT entitlement is honored — the appended payload simply
// sits outside the signed region. (Strict `codesign -v` flags the trailing
// data, but the binary executes with full JIT, like Bun/Deno compiled output.)

const COMPILE_MAGIC: &[u8; 8] = b"VLXBNDL1";

/// If the running executable carries an embedded bundle, return its source.
/// Reads only the trailing 16 bytes unless the magic matches, so it's cheap for
/// the normal (non-compiled) velox.
fn embedded_bundle() -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let exe = std::env::current_exe().ok()?;
    let mut file = std::fs::File::open(&exe).ok()?;
    let size = file.metadata().ok()?.len();
    if size < 16 {
        return None;
    }
    file.seek(SeekFrom::End(-16)).ok()?;
    let mut trailer = [0u8; 16];
    file.read_exact(&mut trailer).ok()?;
    if &trailer[..8] != COMPILE_MAGIC {
        return None;
    }
    let len = u64::from_le_bytes(trailer[8..16].try_into().ok()?);
    if len == 0 || len + 16 > size {
        return None;
    }
    file.seek(SeekFrom::Start(size - 16 - len)).ok()?;
    let mut payload = vec![0u8; len as usize];
    file.read_exact(&mut payload).ok()?;
    String::from_utf8(payload).ok()
}

/// `velox build <entry> [--out NAME]` — bundle the entry and emit a standalone,
/// code-signed (JIT-enabled) executable.
fn build_executable(entry: &Path, out: &Path) -> ExitCode {
    use owo_colors::OwoColorize;
    use std::io::Write;

    let js = match module::bundle(entry) {
        Ok(js) => js,
        Err(error) => {
            ui::report_module_error(&error.to_string());
            return ExitCode::FAILURE;
        }
    };

    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => {
            ui::report_runtime_error(&format!("build: cannot locate velox: {e}"));
            return ExitCode::FAILURE;
        }
    };
    let mut bytes = match std::fs::read(&exe) {
        Ok(b) => b,
        Err(e) => {
            ui::report_runtime_error(&format!("build: cannot read velox binary: {e}"));
            return ExitCode::FAILURE;
        }
    };

    // If the running velox is itself a compiled binary, strip its trailer +
    // payload first so we embed only the new bundle.
    bytes.truncate(base_executable_len(&bytes));

    // Write the signed velox image, then append the payload after it. The
    // inherited signature's `codeLimit` covers only the Mach-O, so the trailing
    // payload is outside the signed region and the JIT entitlement is preserved.
    let payload = js.into_bytes();
    let write_base = (|| -> std::io::Result<()> {
        let mut f = std::fs::File::create(out)?;
        f.write_all(&bytes)?;
        f.flush()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(out, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    })();
    if let Err(e) = write_base {
        ui::report_runtime_error(&format!("build: cannot write {}: {e}", out.display()));
        return ExitCode::FAILURE;
    }

    // Append the payload AFTER the (inherited) signature. The signature's
    // codeLimit covers only the Mach-O image, so the trailing payload sits
    // outside the signed region — the signature stays valid for the code and
    // the JIT entitlement is honored, while we can still read the payload at EOF.
    let append = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().append(true).open(out)?;
        f.write_all(&payload)?;
        f.write_all(COMPILE_MAGIC)?;
        f.write_all(&(payload.len() as u64).to_le_bytes())?;
        f.flush()
    })();
    if let Err(e) = append {
        ui::report_runtime_error(&format!("build: cannot append payload: {e}"));
        return ExitCode::FAILURE;
    }

    let total = bytes.len() + payload.len() + 16;
    let size_mb = total as f64 / 1_048_576.0;
    println!(
        "  {} {} {}",
        "✓".green().bold(),
        out.display(),
        format!("({size_mb:.1} MB)").dimmed()
    );
    ExitCode::SUCCESS
}

/// Length of the Mach-O portion of `bytes` — i.e. the file with any existing
/// compiled trailer + payload removed.
fn base_executable_len(bytes: &[u8]) -> usize {
    if bytes.len() < 16 {
        return bytes.len();
    }
    let trailer = &bytes[bytes.len() - 16..];
    if &trailer[..8] != COMPILE_MAGIC {
        return bytes.len();
    }
    let len = u64::from_le_bytes(trailer[8..16].try_into().unwrap()) as usize;
    if len + 16 <= bytes.len() {
        bytes.len() - 16 - len
    } else {
        bytes.len()
    }
}

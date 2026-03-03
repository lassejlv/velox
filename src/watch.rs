//! Watch mode for Velox
//!
//! Watches files for changes and re-runs the script.

use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
use std::path::Path;
use std::sync::mpsc::channel;
use std::time::Duration;

use crate::builtins;
use crate::colors;
use crate::modules;
use crate::runtime::Runtime;
use crate::shutdown;

/// Run a file in watch mode, re-executing on changes
pub fn run_watch(path: &str, script_args: Vec<String>, import_map_path: Option<String>) {
    let script_path = Path::new(path);
    let watch_dir = script_path.parent().unwrap_or(Path::new(".")).to_path_buf();

    println!(
        "{}Watching{} {} for changes...\n",
        colors::CYAN,
        colors::RESET,
        watch_dir.display()
    );

    // Initial run
    run_once(path, &script_args, &import_map_path);

    // Set up file watcher
    let (tx, rx) = channel::<DebounceEventResult>();

    let mut debouncer = match new_debouncer(Duration::from_millis(300), tx) {
        Ok(d) => d,
        Err(e) => {
            eprintln!(
                "{}",
                colors::error(&format!("Failed to create watcher: {}", e))
            );
            return;
        }
    };

    // Watch the directory containing the script
    if let Err(e) = debouncer
        .watcher()
        .watch(&watch_dir, RecursiveMode::Recursive)
    {
        eprintln!(
            "{}",
            colors::error(&format!("Failed to watch directory: {}", e))
        );
        return;
    }

    // Also watch the current directory if different
    let cwd = std::env::current_dir().unwrap_or_default();
    if cwd != watch_dir {
        let _ = debouncer.watcher().watch(&cwd, RecursiveMode::Recursive);
    }

    // Watch loop
    loop {
        // Check for shutdown signal (Ctrl+C)
        if shutdown::is_shutdown_requested() {
            println!("\n{}Watch mode stopped.{}", colors::CYAN, colors::RESET);
            break;
        }

        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(events)) => {
                // Filter for relevant file changes
                let relevant_change = events.iter().any(|event| {
                    let path = &event.path;
                    if let Some(ext) = path.extension() {
                        let ext = ext.to_string_lossy().to_lowercase();
                        matches!(ext.as_str(), "ts" | "tsx" | "js" | "jsx" | "mjs" | "json")
                    } else {
                        false
                    }
                });

                if relevant_change {
                    // Clear screen (optional, can be annoying)
                    // print!("\x1B[2J\x1B[1;1H");

                    println!(
                        "\n{}[{}]{} File changed, restarting...\n",
                        colors::CYAN,
                        chrono_time(),
                        colors::RESET
                    );

                    // Clear module cache before re-running
                    modules::clear_cache();

                    run_once(path, &script_args, &import_map_path);
                }
            }
            Ok(Err(error)) => {
                eprintln!("{}", colors::error(&format!("Watch error: {}", error)));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // No events, continue checking for shutdown
                continue;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                eprintln!("{}", colors::error("Watch channel disconnected"));
                break;
            }
        }
    }
}

/// Run the script once
fn run_once(path: &str, script_args: &[String], import_map_path: &Option<String>) {
    let source = match std::fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) => {
            eprintln!(
                "{}",
                colors::error(&format!("cannot read '{}': {}", path, e))
            );
            return;
        }
    };

    // Load import map if specified
    if let Some(map_path) = import_map_path {
        if let Err(e) = modules::load_import_map(Path::new(map_path)) {
            eprintln!(
                "{}",
                colors::error(&format!("failed to load import map: {}", e))
            );
            return;
        }
    } else {
        // Auto-detect import map
        let script_dir = Path::new(path).parent().unwrap_or(Path::new("."));
        for name in ["import_map.json", "importmap.json", "deno.json"] {
            let map_path = script_dir.join(name);
            if map_path.exists() {
                let _ = modules::load_import_map(&map_path);
                break;
            }
        }
    }

    // Set process args
    let exec_path = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| String::from("velox"));
    builtins::process::set_args(exec_path, script_args.to_vec());

    let mut runtime = Runtime::new();

    if let Err(e) = runtime.execute(path, &source) {
        eprintln!("{}", e);
    }
}

/// Get current time in HH:MM:SS format
fn chrono_time() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    // Simple time calculation (not timezone aware, but good enough)
    let hours = (now % 86400) / 3600;
    let minutes = (now % 3600) / 60;
    let seconds = now % 60;

    format!("{:02}:{:02}:{:02}", hours, minutes, seconds)
}

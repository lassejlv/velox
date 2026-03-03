mod builtins;
mod colors;
mod event_loop;
mod runtime;
mod transpiler;

use runtime::Runtime;
use std::env;
use std::fs;
use std::process;

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 3 {
        print_usage(&args[0]);
        process::exit(1);
    }

    match args[1].as_str() {
        "run" => run_file(&args[2]),
        _ => {
            eprintln!("{}", colors::error(&format!("unknown command '{}'", args[1])));
            print_usage(&args[0]);
            process::exit(1);
        }
    }
}

fn print_usage(program: &str) {
    eprintln!(
        "\n{}Usage:{} {} run <file.js>",
        colors::BOLD,
        colors::RESET,
        program
    );
}

fn run_file(path: &str) {
    let source = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(e) => {
            eprintln!("{}", colors::error(&format!("cannot read '{}': {}", path, e)));
            process::exit(1);
        }
    };

    let mut runtime = Runtime::new();

    if let Err(e) = runtime.execute(path, &source) {
        eprintln!("{}", e);
        process::exit(1);
    }
}

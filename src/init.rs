//! `velox init [dir]` — scaffold a new velox project.
//!
//! Lays down `src/main.ts`, `package.json`, `tsconfig.json`, a copy of the
//! bundled `velox.d.ts` type definitions, and a `.gitignore`, then installs
//! `@types/node` with velox's own package manager (so `node:*` imports
//! type-check in an editor). Existing files are never overwritten — `init` is
//! safe to re-run.

use std::path::Path;
use std::process::ExitCode;

use owo_colors::OwoColorize;

/// The bundled Velox type definitions, copied into new projects.
const VELOX_DTS: &str = include_str!("../velox.d.ts");

const MAIN_TS: &str = r#"/// <reference path="../velox.d.ts" />

// A tiny HTTP server to get you started. Run it with:
//   velox src/main.ts      (or: npm run dev  — re-runs on change)
const server = Velox.serve({
  port: 3000,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response("Hello from velox! 🚀");
    }
    return Response.json({ ok: true, path: url.pathname });
  },
});

console.log("Listening on http://localhost:3000");
"#;

const TSCONFIG: &str = r#"{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ESNext"],
    "types": ["node"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": false,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "velox.d.ts"]
}
"#;

const GITIGNORE: &str = "node_modules/\n*.log\n.DS_Store\n\n# local env files (secrets) — keep .env out of git too if it has secrets\n.env.local\n.env.*.local\n";

/// Entry point for the `init` subcommand.
pub fn run(dir: Option<&str>, no_install: bool) -> ExitCode {
    let target = dir.unwrap_or(".");
    let root = Path::new(target);

    if let Err(e) = std::fs::create_dir_all(root) {
        eprintln!("{} cannot create {target}: {e}", "✖".red().bold());
        return ExitCode::FAILURE;
    }

    let name = project_name(root);

    println!();
    println!(
        "  {} {} {}",
        "velox".cyan().bold(),
        "init".dimmed(),
        format!("· scaffolding {name}").dimmed()
    );
    println!();

    let pkg = package_json(&name);
    let mut wrote_any = false;
    wrote_any |= write_file(root, "src/main.ts", MAIN_TS);
    wrote_any |= write_file(root, "package.json", &pkg);
    wrote_any |= write_file(root, "tsconfig.json", TSCONFIG);
    wrote_any |= write_file(root, "velox.d.ts", VELOX_DTS);
    wrote_any |= write_file(root, ".gitignore", GITIGNORE);

    if !no_install {
        // Install @types/node using velox's own package manager. The pkg
        // commands operate on the current directory, so switch into the new
        // project first (the process exits right after, so this is safe).
        if std::env::set_current_dir(root).is_ok() {
            println!();
            let _ = crate::pkg::add(&["@types/node".to_string()], true);
        }
    }

    println!();
    if wrote_any {
        println!("  {} project ready.", "✓".green().bold());
    } else {
        println!("  {} nothing to do — project already initialized.", "•".dimmed());
    }
    println!();
    println!("  {}", "next steps".bold());
    if target != "." {
        println!("    {} {}", "cd".green(), target);
    }
    println!("    {} {}", "velox".green(), "src/main.ts".dimmed());
    println!(
        "    {}                {}",
        "velox --watch src/main.ts".green(),
        "# re-run on change".dimmed()
    );
    println!();

    ExitCode::SUCCESS
}

/// Write `rel` under `root` unless it already exists. Returns true if written.
fn write_file(root: &Path, rel: &str, contents: &str) -> bool {
    let path = root.join(rel);
    if path.exists() {
        println!("  {} {}", "•".dimmed(), format!("{rel} (exists, kept)").dimmed());
        return false;
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match std::fs::write(&path, contents) {
        Ok(_) => {
            println!("  {} {}", "✓".green().bold(), rel);
            true
        }
        Err(e) => {
            eprintln!("  {} {rel}: {e}", "✖".red().bold());
            false
        }
    }
}

/// Render `package.json` with the project name baked in.
fn package_json(name: &str) -> String {
    format!(
        r#"{{
  "name": "{name}",
  "version": "0.1.0",
  "type": "module",
  "scripts": {{
    "dev": "velox --watch src/main.ts",
    "start": "velox src/main.ts"
  }},
  "devDependencies": {{}}
}}
"#
    )
}

/// Derive a valid npm package name from the target directory.
fn project_name(root: &Path) -> String {
    let raw = root
        .canonicalize()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_default();
    let cleaned: String = raw
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "velox-app".to_string()
    } else {
        trimmed.to_string()
    }
}


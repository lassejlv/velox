//! velox's built-in package manager: resolve, fetch, and extract npm packages
//! into `node_modules` so bundled `import`/`require` finds them.
//!
//!   velox install              install everything in package.json
//!   velox add <pkg>...         add packages (and `--dev` for devDependencies)
//!   velox remove <pkg>...      remove packages
//!
//! It speaks the npm registry directly (see [`registry`]); resolution is a flat
//! `node_modules` (see [`resolve`]). No install scripts are run.

mod registry;
mod resolve;
mod semver;
mod tarball;

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use base64::Engine;
use owo_colors::OwoColorize;
use serde_json::{Map, Value};
use sha2::Digest;

use resolve::Resolved;
use semver::Version;

/// `velox install` — resolve and install everything in `package.json`.
pub fn install() -> ExitCode {
    let pkg_path = PathBuf::from("package.json");
    let pkg = match load_package_json(&pkg_path) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let roots = gather_roots(&pkg, true);
    if roots.is_empty() {
        println!("  {} no dependencies in package.json", "•".dimmed());
        return ExitCode::SUCCESS;
    }
    run_install(&roots, "install")
}

/// `velox add <specs...>` — add packages, persist to package.json, install.
pub fn add(specs: &[String], dev: bool) -> ExitCode {
    if specs.is_empty() {
        return fail("nothing to add — usage: velox add <pkg>[@version]...");
    }
    let pkg_path = PathBuf::from("package.json");
    let mut pkg = match load_package_json(&pkg_path) {
        Ok(p) => p,
        // No package.json yet — start a minimal one.
        Err(_) => minimal_package_json(),
    };

    println!();
    println!("  {} {} {}", "velox".cyan().bold(), "add".dimmed(), "· resolving requested packages".dimmed());

    // Resolve each requested spec to a concrete version so we can pin `^x.y.z`.
    let mut to_record: Vec<(String, String)> = Vec::new();
    for spec in specs {
        let (name, range) = parse_spec(spec);
        let resolved = match resolve::resolve(&[(name.clone(), range.clone())]) {
            Ok(list) => list,
            Err(e) => return fail(&e),
        };
        let top = resolved.iter().find(|r| r.name == name);
        let Some(top) = top else {
            return fail(&format!("could not resolve {spec}"));
        };
        let save = save_range(&range, &top.version);
        to_record.push((name.clone(), save.clone()));
        println!("  {} {name} {}", "✓".green().bold(), save.dimmed());
    }

    // Merge into the chosen dependency map.
    let field = if dev { "devDependencies" } else { "dependencies" };
    {
        let obj = pkg.as_object_mut().unwrap();
        let deps = obj
            .entry(field)
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(map) = deps.as_object_mut() {
            for (name, range) in &to_record {
                map.insert(name.clone(), Value::String(range.clone()));
            }
        }
    }

    if let Err(e) = write_package_json(&pkg_path, &pkg) {
        return fail(&e);
    }

    // Install the full graph (existing deps + the new ones).
    let roots = gather_roots(&pkg, true);
    run_install(&roots, "add")
}

/// `velox remove <names...>` — drop packages from package.json and node_modules.
pub fn remove(names: &[String]) -> ExitCode {
    if names.is_empty() {
        return fail("nothing to remove — usage: velox remove <pkg>...");
    }
    let pkg_path = PathBuf::from("package.json");
    let mut pkg = match load_package_json(&pkg_path) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    println!();
    let mut removed = 0;
    if let Some(obj) = pkg.as_object_mut() {
        for field in ["dependencies", "devDependencies", "optionalDependencies"] {
            if let Some(map) = obj.get_mut(field).and_then(|v| v.as_object_mut()) {
                for name in names {
                    if map.remove(name).is_some() {
                        removed += 1;
                    }
                }
            }
        }
    }
    for name in names {
        let dir = node_modules_dir().join(name);
        if dir.exists() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        println!("  {} {name}", "−".red());
    }
    if let Err(e) = write_package_json(&pkg_path, &pkg) {
        return fail(&e);
    }
    println!();
    println!("  {} removed {removed} package(s)", "✓".green().bold());
    ExitCode::SUCCESS
}

// --- shared install pipeline ------------------------------------------------

fn run_install(roots: &[(String, String)], verb: &str) -> ExitCode {
    println!();
    println!(
        "  {} {} {}",
        "velox".cyan().bold(),
        verb.dimmed(),
        "· resolving dependency graph".dimmed()
    );

    let resolved = match resolve::resolve(roots) {
        Ok(r) => r,
        Err(e) => return fail(&e),
    };
    println!(
        "  {} resolved {} package(s)",
        "✓".green().bold(),
        resolved.len()
    );

    let nm = node_modules_dir();
    let mut installed = 0;
    let mut skipped = 0;
    for r in &resolved {
        match install_one(r, &nm) {
            Ok(true) => {
                installed += 1;
                println!("  {} {}@{}", "↓".cyan(), r.name, r.version.to_string().dimmed());
            }
            Ok(false) => skipped += 1,
            Err(e) => return fail(&format!("{}@{}: {e}", r.name, r.version)),
        }
    }

    // Record a simple lockfile for reproducibility.
    if let Err(e) = write_lockfile(&resolved) {
        eprintln!("  {} could not write velox-lock.json: {e}", "!".yellow());
    }

    println!();
    println!(
        "  {} {installed} installed{} into node_modules",
        "✓".green().bold(),
        if skipped > 0 {
            format!(", {skipped} up-to-date")
        } else {
            String::new()
        }
    );
    println!();
    ExitCode::SUCCESS
}

/// Download + verify + extract one package. Returns false if already present at
/// the resolved version.
fn install_one(r: &Resolved, nm: &Path) -> Result<bool, String> {
    let dest = nm.join(&r.name);
    if is_already_installed(&dest, &r.version) {
        return Ok(false);
    }
    let bytes = registry::https_get(&r.tarball, "application/octet-stream")?;
    verify_integrity(&bytes, r)?;
    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;
    tarball::extract(&bytes, &dest)?;
    Ok(true)
}

/// True if `node_modules/<name>/package.json` already reports `version`.
fn is_already_installed(dest: &Path, version: &Version) -> bool {
    let pj = dest.join("package.json");
    let Ok(text) = std::fs::read_to_string(&pj) else {
        return false;
    };
    serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["version"].as_str().map(String::from))
        .and_then(|s| Version::parse(&s))
        .map(|installed| &installed == version)
        .unwrap_or(false)
}

/// Verify the tarball against `dist.integrity` (sha512) or `dist.shasum` (sha1).
fn verify_integrity(bytes: &[u8], r: &Resolved) -> Result<(), String> {
    if let Some(integrity) = &r.integrity
        && let Some(b64) = integrity.strip_prefix("sha512-")
    {
        let digest = sha2::Sha512::digest(bytes);
        let expected = base64::engine::general_purpose::STANDARD
            .decode(b64.trim())
            .map_err(|_| "bad integrity encoding")?;
        if digest.as_slice() != expected.as_slice() {
            return Err("integrity check failed (sha512 mismatch)".to_string());
        }
        return Ok(());
    }
    if let Some(shasum) = &r.shasum {
        let digest = sha1::Sha1::digest(bytes);
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        if hex != shasum.trim() {
            return Err("integrity check failed (sha1 mismatch)".to_string());
        }
    }
    Ok(())
}

// --- package.json + lockfile -------------------------------------------------

fn node_modules_dir() -> PathBuf {
    PathBuf::from("node_modules")
}

fn load_package_json(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|_| "no package.json in the current directory (run `velox init` first)".to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("package.json is not valid JSON: {e}"))
}

fn minimal_package_json() -> Value {
    let mut obj = Map::new();
    obj.insert("name".into(), Value::String("velox-app".into()));
    obj.insert("version".into(), Value::String("0.1.0".into()));
    obj.insert("type".into(), Value::String("module".into()));
    Value::Object(obj)
}

/// Collect (name, range) roots from `dependencies` (+ `devDependencies` when
/// `include_dev`).
fn gather_roots(pkg: &Value, include_dev: bool) -> Vec<(String, String)> {
    let mut roots = Vec::new();
    let mut fields = vec!["dependencies", "optionalDependencies"];
    if include_dev {
        fields.push("devDependencies");
    }
    for field in fields {
        if let Some(map) = pkg[field].as_object() {
            for (name, range) in map {
                roots.push((name.clone(), range.as_str().unwrap_or("*").to_string()));
            }
        }
    }
    roots
}

/// Serialize package.json with a stable, npm-like top-level key order. Done by
/// hand because serde_json's `Map` (a `BTreeMap`) would otherwise alphabetize
/// the top-level keys. Dependency sub-objects stay sorted, which is what npm
/// does anyway.
fn write_package_json(path: &Path, pkg: &Value) -> Result<(), String> {
    const ORDER: &[&str] = &[
        "name", "version", "description", "type", "main", "module", "bin",
        "exports", "scripts", "dependencies", "devDependencies",
        "optionalDependencies", "peerDependencies",
    ];
    let obj = pkg.as_object().ok_or("package.json must be an object")?;

    // Preferred keys first (in ORDER), then any remaining keys alphabetically.
    let mut keys: Vec<&String> = Vec::new();
    for key in ORDER {
        if let Some((k, _)) = obj.get_key_value(*key) {
            keys.push(k);
        }
    }
    for k in obj.keys() {
        if !ORDER.contains(&k.as_str()) {
            keys.push(k);
        }
    }

    let mut text = String::from("{\n");
    for (i, key) in keys.iter().enumerate() {
        let value = &obj[key.as_str()];
        let rendered = serde_json::to_string_pretty(value)
            .map_err(|e| format!("serialize package.json: {e}"))?
            // Indent continuation lines so nested objects sit under their key.
            .replace('\n', "\n  ");
        let comma = if i + 1 < keys.len() { "," } else { "" };
        text.push_str(&format!("  {}: {rendered}{comma}\n", json_str(key)));
    }
    text.push_str("}\n");

    std::fs::write(path, text).map_err(|e| format!("write package.json: {e}"))
}

fn json_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

fn write_lockfile(resolved: &[Resolved]) -> Result<(), String> {
    let mut packages = Map::new();
    for r in resolved {
        let mut entry = Map::new();
        entry.insert("version".into(), Value::String(r.version.to_string()));
        entry.insert("resolved".into(), Value::String(r.tarball.clone()));
        if let Some(i) = &r.integrity {
            entry.insert("integrity".into(), Value::String(i.clone()));
        }
        packages.insert(r.name.clone(), Value::Object(entry));
    }
    let mut root = Map::new();
    root.insert("lockfileVersion".into(), Value::Number(1.into()));
    root.insert("packages".into(), Value::Object(packages));
    let text = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("serialize lockfile: {e}"))?;
    std::fs::write("velox-lock.json", text + "\n").map_err(|e| format!("write lockfile: {e}"))
}

// --- spec parsing ------------------------------------------------------------

/// Split `name@range` honoring scoped names. `lodash` → ("lodash", "latest");
/// `lodash@^4` → ("lodash", "^4"); `@scope/pkg@1.2.3` → ("@scope/pkg", "1.2.3").
fn parse_spec(spec: &str) -> (String, String) {
    let scoped = spec.starts_with('@');
    // Find the version separator: the last `@` that isn't the leading scope `@`.
    let at = spec
        .char_indices()
        .skip(if scoped { 1 } else { 0 })
        .find(|&(_, c)| c == '@')
        .map(|(i, _)| i);
    match at {
        Some(i) => (spec[..i].to_string(), spec[i + 1..].to_string()),
        None => (spec.to_string(), "latest".to_string()),
    }
}

/// What to persist in package.json. A bare/exact version pins `^x.y.z`; an
/// explicit range (`^`, `~`, `>=`, x-range, …) is recorded verbatim.
fn save_range(requested: &str, resolved: &Version) -> String {
    let r = requested.trim();
    if r.is_empty() || r == "latest" || r == "*" {
        return format!("^{resolved}");
    }
    let explicit = r.starts_with(['^', '~', '>', '<', '=', 'x', 'X', '*'])
        || r.contains('x')
        || r.contains('X')
        || r.contains('*')
        || r.contains(' ')
        || r.contains("||")
        || r.matches('.').count() < 2; // partial like `4` or `4.1`
    if explicit {
        r.to_string()
    } else {
        format!("^{resolved}")
    }
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("  {} {msg}", "✖".red().bold());
    ExitCode::FAILURE
}

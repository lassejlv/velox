//! velox's built-in package manager: resolve, fetch, and extract npm packages
//! into `node_modules` so bundled `import`/`require` finds them.
//!
//!   velox install              install everything in package.json
//!   velox add <pkg>...         add packages (and `--dev` for devDependencies)
//!   velox remove <pkg>...      remove packages
//!
//! It speaks the npm registry directly (see [`registry`]); resolution is a flat
//! `node_modules` (see [`resolve`]). No install scripts are run.

mod cache;
mod lockfile;
mod parallel;
mod registry;
mod resolve;
mod semver;
mod tarball;
mod workspace;

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use parallel::par_map;

/// How many tarballs to download + extract concurrently.
const DOWNLOAD_WORKERS: usize = 12;

use base64::Engine;
use owo_colors::OwoColorize;
use serde_json::{Map, Value};
use sha2::Digest;

use resolve::Resolved;
use semver::{Range, Version};

/// `velox install` — install everything. In a monorepo (npm `workspaces` or a
/// `pnpm-workspace.yaml`) all members' deps are installed together. Otherwise:
/// the locked graph from `velox.lock` if present (fast, reproducible), else
/// resolve from `package.json`.
pub fn install() -> ExitCode {
    if let Some(root) = current_workspace_root() {
        return install_workspace(&root, "install");
    }

    let pkg_path = PathBuf::from("package.json");
    let pkg = load_package_json(&pkg_path).ok();

    // Use the lockfile only if it still satisfies package.json's direct deps —
    // otherwise it's stale (package.json was hand-edited) and we re-resolve.
    if let Some(locked) = lockfile::read() {
        let fresh = pkg
            .as_ref()
            .map(|p| lockfile_is_fresh(p, &locked))
            .unwrap_or(true);
        if fresh {
            println!();
            println!(
                "  {} {} {}",
                "velox".cyan().bold(),
                "install".dimmed(),
                format!(
                    "· {} locked package(s) from {}",
                    locked.len(),
                    lockfile::LOCKFILE
                )
                .dimmed()
            );
            return install_resolved(locked);
        }
        println!(
            "  {} {} is out of date with package.json — re-resolving",
            "!".yellow(),
            lockfile::LOCKFILE
        );
    }

    let Some(pkg) = pkg else {
        return fail("no package.json in the current directory (run `velox init` first)");
    };
    let roots = gather_roots(&pkg, true);
    if roots.is_empty() {
        println!("  {} no dependencies in package.json", "•".dimmed());
        return ExitCode::SUCCESS;
    }
    run_install(&roots, "install")
}

/// The workspace root for the current directory, if any.
fn current_workspace_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    workspace::find_root(&cwd)
}

/// Install a whole workspace: resolve the union of every member's external
/// dependencies, hoist them into the root `node_modules`, then symlink each
/// member so cross-package imports resolve.
fn install_workspace(root: &Path, verb: &str) -> ExitCode {
    let Some(ws) = workspace::discover(root) else {
        return fail("could not read workspace");
    };
    // Operate from the workspace root (node_modules + lockfile live there).
    if std::env::set_current_dir(root).is_err() {
        return fail(&format!("cannot enter workspace root {}", root.display()));
    }

    println!();
    println!(
        "  {} {} {}",
        "velox".cyan().bold(),
        verb.dimmed(),
        format!("· workspace with {} package(s)", ws.members.len()).dimmed()
    );
    for m in &ws.members {
        println!("  {} {}", "•".dimmed(), m.name.dimmed());
    }

    // Gather external dependency roots from the root manifest + every member,
    // excluding workspace-local packages and non-registry specifiers.
    let members: std::collections::BTreeSet<String> = ws.member_names().into_iter().collect();
    let mut roots: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut add_manifest = |manifest: &Value, roots: &mut Vec<(String, String)>| {
        for (name, range) in gather_roots(manifest, true) {
            if members.contains(&name) || !resolve::is_registry_range(&range) {
                continue;
            }
            if seen.insert(name.clone()) {
                roots.push((name, range));
            }
        }
    };
    if let Ok(root_manifest) = load_package_json(&PathBuf::from("package.json")) {
        add_manifest(&root_manifest, &mut roots);
    }
    for m in &ws.members {
        add_manifest(&m.manifest, &mut roots);
    }

    // Resolve + install the hoisted external graph.
    let code = if roots.is_empty() {
        println!("  {} no external dependencies", "•".dimmed());
        ExitCode::SUCCESS
    } else {
        run_install(&roots, verb)
    };

    // Symlink every member into the root node_modules.
    let nm = node_modules_dir();
    let mut linked = 0;
    for m in &ws.members {
        let link = nm.join(&m.name);
        match workspace::symlink_dir(&m.dir, &link) {
            Ok(()) => linked += 1,
            Err(e) => eprintln!("  {} {}", "!".yellow(), e),
        }
    }
    println!(
        "  {} linked {linked} workspace package(s)",
        "✓".green().bold()
    );
    code
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
    println!(
        "  {} {} {}",
        "velox".cyan().bold(),
        "add".dimmed(),
        "· resolving requested packages".dimmed()
    );

    // Resolve each requested spec to a concrete version. `save` is what goes in
    // package.json (`^x.y.z` for a bare/exact request); `exact` is the version
    // to actually install — so `velox add pkg@1.2.3` installs *exactly* 1.2.3
    // (npm semantics) rather than the newest in `^1.2.3`.
    let mut to_record: Vec<(String, String)> = Vec::new();
    let mut exact: Vec<(String, String)> = Vec::new();
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
        exact.push((name.clone(), top.version.to_string()));
        println!("  {} {name} {}", "✓".green().bold(), save.dimmed());
    }

    // Merge into the chosen dependency map.
    let field = if dev {
        "devDependencies"
    } else {
        "dependencies"
    };
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

    // In a workspace, reinstall the whole workspace (so hoisting + member links
    // stay consistent); otherwise just this project's graph.
    if let Some(root) = current_workspace_root() {
        return install_workspace(&root, "add");
    }
    // Install the existing graph plus the new packages — pinned to the exact
    // requested version (not the saved `^` range).
    let mut root_map: std::collections::BTreeMap<String, String> =
        gather_roots(&pkg, true).into_iter().collect();
    for (name, version) in exact {
        root_map.insert(name, version);
    }
    let roots: Vec<(String, String)> = root_map.into_iter().collect();
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
    // Keep the lockfile in sync.
    lockfile::remove_names(names);
    println!();
    println!("  {} removed {removed} package(s)", "✓".green().bold());
    ExitCode::SUCCESS
}

// --- outdated / update -------------------------------------------------------

/// `velox outdated` — show direct dependencies with a newer version available.
pub fn outdated() -> ExitCode {
    let deps = collect_direct_deps();
    if deps.is_empty() {
        println!("  {} no dependencies", "•".dimmed());
        return ExitCode::SUCCESS;
    }

    let nm = node_modules_dir();
    let rows = par_map(deps, resolve_workers(), |(name, range)| {
        let meta = registry::fetch_metadata(&name).ok()?;
        let versions: Vec<Version> = meta["versions"]
            .as_object()
            .map(|o| o.keys().filter_map(|k| Version::parse(k)).collect())
            .unwrap_or_default();
        let wanted = Range::parse(&range).max_satisfying(&versions).cloned();
        let latest = meta["dist-tags"]["latest"]
            .as_str()
            .and_then(Version::parse);
        let current = installed_version(&nm.join(&name));
        Some((name, range, current, wanted, latest))
    });

    let mut shown = 0;
    println!();
    println!(
        "  {:<26} {:>12} {:>12} {:>12}",
        "Package".bold(),
        "Current".bold(),
        "Wanted".bold(),
        "Latest".bold()
    );
    for row in rows.into_iter().flatten() {
        let (name, _range, current, wanted, latest) = row;
        let cur_s = current
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "—".into());
        let want_s = wanted
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "—".into());
        let latest_s = latest
            .as_ref()
            .map(|v| v.to_string())
            .unwrap_or_else(|| "—".into());
        // Only list packages that aren't already at the latest.
        let up_to_date = matches!((&current, &latest), (Some(c), Some(l)) if c >= l);
        if up_to_date {
            continue;
        }
        shown += 1;
        let behind_wanted = matches!((&current, &wanted), (Some(c), Some(w)) if c < w);
        println!(
            "  {:<26} {:>12} {:>12} {:>12}",
            name,
            cur_s,
            if behind_wanted {
                want_s.yellow().to_string()
            } else {
                want_s
            },
            latest_s.green().to_string(),
        );
    }
    println!();
    if shown == 0 {
        println!("  {} everything is up to date", "✓".green().bold());
    } else {
        println!(
            "  {} {shown} package(s) can be updated — run `velox update`",
            "•".dimmed()
        );
    }
    ExitCode::SUCCESS
}

/// `velox update [pkgs] [--latest]` — upgrade dependencies. Without `--latest`,
/// re-resolves to the newest version inside each existing range (npm-update
/// style); with `--latest`, bumps the targeted ranges to `^<latest>` first.
pub fn update(pkgs: &[String], latest: bool) -> ExitCode {
    let pkg_path = PathBuf::from("package.json");
    let mut pkg = match load_package_json(&pkg_path) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };

    if latest {
        println!();
        println!(
            "  {} {} {}",
            "velox".cyan().bold(),
            "update".dimmed(),
            "· bumping ranges to latest".dimmed()
        );
        let targets: Vec<String> = if pkgs.is_empty() {
            direct_dep_names(&pkg)
        } else {
            pkgs.to_vec()
        };
        for name in &targets {
            match registry::fetch_metadata(name) {
                Ok(meta) => {
                    if let Some(latest_v) = meta["dist-tags"]["latest"].as_str()
                        && set_dep_range(&mut pkg, name, &format!("^{latest_v}"))
                    {
                        println!(
                            "  {} {name} {}",
                            "✓".green().bold(),
                            format!("^{latest_v}").dimmed()
                        );
                    }
                }
                Err(e) => eprintln!("  {} {name}: {e}", "!".yellow()),
            }
        }
        if let Err(e) = write_package_json(&pkg_path, &pkg) {
            return fail(&e);
        }
    }

    // Force a fresh resolution from package.json ranges (ignoring lockfile pins),
    // which picks the newest in-range version and rewrites velox.lock.
    if let Some(root) = current_workspace_root() {
        return install_workspace(&root, "update");
    }
    let roots = gather_roots(&pkg, true);
    if roots.is_empty() {
        println!("  {} no dependencies to update", "•".dimmed());
        return ExitCode::SUCCESS;
    }
    run_install(&roots, "update")
}

/// Collect direct deps (name, range) for outdated/update — workspace-aware.
fn collect_direct_deps() -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    let mut push = |manifest: &Value| {
        for (name, range) in gather_roots(manifest, true) {
            if resolve::is_registry_range(&range) && seen.insert(name.clone()) {
                out.push((name, range));
            }
        }
    };
    if let Some(root) = current_workspace_root()
        && let Some(ws) = workspace::discover(&root)
    {
        if let Ok(m) = load_package_json(&root.join("package.json")) {
            push(&m);
        }
        for m in &ws.members {
            push(&m.manifest);
        }
        return out;
    }
    if let Ok(pkg) = load_package_json(&PathBuf::from("package.json")) {
        push(&pkg);
    }
    out
}

/// Whether `locked` still satisfies every direct dependency declared in `pkg`
/// — i.e. the lockfile isn't stale relative to a hand-edited package.json.
fn lockfile_is_fresh(pkg: &Value, locked: &[Resolved]) -> bool {
    use std::collections::BTreeMap;
    let by_name: BTreeMap<&str, &Version> = locked
        .iter()
        .map(|r| (r.name.as_str(), &r.version))
        .collect();
    for (name, range) in gather_roots(pkg, true) {
        // Local/workspace/git specifiers aren't registry-resolved or locked.
        if !resolve::is_registry_range(&range) {
            continue;
        }
        match by_name.get(name.as_str()) {
            Some(v) if Range::parse(&range).matches(v) => {}
            _ => return false,
        }
    }
    true
}

fn direct_dep_names(pkg: &Value) -> Vec<String> {
    gather_roots(pkg, true)
        .into_iter()
        .map(|(n, _)| n)
        .collect()
}

/// Set the range for `name` in whichever dependency field it appears in.
/// Returns false if the package isn't a direct dependency.
fn set_dep_range(pkg: &mut Value, name: &str, range: &str) -> bool {
    if let Some(obj) = pkg.as_object_mut() {
        for field in ["dependencies", "devDependencies", "optionalDependencies"] {
            if let Some(map) = obj.get_mut(field).and_then(|v| v.as_object_mut())
                && map.contains_key(name)
            {
                map.insert(name.to_string(), Value::String(range.to_string()));
                return true;
            }
        }
    }
    false
}

fn installed_version(dest: &Path) -> Option<Version> {
    let text = std::fs::read_to_string(dest.join("package.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value["version"].as_str().and_then(Version::parse)
}

fn resolve_workers() -> usize {
    16
}

// --- velox x (npx-style runner) ----------------------------------------------

/// `velox x <pkg>[@version] [args...]` — fetch a package (and its deps) into a
/// cached store and run its bin with velox as the runtime. Like `npx`, but the
/// tool executes on JavaScriptCore.
pub fn x(spec: &str, args: &[String]) -> ExitCode {
    let (name, range) = parse_spec(spec);
    println!();
    println!(
        "  {} {} {}",
        "velox".cyan().bold(),
        "x".dimmed(),
        format!("· {spec}").dimmed()
    );

    let resolved = match resolve::resolve(&[(name.clone(), range)]) {
        Ok(r) => r,
        Err(e) => return fail(&e),
    };
    let Some(top) = resolved.iter().find(|r| r.name == name) else {
        return fail(&format!("could not resolve {spec}"));
    };
    let version = top.version.to_string();

    let Some(store) = x_store(&name, &version) else {
        return fail("no cache directory available (set $HOME or $VELOX_CACHE)");
    };
    let nm = store.join("node_modules");

    // Install the tool + its dependencies into the store (skips if present).
    let pkg_dir = nm.join(&name);
    if !pkg_dir.join("package.json").exists() {
        if let Err(e) = std::fs::create_dir_all(&nm) {
            return fail(&format!("mkdir {}: {e}", nm.display()));
        }
        let outcomes = par_map(resolved.clone(), DOWNLOAD_WORKERS, |r| install_one(&r, &nm));
        for outcome in outcomes {
            if let Err(e) = outcome {
                return fail(&e);
            }
        }
    }

    // Locate the executable from the tool's `bin` field.
    let bin = match find_bin(&pkg_dir, &name) {
        Some(b) => b,
        None => return fail(&format!("{name} does not expose an executable")),
    };

    let velox_exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(e) => return fail(&format!("cannot locate velox executable: {e}")),
    };
    println!("  {} {name}@{version}", "↯".cyan().bold());
    match Command::new(velox_exe).arg(&bin).args(args).status() {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(e) => fail(&format!("failed to run {name}: {e}")),
    }
}

fn x_store(name: &str, version: &str) -> Option<PathBuf> {
    cache::root().map(|r| r.join("_x").join(name).join(version))
}

/// Resolve the `bin` entry of an installed package to an absolute path. A string
/// `bin` is the package's single executable; an object maps names to paths.
fn find_bin(pkg_dir: &Path, name: &str) -> Option<PathBuf> {
    let text = std::fs::read_to_string(pkg_dir.join("package.json")).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let rel = match &value["bin"] {
        Value::String(s) => s.clone(),
        Value::Object(map) => {
            // Prefer the bin named like the package (its unscoped tail), else any.
            let short = name.rsplit('/').next().unwrap_or(name);
            map.get(short)
                .or_else(|| map.values().next())
                .and_then(|v| v.as_str())
                .map(String::from)?
        }
        _ => return None,
    };
    Some(pkg_dir.join(rel))
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

    // Record the lockfile from the resolution (independent of download success).
    if let Err(e) = lockfile::write(&resolved) {
        eprintln!(
            "  {} could not write {}: {e}",
            "!".yellow(),
            lockfile::LOCKFILE
        );
    }

    install_resolved(resolved)
}

/// Download + extract a fully-resolved set of packages concurrently, reporting
/// progress. Shared by `run_install` (resolve path) and `install` (lockfile).
fn install_resolved(resolved: Vec<Resolved>) -> ExitCode {
    let nm = node_modules_dir();
    let outcomes = par_map(resolved, DOWNLOAD_WORKERS, |r| {
        let result = install_one(&r, &nm);
        if let Ok(true) = &result {
            println!(
                "  {} {}@{}",
                "↓".cyan(),
                r.name,
                r.version.to_string().dimmed()
            );
        }
        (r.name, r.version, result)
    });

    let mut installed = 0;
    let mut skipped = 0;
    for (name, version, result) in &outcomes {
        match result {
            Ok(true) => installed += 1,
            Ok(false) => skipped += 1,
            Err(e) => return fail(&format!("{name}@{version}: {e}")),
        }
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
/// the resolved version. Uses the global tarball cache, falling back to the
/// registry on a miss (and populating the cache on download).
fn install_one(r: &Resolved, nm: &Path) -> Result<bool, String> {
    // A nested package installs under its dependent's own node_modules so the
    // module resolver (which walks up from the importer) finds the right version.
    let dest = match &r.nest_under {
        Some(parent) => nm.join(parent).join("node_modules").join(&r.name),
        None => nm.join(&r.name),
    };
    if is_already_installed(&dest, &r.version) {
        return Ok(false);
    }
    let version = r.version.to_string();

    // Prefer a cached tarball; ignore it if it fails verification.
    let bytes = match cache::read(&r.name, &version) {
        Some(b) if verify_integrity(&b, r).is_ok() => b,
        _ => {
            let b = registry::https_get(&r.tarball, "application/octet-stream")?;
            verify_integrity(&b, r)?;
            cache::write(&r.name, &version, &b);
            b
        }
    };

    if dest.exists() {
        let _ = std::fs::remove_dir_all(&dest);
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("mkdir {}: {e}", dest.display()))?;
    tarball::extract(&bytes, &dest)?;
    // Link bins into the node_modules the package actually lives in.
    let link_nm = match &r.nest_under {
        Some(parent) => nm.join(parent).join("node_modules"),
        None => nm.to_path_buf(),
    };
    link_bins(&link_nm, &r.name);
    Ok(true)
}

/// Create `node_modules/.bin/<name>` wrappers for a package's `bin` entries, so
/// `velox run`/`velox x` can invoke installed CLIs (tsc, vitest, eslint, …)
/// through velox as the runtime. Each wrapper is a tiny `sh` script that execs
/// `velox <bin.js> "$@"` (velox strips the bin's `#!/usr/bin/env node` shebang).
fn link_bins(nm: &Path, pkg_name: &str) {
    let pkg_dir = nm.join(pkg_name);
    let Ok(text) = std::fs::read_to_string(pkg_dir.join("package.json")) else {
        return;
    };
    let Ok(meta) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let mut bins: Vec<(String, String)> = Vec::new();
    match &meta["bin"] {
        Value::String(s) => {
            let short = pkg_name.rsplit('/').next().unwrap_or(pkg_name);
            bins.push((short.to_string(), s.clone()));
        }
        Value::Object(map) => {
            for (k, v) in map {
                if let Some(s) = v.as_str() {
                    bins.push((k.clone(), s.to_string()));
                }
            }
        }
        _ => return,
    }
    if bins.is_empty() {
        return;
    }
    let bin_dir = nm.join(".bin");
    if std::fs::create_dir_all(&bin_dir).is_err() {
        return;
    }
    let velox = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "velox".to_string());
    for (name, rel) in bins {
        let target = abs_path(&pkg_dir.join(rel.trim_start_matches("./")));
        let script = format!(
            "#!/bin/sh\nexec \"{velox}\" \"{}\" \"$@\"\n",
            target.display()
        );
        let link = bin_dir.join(&name);
        if std::fs::write(&link, script).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&link, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
}

/// Make a path absolute against the current directory.
fn abs_path(p: &Path) -> PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(p)
    }
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
    let text = std::fs::read_to_string(path).map_err(|_| {
        "no package.json in the current directory (run `velox init` first)".to_string()
    })?;
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
        "name",
        "version",
        "description",
        "type",
        "main",
        "module",
        "bin",
        "exports",
        "scripts",
        "dependencies",
        "devDependencies",
        "optionalDependencies",
        "peerDependencies",
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

// --- run scripts -------------------------------------------------------------

/// `velox run [name] [-- args...]` — run a `package.json` script (with `pre`/
/// `post` hooks, like npm). No name lists the available scripts.
pub fn run_script(name: Option<&str>, extra: &[String]) -> ExitCode {
    let pkg = match load_package_json(&PathBuf::from("package.json")) {
        Ok(p) => p,
        Err(e) => return fail(&e),
    };
    let scripts = pkg["scripts"].as_object();

    let Some(name) = name else {
        list_scripts(scripts);
        return ExitCode::SUCCESS;
    };

    let lookup = |key: &str| -> Option<String> {
        scripts
            .and_then(|s| s.get(key))
            .and_then(|v| v.as_str())
            .map(String::from)
    };

    let Some(main) = lookup(name) else {
        eprintln!(
            "  {} no script named \"{name}\" in package.json",
            "✖".red().bold()
        );
        list_scripts(scripts);
        return ExitCode::FAILURE;
    };

    // npm-style pre/post hooks.
    if let Some(pre) = lookup(&format!("pre{name}"))
        && let Some(code) = exec_script(&format!("pre{name}"), &pre, &[])
        && code != 0
    {
        return ExitCode::from(code as u8);
    }
    let code = match exec_script(name, &main, extra) {
        Some(c) => c,
        None => return ExitCode::FAILURE,
    };
    if code != 0 {
        return ExitCode::from(code as u8);
    }
    if let Some(post) = lookup(&format!("post{name}"))
        && let Some(c) = exec_script(&format!("post{name}"), &post, &[])
        && c != 0
    {
        return ExitCode::from(c as u8);
    }
    ExitCode::SUCCESS
}

/// Run a single script command through `sh -c`, with `node_modules/.bin` and the
/// velox executable's directory prepended to `PATH` (so scripts that call local
/// binaries or `velox` resolve). Returns the exit code, or None on spawn error.
fn exec_script(label: &str, command: &str, extra: &[String]) -> Option<i32> {
    let full = if extra.is_empty() {
        command.to_string()
    } else {
        format!("{command} {}", extra.join(" "))
    };
    println!(
        "  {} {} {}",
        "›".cyan().bold(),
        label.bold(),
        command.dimmed()
    );

    let mut path = String::new();
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        path.push_str(&dir.to_string_lossy());
        path.push(':');
    }
    if let Ok(cwd) = std::env::current_dir() {
        path.push_str(&cwd.join("node_modules/.bin").to_string_lossy());
        path.push(':');
    }
    if let Ok(existing) = std::env::var("PATH") {
        path.push_str(&existing);
    }

    match Command::new("sh")
        .arg("-c")
        .arg(&full)
        .env("PATH", path)
        .status()
    {
        Ok(status) => Some(status.code().unwrap_or(1)),
        Err(e) => {
            eprintln!("  {} could not run script: {e}", "✖".red().bold());
            None
        }
    }
}

fn list_scripts(scripts: Option<&Map<String, Value>>) {
    match scripts {
        Some(map) if !map.is_empty() => {
            println!("  {}", "available scripts".bold());
            for (name, cmd) in map {
                println!(
                    "    {:<14} {}",
                    name.green(),
                    cmd.as_str().unwrap_or("").dimmed()
                );
            }
        }
        _ => println!("  {} no scripts defined in package.json", "•".dimmed()),
    }
}

fn fail(msg: &str) -> ExitCode {
    eprintln!("  {} {msg}", "✖".red().bold());
    ExitCode::FAILURE
}

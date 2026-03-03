mod cache;
mod reporter;
mod tree;

use crate::colors;
use flate2::read::GzDecoder;
use rayon::prelude::*;
use semver::{Version, VersionReq};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::fs::File;
use std::io::{IsTerminal, Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicUsize, Ordering};

use cache::{
    cache_root_path, cache_stats, clear_all_cache, copy_dir_all, create_temp_dir, download_to_file,
    encode_registry_name, ensure_cache_dirs, find_unpacked_root, metadata_cache_path,
    tarball_cache_path, x_cache_dir_for_spec,
};
use reporter::InstallReporter;
use tree::print_dependency_tree;

const LOCK_FILE: &str = "velox.lock";

pub struct AddOptions {
    pub dev: bool,
    pub exact: bool,
}

pub struct CacheInfo {
    pub path: PathBuf,
    pub files: u64,
    pub bytes: u64,
}

#[derive(Clone, Default)]
struct LockPackage {
    version: String,
    resolved: String,
    dependencies: BTreeMap<String, String>,
}

#[derive(Default)]
struct LockData {
    dependencies: BTreeMap<String, String>,
    dev_dependencies: BTreeMap<String, String>,
    packages: BTreeMap<String, LockPackage>,
}

#[derive(Clone)]
struct InstalledPackage {
    version: String,
    resolved: String,
    dependencies: BTreeMap<String, String>,
}

struct InstallState {
    installed_versions: HashMap<String, String>,
    installed_packages: HashMap<String, InstalledPackage>,
    locked_versions: HashMap<String, String>,
    cache_root: PathBuf,
    seen_packages: std::collections::HashSet<String>,
}

pub fn add_packages(packages: &[String], options: AddOptions) -> Result<(), String> {
    ensure_package_json()?;
    let cache_root = ensure_cache_dirs()?;

    let mut package_json = load_package_json()?;
    let node_modules_dir = Path::new("node_modules");
    fs::create_dir_all(node_modules_dir)
        .map_err(|e| format!("Failed to create node_modules: {}", e))?;

    let existing_lock = load_lockfile()?;
    let mut state = InstallState {
        installed_versions: HashMap::new(),
        installed_packages: HashMap::new(),
        locked_versions: existing_lock
            .packages
            .iter()
            .map(|(name, pkg)| (name.clone(), pkg.version.clone()))
            .collect(),
        cache_root,
        seen_packages: std::collections::HashSet::new(),
    };
    let mut reporter = InstallReporter::new();

    let mut requested_roots: BTreeMap<String, String> = BTreeMap::new();
    let mut top_level_specs: Vec<(String, Option<String>)> = Vec::new();

    for package in packages {
        let (name, requested) = parse_package_request(package)?;
        requested_roots.insert(
            name.clone(),
            requested.clone().unwrap_or_else(|| "latest".to_string()),
        );
        top_level_specs.push((name, requested));
    }

    resolve_dependency_graph(&requested_roots, &mut state, &mut reporter)?;
    install_resolved_packages_parallel(node_modules_dir, &state, &mut reporter)?;
    setup_node_modules_bin(node_modules_dir, &state)?;
    run_postinstall_scripts(node_modules_dir, &state)?;

    for (name, requested) in top_level_specs {
        let resolved = state
            .installed_packages
            .get(&name)
            .map(|p| p.version.clone())
            .ok_or_else(|| format!("Internal error: package '{}' was not resolved", name))?;

        let record_version = if options.exact {
            resolved.clone()
        } else if let Some(req) = requested {
            req
        } else {
            format!("^{}", resolved)
        };

        set_dependency(&mut package_json, &name, &record_version, options.dev)?;
        reporter.tracked(&name, &record_version);
    }

    save_package_json(&package_json)?;

    let mut merged_packages = existing_lock.packages;
    for (name, pkg) in state.installed_packages {
        merged_packages.insert(
            name,
            LockPackage {
                version: pkg.version,
                resolved: pkg.resolved,
                dependencies: pkg.dependencies,
            },
        );
    }

    let lock = LockData {
        dependencies: get_dependency_map(&package_json, "dependencies"),
        dev_dependencies: get_dependency_map(&package_json, "devDependencies"),
        packages: merged_packages,
    };

    save_lockfile(&lock)?;
    reporter.summary();
    Ok(())
}

pub fn install_from_package_json(include_dev: bool) -> Result<(), String> {
    let cache_root = ensure_cache_dirs()?;
    let package_json = load_package_json()?;

    let mut root_deps = get_dependency_map(&package_json, "dependencies");
    if include_dev {
        for (k, v) in get_dependency_map(&package_json, "devDependencies") {
            root_deps.entry(k).or_insert(v);
        }
    }

    if root_deps.is_empty() {
        println!("No dependencies found in package.json");
        return Ok(());
    }

    let node_modules_dir = Path::new("node_modules");
    if node_modules_dir.exists() {
        fs::remove_dir_all(node_modules_dir)
            .map_err(|e| format!("Failed to clear node_modules: {}", e))?;
    }
    fs::create_dir_all(node_modules_dir)
        .map_err(|e| format!("Failed to create node_modules: {}", e))?;

    println!(
        "{}Installing:{} {} dependency spec(s) from package.json",
        colors::CYAN,
        colors::RESET,
        root_deps.len()
    );

    let existing_lock = load_lockfile()?;
    let mut state = InstallState {
        installed_versions: HashMap::new(),
        installed_packages: HashMap::new(),
        locked_versions: existing_lock
            .packages
            .iter()
            .map(|(name, pkg)| (name.clone(), pkg.version.clone()))
            .collect(),
        cache_root,
        seen_packages: std::collections::HashSet::new(),
    };
    let mut reporter = InstallReporter::new();

    resolve_dependency_graph(&root_deps, &mut state, &mut reporter)?;
    install_resolved_packages_parallel(node_modules_dir, &state, &mut reporter)?;
    setup_node_modules_bin(node_modules_dir, &state)?;
    run_postinstall_scripts(node_modules_dir, &state)?;

    let mut merged_packages = existing_lock.packages;
    for (name, pkg) in &state.installed_packages {
        merged_packages.insert(
            name.clone(),
            LockPackage {
                version: pkg.version.clone(),
                resolved: pkg.resolved.clone(),
                dependencies: pkg.dependencies.clone(),
            },
        );
    }

    let lock = LockData {
        dependencies: get_dependency_map(&package_json, "dependencies"),
        dev_dependencies: if include_dev {
            get_dependency_map(&package_json, "devDependencies")
        } else {
            BTreeMap::new()
        },
        packages: merged_packages,
    };

    save_lockfile(&lock)?;
    reporter.summary();
    if std::env::var("VELOX_PKG_VERBOSE")
        .ok()
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        print_dependency_tree(&root_deps, &state.installed_packages);
    }
    Ok(())
}

pub fn run_package_binary(package_spec: &str, args: &[String]) -> Result<i32, String> {
    let original_cwd =
        std::env::current_dir().map_err(|e| format!("Failed to read current directory: {}", e))?;
    let cache_root = ensure_cache_dirs()?;
    let x_dir = x_cache_dir_for_spec(&cache_root, package_spec);
    fs::create_dir_all(&x_dir).map_err(|e| {
        format!(
            "Failed to create x cache directory {}: {}",
            x_dir.display(),
            e
        )
    })?;

    let restore_result = (|| -> Result<i32, String> {
        std::env::set_current_dir(&x_dir)
            .map_err(|e| format!("Failed to enter x cache directory: {}", e))?;
        let (package_name, _) = parse_package_request(package_spec)?;
        let package_dir = Path::new("node_modules").join(&package_name);
        if !package_dir.exists() {
            add_packages(
                &[package_spec.to_string()],
                AddOptions {
                    dev: false,
                    exact: true,
                },
            )?;
        }
        let bin_path = resolve_package_bin(&package_name, &x_dir)?;

        std::env::set_current_dir(&original_cwd)
            .map_err(|e| format!("Failed to restore working directory: {}", e))?;

        let mut cmd = build_bin_command(&bin_path, args)?;
        cmd.current_dir(&original_cwd);
        prepend_node_bin_to_path(&mut cmd, &x_dir.join("node_modules").join(".bin"));

        let status = cmd
            .status()
            .map_err(|e| format!("Failed to execute {}: {}", package_name, e))?;
        Ok(status.code().unwrap_or(1))
    })();

    if std::env::current_dir().ok().as_ref() != Some(&original_cwd) {
        let _ = std::env::set_current_dir(&original_cwd);
    }

    restore_result
}

pub fn run_project_script(script_name: &str, args: &[String]) -> Result<i32, String> {
    let package_json = load_package_json()?;
    let script = package_json
        .get("scripts")
        .and_then(Value::as_object)
        .and_then(|scripts| scripts.get(script_name))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("Script '{}' not found in package.json", script_name))?;

    let cwd =
        std::env::current_dir().map_err(|e| format!("Failed to read current directory: {}", e))?;
    let bin_dir = cwd.join("node_modules").join(".bin");

    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(compose_windows_script_command(script, args));
        c
    };

    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.arg("-c").arg(compose_unix_script_command(script, args));
        c
    };

    cmd.current_dir(&cwd);
    prepend_node_bin_to_path(&mut cmd, &bin_dir);
    let status = cmd
        .status()
        .map_err(|e| format!("Failed to run script '{}': {}", script_name, e))?;
    Ok(status.code().unwrap_or(1))
}

pub fn cache_dir() -> PathBuf {
    cache_root_path()
}

pub fn cache_info() -> Result<CacheInfo, String> {
    let path = cache_root_path();
    let (files, bytes) = cache_stats()?;
    Ok(CacheInfo { path, files, bytes })
}

pub fn cache_clear() -> Result<(), String> {
    clear_all_cache()
}

fn resolve_dependency_graph(
    roots: &BTreeMap<String, String>,
    state: &mut InstallState,
    reporter: &mut InstallReporter,
) -> Result<(), String> {
    let mut frontier: Vec<(String, String, usize)> = roots
        .iter()
        .map(|(name, req)| (name.clone(), req.clone(), 0usize))
        .collect();

    while !frontier.is_empty() {
        let mut level: BTreeMap<String, (String, usize)> = BTreeMap::new();
        for (name, req, depth) in frontier.drain(..) {
            if state.installed_packages.contains_key(&name) {
                reporter.count_cache_reuse();
                reporter.reused_session(
                    &name,
                    state
                        .installed_versions
                        .get(&name)
                        .map(String::as_str)
                        .unwrap_or("resolved"),
                    depth,
                );
                continue;
            }
            level.entry(name).or_insert((req, depth));
        }

        if level.is_empty() {
            break;
        }

        for name in level.keys() {
            if state.seen_packages.insert(name.clone()) {
                reporter.register_target();
            }
        }

        let locked_versions = state.locked_versions.clone();
        let cache_root = state.cache_root.clone();

        let outcomes: Vec<ResolveOutcome> = level
            .into_par_iter()
            .map(|(name, (req, depth))| -> Result<ResolveOutcome, String> {
                let (metadata, metadata_cache_hit) =
                    fetch_package_metadata_cached(&name, &cache_root)?;
                let locked = locked_versions.get(&name).map(String::as_str);
                let resolved_version = resolve_version(&metadata, Some(&req), locked)?;
                let compatible = is_package_version_compatible(&metadata, &resolved_version)?;
                let tarball_url = get_tarball_url(&metadata, &resolved_version, &name)?;
                let dependencies = get_dependencies_from_metadata(&metadata, &resolved_version)?;
                Ok(ResolveOutcome {
                    name,
                    requested: req,
                    depth,
                    metadata_cache_hit,
                    lock_reused: matches!(locked, Some(v) if v == resolved_version),
                    compatible,
                    resolved_version,
                    tarball_url,
                    dependencies,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;

        let mut outcomes = outcomes;
        outcomes.sort_by(|a, b| a.name.cmp(&b.name));

        let mut next_frontier = Vec::new();
        for outcome in outcomes {
            reporter.count_resolve();
            reporter.resolving(&outcome.name, Some(&outcome.requested), outcome.depth);
            if outcome.metadata_cache_hit {
                reporter.count_metadata_cache_hit();
            }
            if outcome.lock_reused {
                reporter.reused_lock(&outcome.name, &outcome.resolved_version, outcome.depth);
            }
            if !outcome.compatible {
                reporter.complete_target();
                continue;
            }
            reporter.installed(
                &outcome.name,
                &outcome.resolved_version,
                outcome.dependencies.len(),
                outcome.depth,
            );

            state
                .installed_versions
                .insert(outcome.name.clone(), outcome.resolved_version.clone());
            state.installed_packages.insert(
                outcome.name.clone(),
                InstalledPackage {
                    version: outcome.resolved_version.clone(),
                    resolved: outcome.tarball_url,
                    dependencies: outcome.dependencies.clone(),
                },
            );

            next_frontier.extend(
                outcome
                    .dependencies
                    .into_iter()
                    .map(|(dep, req)| (dep, req, outcome.depth + 1)),
            );
        }

        frontier = next_frontier;
    }

    Ok(())
}

struct ResolveOutcome {
    name: String,
    requested: String,
    depth: usize,
    metadata_cache_hit: bool,
    lock_reused: bool,
    compatible: bool,
    resolved_version: String,
    tarball_url: String,
    dependencies: BTreeMap<String, String>,
}

fn install_resolved_packages_parallel(
    node_modules_dir: &Path,
    state: &InstallState,
    reporter: &mut InstallReporter,
) -> Result<(), String> {
    let items: Vec<(String, InstalledPackage)> = state
        .installed_packages
        .iter()
        .map(|(name, pkg)| (name.clone(), pkg.clone()))
        .collect();
    let cache_root = state.cache_root.clone();
    let node_modules_dir = node_modules_dir.to_path_buf();
    let cache_hits = AtomicUsize::new(0);
    let completed = AtomicUsize::new(0);

    items
        .par_iter()
        .try_for_each(|(package_name, pkg)| -> Result<(), String> {
            let cache_hit = install_package_files_cached(
                package_name,
                &pkg.version,
                &pkg.resolved,
                &node_modules_dir,
                &cache_root,
            )?;

            if cache_hit {
                cache_hits.fetch_add(1, Ordering::Relaxed);
            }
            completed.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })?;

    for _ in 0..cache_hits.load(Ordering::Relaxed) {
        reporter.count_tarball_cache_hit();
    }
    for _ in 0..completed.load(Ordering::Relaxed) {
        reporter.complete_target();
    }

    Ok(())
}

fn fetch_package_metadata_cached(
    package_name: &str,
    cache_root: &Path,
) -> Result<(Value, bool), String> {
    let cache_path = metadata_cache_path(cache_root, package_name);
    if cache_path.exists() {
        let raw = fs::read_to_string(&cache_path).map_err(|e| {
            format!(
                "Failed to read metadata cache {}: {}",
                cache_path.display(),
                e
            )
        })?;
        let json: Value = serde_json::from_str(&raw).map_err(|e| {
            format!(
                "Failed to parse metadata cache {}: {}",
                cache_path.display(),
                e
            )
        })?;
        return Ok((json, true));
    }

    let encoded = encode_registry_name(package_name);
    let url = format!("https://registry.npmjs.org/{}", encoded);

    let response = ureq::get(&url)
        .call()
        .map_err(|e| format!("Failed to fetch metadata for {}: {}", package_name, e))?;
    let mut body = String::new();
    response
        .into_reader()
        .read_to_string(&mut body)
        .map_err(|e| format!("Failed to read metadata for {}: {}", package_name, e))?;

    let json: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse metadata for {}: {}", package_name, e))?;

    if let Some(parent) = cache_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&cache_path, format!("{}\n", body));
    Ok((json, false))
}

fn resolve_version(
    metadata: &Value,
    requested: Option<&str>,
    locked_version: Option<&str>,
) -> Result<String, String> {
    let versions_obj = metadata
        .get("versions")
        .and_then(Value::as_object)
        .ok_or("Invalid package metadata: missing 'versions' object")?;

    if let Some(locked) = locked_version {
        if versions_obj.contains_key(locked)
            && version_satisfies_request(metadata, locked, requested)
        {
            return Ok(locked.to_string());
        }
    }

    if let Some(req) = requested {
        if versions_obj.contains_key(req) {
            return Ok(req.to_string());
        }

        if let Some(tag_version) = metadata
            .get("dist-tags")
            .and_then(Value::as_object)
            .and_then(|tags| tags.get(req))
            .and_then(Value::as_str)
        {
            return Ok(tag_version.to_string());
        }

        let mut matching: Vec<Version> = versions_obj
            .keys()
            .filter_map(|v| Version::parse(v).ok())
            .filter(|v| matches_npm_version_req(v, req))
            .collect();

        matching.sort();
        if let Some(max) = matching.last() {
            return Ok(max.to_string());
        }

        return Err(format!("No matching version found for '{}'", req));
    }

    metadata
        .get("dist-tags")
        .and_then(Value::as_object)
        .and_then(|tags| tags.get("latest"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or("Invalid package metadata: missing dist-tags.latest".to_string())
}

fn version_satisfies_request(metadata: &Value, version: &str, requested: Option<&str>) -> bool {
    let Some(req) = requested else {
        return true;
    };

    if req == version {
        return true;
    }

    if let Some(tag_version) = metadata
        .get("dist-tags")
        .and_then(Value::as_object)
        .and_then(|tags| tags.get(req))
        .and_then(Value::as_str)
    {
        if tag_version == version {
            return true;
        }
    }

    if let Ok(v) = Version::parse(version) {
        return matches_npm_version_req(&v, req);
    }

    false
}

fn matches_npm_version_req(version: &Version, req: &str) -> bool {
    let req = req.trim();
    if req.is_empty() {
        return false;
    }

    // npm allows OR-ranges: "1.x || 2.x"
    for alt in req.split("||").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        if let Some(normalized) = normalize_npm_hyphen_range(alt) {
            if let Ok(range) = VersionReq::parse(&normalized) {
                if range.matches(version) {
                    return true;
                }
            }
            continue;
        }

        if alt == "*" || alt.eq_ignore_ascii_case("x") {
            return true;
        }

        // First try semver directly for standard ranges (^, ~, >=, etc.)
        if let Ok(range) = VersionReq::parse(alt) {
            if range.matches(version) {
                return true;
            }
            continue;
        }

        // npm also allows comparator sets separated by whitespace:
        // ">= 2.1.2 < 3.0.0" (AND). semver crate expects comma-separated comparators.
        if let Some(normalized) = normalize_npm_comparator_set(alt) {
            if let Ok(range) = VersionReq::parse(&normalized) {
                if range.matches(version) {
                    return true;
                }
                continue;
            }
        }

        // Handle npm wildcard forms not accepted by semver crate (e.g. "1.x.x")
        if let Some(normalized) = normalize_npm_wildcard_range(alt) {
            if let Ok(range) = VersionReq::parse(&normalized) {
                if range.matches(version) {
                    return true;
                }
            }
        }
    }

    false
}

fn normalize_npm_wildcard_range(input: &str) -> Option<String> {
    let s = input.trim().trim_start_matches('v');

    if s == "*" || s.eq_ignore_ascii_case("x") {
        return Some("*".to_string());
    }

    let parts: Vec<&str> = s.split('.').collect();
    if parts.is_empty() {
        return None;
    }

    let is_wild = |p: &str| p.eq_ignore_ascii_case("x") || p == "*";

    let major: u64 = parts[0].parse().ok()?;

    // "1", "1.x", "1.x.x"
    if parts.len() == 1 || (parts.len() >= 2 && is_wild(parts[1])) {
        return Some(format!(">={major}.0.0, <{}.0.0", major + 1));
    }

    let minor: u64 = parts[1].parse().ok()?;

    // "1.2", "1.2.x"
    if parts.len() == 2 || (parts.len() >= 3 && is_wild(parts[2])) {
        return Some(format!(">={major}.{minor}.0, <{major}.{}.0", minor + 1));
    }

    if parts.len() >= 3 {
        let patch: u64 = parts[2].parse().ok()?;
        return Some(format!("={major}.{minor}.{patch}"));
    }

    None
}

fn normalize_npm_comparator_set(input: &str) -> Option<String> {
    let tokens: Vec<&str> = input.split_whitespace().collect();
    if tokens.len() < 2 {
        return None;
    }

    let is_op = |t: &str| matches!(t, ">" | ">=" | "<" | "<=" | "=");
    let starts_with_op = |t: &str| {
        t.starts_with(">=")
            || t.starts_with("<=")
            || t.starts_with('>')
            || t.starts_with('<')
            || t.starts_with('=')
    };

    let mut comparators: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < tokens.len() {
        let t = tokens[i];
        if is_op(t) {
            if i + 1 >= tokens.len() {
                return None;
            }
            comparators.push(format!("{}{}", t, tokens[i + 1]));
            i += 2;
            continue;
        }
        if starts_with_op(t) {
            comparators.push(t.to_string());
            i += 1;
            continue;
        }
        return None;
    }

    if comparators.len() >= 2 {
        Some(comparators.join(", "))
    } else {
        None
    }
}

fn normalize_npm_hyphen_range(input: &str) -> Option<String> {
    let parts: Vec<&str> = input.split(" - ").collect();
    if parts.len() != 2 {
        return None;
    }

    let left = parse_partial_version(parts[0].trim())?;
    let right = parse_partial_version(parts[1].trim())?;

    let lower = format!(">={}.{}.{}", left.major, left.minor, left.patch);
    let upper = match right.precision {
        1 => format!("<{}.0.0", right.major + 1),
        2 => format!("<{}.{}.0", right.major, right.minor + 1),
        _ => format!("<={}.{}.{}", right.major, right.minor, right.patch),
    };

    Some(format!("{}, {}", lower, upper))
}

struct PartialVersion {
    major: u64,
    minor: u64,
    patch: u64,
    precision: u8,
}

fn parse_partial_version(input: &str) -> Option<PartialVersion> {
    let s = input.trim().trim_start_matches('v');
    let segs: Vec<&str> = s.split('.').collect();
    if segs.is_empty() || segs.len() > 3 {
        return None;
    }

    let major = segs[0].parse().ok()?;
    let minor = if segs.len() >= 2 {
        segs[1].parse().ok()?
    } else {
        0
    };
    let patch = if segs.len() >= 3 {
        segs[2].parse().ok()?
    } else {
        0
    };

    Some(PartialVersion {
        major,
        minor,
        patch,
        precision: segs.len() as u8,
    })
}

fn get_tarball_url(metadata: &Value, version: &str, package_name: &str) -> Result<String, String> {
    metadata
        .get("versions")
        .and_then(Value::as_object)
        .and_then(|versions| versions.get(version))
        .and_then(Value::as_object)
        .and_then(|ver| ver.get("dist"))
        .and_then(Value::as_object)
        .and_then(|dist| dist.get("tarball"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "Package metadata missing tarball for {}@{}",
                package_name, version
            )
        })
}

fn get_dependencies_from_metadata(
    metadata: &Value,
    version: &str,
) -> Result<BTreeMap<String, String>, String> {
    let mut deps = metadata
        .get("versions")
        .and_then(Value::as_object)
        .and_then(|versions| versions.get(version))
        .and_then(Value::as_object)
        .and_then(|ver| ver.get("dependencies"))
        .map(|v| get_dependency_map(v, ""))
        .unwrap_or_default();

    let optional_deps = metadata
        .get("versions")
        .and_then(Value::as_object)
        .and_then(|versions| versions.get(version))
        .and_then(Value::as_object)
        .and_then(|ver| ver.get("optionalDependencies"))
        .map(|v| get_dependency_map(v, ""))
        .unwrap_or_default();

    for (name, req) in optional_deps {
        deps.entry(name).or_insert(req);
    }
    Ok(deps)
}

fn is_package_version_compatible(metadata: &Value, version: &str) -> Result<bool, String> {
    let ver_obj = metadata
        .get("versions")
        .and_then(Value::as_object)
        .and_then(|versions| versions.get(version))
        .and_then(Value::as_object)
        .ok_or_else(|| format!("Invalid package metadata: missing versions['{}']", version))?;

    if let Some(os_list) = ver_obj.get("os").and_then(Value::as_array) {
        if !matches_npm_constraint_list(os_list, current_npm_os()) {
            return Ok(false);
        }
    }

    if let Some(cpu_list) = ver_obj.get("cpu").and_then(Value::as_array) {
        if !matches_npm_constraint_list(cpu_list, current_npm_cpu()) {
            return Ok(false);
        }
    }

    Ok(true)
}

fn matches_npm_constraint_list(list: &[Value], current: &str) -> bool {
    let mut positives: Vec<&str> = Vec::new();
    let mut negatives: Vec<&str> = Vec::new();

    for item in list.iter().filter_map(Value::as_str) {
        let item = item.trim();
        if item.is_empty() {
            continue;
        }
        if item == "*" {
            positives.push(item);
            continue;
        }
        if let Some(rest) = item.strip_prefix('!') {
            negatives.push(rest.trim());
        } else {
            positives.push(item);
        }
    }

    if negatives.iter().any(|v| *v == current) {
        return false;
    }

    if positives.is_empty() {
        return true;
    }
    if positives.iter().any(|v| *v == "*") {
        return true;
    }
    positives.iter().any(|v| *v == current)
}

fn current_npm_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

fn current_npm_cpu() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "x86" => "ia32",
        "aarch64" => "arm64",
        other => other,
    }
}

fn install_package_files_cached(
    package_name: &str,
    version: &str,
    tarball_url: &str,
    node_modules_dir: &Path,
    cache_root: &Path,
) -> Result<bool, String> {
    let tarball_cache = tarball_cache_path(cache_root, tarball_url);
    let mut cache_hit = true;
    if !tarball_cache.exists() {
        cache_hit = false;
        download_to_file(tarball_url, &tarball_cache)?;
    }

    let temp_root = create_temp_dir(package_name)?;

    {
        let file = File::open(&tarball_cache).map_err(|e| {
            format!(
                "Failed to open cached tarball {}: {}",
                tarball_cache.display(),
                e
            )
        })?;
        let gz = GzDecoder::new(file);
        let mut archive = tar::Archive::new(gz);
        archive
            .unpack(&temp_root)
            .map_err(|e| format!("Failed to unpack {}@{}: {}", package_name, version, e))?;
    }

    let unpacked_package_dir = find_unpacked_root(&temp_root).ok_or_else(|| {
        format!(
            "Unexpected tarball layout for {}@{} (missing extracted package directory)",
            package_name, version
        )
    })?;

    let install_dir = node_modules_dir.join(package_name);
    if let Some(parent) = install_dir.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            format!(
                "Failed to create package directory {}: {}",
                parent.display(),
                e
            )
        })?;
    }

    if install_dir.exists() {
        fs::remove_dir_all(&install_dir).map_err(|e| {
            format!(
                "Failed to remove existing package directory {}: {}",
                install_dir.display(),
                e
            )
        })?;
    }

    match fs::rename(&unpacked_package_dir, &install_dir) {
        Ok(_) => {}
        Err(_) => {
            copy_dir_all(&unpacked_package_dir, &install_dir)?;
            fs::remove_dir_all(&unpacked_package_dir).map_err(|e| {
                format!(
                    "Failed to clean temp package directory {}: {}",
                    unpacked_package_dir.display(),
                    e
                )
            })?;
        }
    }

    fs::remove_dir_all(&temp_root).map_err(|e| {
        format!(
            "Failed to clean temp directory {}: {}",
            temp_root.display(),
            e
        )
    })?;

    Ok(cache_hit)
}

fn load_lockfile() -> Result<LockData, String> {
    let path = Path::new(LOCK_FILE);
    if !path.exists() {
        return Ok(LockData::default());
    }

    let raw =
        fs::read_to_string(path).map_err(|e| format!("Failed to read {}: {}", LOCK_FILE, e))?;
    let json: Value =
        serde_json::from_str(&raw).map_err(|e| format!("Failed to parse {}: {}", LOCK_FILE, e))?;

    let dependencies = get_dependency_map(&json, "dependencies");
    let dev_dependencies = get_dependency_map(&json, "devDependencies");

    let mut packages = BTreeMap::new();
    if let Some(obj) = json.get("packages").and_then(Value::as_object) {
        for (name, val) in obj {
            let Some(pkg_obj) = val.as_object() else {
                continue;
            };
            let version = pkg_obj
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let resolved = pkg_obj
                .get("resolved")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let deps = pkg_obj
                .get("dependencies")
                .map(|v| get_dependency_map(v, ""))
                .unwrap_or_default();

            if !version.is_empty() {
                packages.insert(
                    name.clone(),
                    LockPackage {
                        version,
                        resolved,
                        dependencies: deps,
                    },
                );
            }
        }
    }

    Ok(LockData {
        dependencies,
        dev_dependencies,
        packages,
    })
}

fn save_lockfile(lock: &LockData) -> Result<(), String> {
    let mut root = Map::new();
    root.insert("lockfileVersion".to_string(), Value::Number(1.into()));
    root.insert(
        "dependencies".to_string(),
        dependency_map_to_value(&lock.dependencies),
    );
    root.insert(
        "devDependencies".to_string(),
        dependency_map_to_value(&lock.dev_dependencies),
    );

    let mut packages_obj = Map::new();
    for (name, pkg) in &lock.packages {
        let mut pkg_obj = Map::new();
        pkg_obj.insert("version".to_string(), Value::String(pkg.version.clone()));
        pkg_obj.insert("resolved".to_string(), Value::String(pkg.resolved.clone()));
        pkg_obj.insert(
            "dependencies".to_string(),
            dependency_map_to_value(&pkg.dependencies),
        );
        packages_obj.insert(name.clone(), Value::Object(pkg_obj));
    }

    root.insert("packages".to_string(), Value::Object(packages_obj));

    let content = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("Failed to serialize {}: {}", LOCK_FILE, e))?;

    fs::write(LOCK_FILE, format!("{}\n", content))
        .map_err(|e| format!("Failed to write {}: {}", LOCK_FILE, e))
}

fn get_dependency_map(value: &Value, key: &str) -> BTreeMap<String, String> {
    let object = if key.is_empty() {
        value.as_object()
    } else {
        value.get(key).and_then(Value::as_object)
    };

    let mut deps = BTreeMap::new();
    if let Some(obj) = object {
        for (name, version) in obj {
            if let Some(v) = version.as_str() {
                deps.insert(name.clone(), v.to_string());
            }
        }
    }
    deps
}

fn dependency_map_to_value(map: &BTreeMap<String, String>) -> Value {
    let mut object = Map::new();
    for (name, version) in map {
        object.insert(name.clone(), Value::String(version.clone()));
    }
    Value::Object(object)
}

fn ensure_package_json() -> Result<(), String> {
    let path = Path::new("package.json");
    if path.exists() {
        return Ok(());
    }

    let project_name = std::env::current_dir()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "velox-project".to_string());

    let initial = format!(
        r#"{{
  "name": "{}",
  "version": "1.0.0",
  "type": "module"
}}
"#,
        project_name
    );

    fs::write(path, initial).map_err(|e| format!("Failed to create package.json: {}", e))
}

fn load_package_json() -> Result<Value, String> {
    let raw = fs::read_to_string("package.json")
        .map_err(|e| format!("Failed to read package.json: {}", e))?;
    serde_json::from_str(&raw).map_err(|e| format!("Failed to parse package.json: {}", e))
}

fn save_package_json(package_json: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(package_json)
        .map_err(|e| format!("Failed to serialize package.json: {}", e))?;
    fs::write("package.json", format!("{}\n", content))
        .map_err(|e| format!("Failed to write package.json: {}", e))
}

fn set_dependency(
    package_json: &mut Value,
    name: &str,
    version: &str,
    dev: bool,
) -> Result<(), String> {
    let obj = package_json
        .as_object_mut()
        .ok_or("package.json root must be a JSON object")?;

    let key = if dev {
        "devDependencies"
    } else {
        "dependencies"
    };

    let entry = obj
        .entry(key.to_string())
        .or_insert_with(|| Value::Object(Map::new()));

    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }

    let deps_obj = entry
        .as_object_mut()
        .ok_or_else(|| format!("{} must be an object", key))?;
    deps_obj.insert(name.to_string(), Value::String(version.to_string()));

    Ok(())
}

fn resolve_package_bin(package_name: &str, root: &Path) -> Result<PathBuf, String> {
    let package_json_path = root
        .join("node_modules")
        .join(package_name)
        .join("package.json");
    let raw = fs::read_to_string(&package_json_path).map_err(|e| {
        format!(
            "Failed to read package.json for {} ({}): {}",
            package_name,
            package_json_path.display(),
            e
        )
    })?;
    let json: Value = serde_json::from_str(&raw).map_err(|e| {
        format!(
            "Failed to parse package.json for {} ({}): {}",
            package_name,
            package_json_path.display(),
            e
        )
    })?;

    let rel_bin = match json.get("bin") {
        Some(Value::String(s)) => s.to_string(),
        Some(Value::Object(obj)) if !obj.is_empty() => {
            let preferred = package_short_name(package_name);
            obj.get(preferred)
                .and_then(Value::as_str)
                .or_else(|| obj.values().find_map(Value::as_str))
                .ok_or_else(|| format!("Package '{}' has invalid bin map", package_name))?
                .to_string()
        }
        _ => {
            return Err(format!(
                "Package '{}' does not expose a runnable binary (missing 'bin')",
                package_name
            ));
        }
    };

    let path = root.join("node_modules").join(package_name).join(rel_bin);
    if !path.exists() {
        return Err(format!(
            "Resolved binary for '{}' does not exist: {}",
            package_name,
            path.display()
        ));
    }
    Ok(path)
}

fn package_short_name(package_name: &str) -> &str {
    package_name.rsplit('/').next().unwrap_or(package_name)
}

fn build_bin_command(bin_path: &Path, args: &[String]) -> Result<Command, String> {
    match detect_bin_entry_kind(bin_path)? {
        BinEntryKind::NodeScript => {
            let mut cmd = Command::new("node");
            cmd.arg(bin_path);
            cmd.args(args);
            Ok(cmd)
        }
        BinEntryKind::VeloxScript => {
            let exe = std::env::current_exe()
                .map_err(|e| format!("Failed to resolve current velox executable: {}", e))?;
            let mut cmd = Command::new(exe);
            cmd.arg("run");
            cmd.arg(bin_path);
            cmd.args(args);
            Ok(cmd)
        }
        BinEntryKind::DirectExecutable => {
            let mut cmd = Command::new(bin_path);
            cmd.args(args);
            Ok(cmd)
        }
    }
}

enum BinEntryKind {
    NodeScript,
    VeloxScript,
    DirectExecutable,
}

fn detect_bin_entry_kind(path: &Path) -> Result<BinEntryKind, String> {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if matches!(ext, "ts" | "tsx") {
            return Ok(BinEntryKind::VeloxScript);
        }
        if matches!(ext, "js" | "mjs" | "cjs") {
            return Ok(BinEntryKind::NodeScript);
        }
    }

    let content = fs::read(path)
        .map_err(|e| format!("Failed to read entry script {}: {}", path.display(), e))?;
    if content.starts_with(b"#!") {
        let first_line_end = content
            .iter()
            .position(|b| *b == b'\n')
            .unwrap_or(content.len());
        let first_line = String::from_utf8_lossy(&content[..first_line_end]).to_ascii_lowercase();

        if first_line.contains("node") {
            return Ok(BinEntryKind::NodeScript);
        }
        if first_line.contains("velox") || first_line.contains("vlox") {
            return Ok(BinEntryKind::VeloxScript);
        }
    }

    Ok(BinEntryKind::DirectExecutable)
}

fn prepend_node_bin_to_path(cmd: &mut Command, bin_dir: &Path) {
    let key = "PATH";
    let existing = std::env::var_os(key).unwrap_or_default();
    let mut combined = std::ffi::OsString::new();
    combined.push(bin_dir.as_os_str());
    if !existing.is_empty() {
        combined.push(if cfg!(windows) { ";" } else { ":" });
        combined.push(existing);
    }
    cmd.env(key, combined);
}

fn setup_node_modules_bin(node_modules_dir: &Path, state: &InstallState) -> Result<(), String> {
    let bin_dir = node_modules_dir.join(".bin");
    fs::create_dir_all(&bin_dir)
        .map_err(|e| format!("Failed to create {}: {}", bin_dir.display(), e))?;

    let mut package_names: Vec<&str> = state.installed_packages.keys().map(String::as_str).collect();
    package_names.sort_unstable();

    for package_name in package_names {
        let package_json = load_installed_package_json(node_modules_dir, package_name)?;
        let bins = extract_package_bins(&package_json, package_name);
        let package_dir = node_modules_dir.join(package_name);

        for (bin_name, rel_target) in bins {
            let target = package_dir.join(rel_target);
            if !target.exists() {
                return Err(format!(
                    "Package '{}' declares bin '{}' -> '{}' but target does not exist",
                    package_name,
                    bin_name,
                    target.display()
                ));
            }
            create_bin_entry(&bin_dir, &bin_name, &target)?;
        }
    }

    Ok(())
}

fn run_postinstall_scripts(node_modules_dir: &Path, state: &InstallState) -> Result<(), String> {
    let mut postinstalls: Vec<(String, String, String, PathBuf)> = Vec::new();
    for (package_name, installed) in &state.installed_packages {
        let package_json = load_installed_package_json(node_modules_dir, package_name)?;
        let postinstall = package_json
            .get("scripts")
            .and_then(Value::as_object)
            .and_then(|scripts| scripts.get("postinstall"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());

        if let Some(script) = postinstall {
            postinstalls.push((
                package_name.clone(),
                installed.version.clone(),
                script.to_string(),
                node_modules_dir.join(package_name),
            ));
        }
    }

    if postinstalls.is_empty() {
        return Ok(());
    }

    postinstalls.sort_by(|a, b| a.0.cmp(&b.0));
    println!(
        "{}Found:{} {} package postinstall script(s)",
        colors::CYAN,
        colors::RESET,
        postinstalls.len()
    );

    let bin_dir = node_modules_dir.join(".bin");
    let mut approval = PostinstallApproval::from_env()?;

    for (package_name, version, script, package_dir) in postinstalls {
        let allowed = approval.approve(&package_name, &version, &script)?;
        if !allowed {
            println!(
                "{}Skipped:{} {}@{} postinstall",
                colors::YELLOW,
                colors::RESET,
                package_name,
                version
            );
            continue;
        }

        println!(
            "{}Running:{} {}@{} postinstall",
            colors::CYAN,
            colors::RESET,
            package_name,
            version
        );
        run_package_script(&package_name, &package_dir, &script, &bin_dir)?;
    }

    Ok(())
}

fn load_installed_package_json(node_modules_dir: &Path, package_name: &str) -> Result<Value, String> {
    let package_json_path = node_modules_dir.join(package_name).join("package.json");
    let raw = fs::read_to_string(&package_json_path).map_err(|e| {
        format!(
            "Failed to read package.json for {} ({}): {}",
            package_name,
            package_json_path.display(),
            e
        )
    })?;
    serde_json::from_str(&raw).map_err(|e| {
        format!(
            "Failed to parse package.json for {} ({}): {}",
            package_name,
            package_json_path.display(),
            e
        )
    })
}

fn extract_package_bins(package_json: &Value, package_name: &str) -> Vec<(String, String)> {
    match package_json.get("bin") {
        Some(Value::String(target)) => vec![(package_short_name(package_name).to_string(), target.to_string())],
        Some(Value::Object(map)) => map
            .iter()
            .filter_map(|(name, val)| val.as_str().map(|target| (name.clone(), target.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(unix)]
fn create_bin_entry(bin_dir: &Path, bin_name: &str, target: &Path) -> Result<(), String> {
    use std::os::unix::fs::symlink;

    let link_path = bin_dir.join(bin_name);
    remove_existing_path(&link_path)?;
    let absolute_target = fs::canonicalize(target).map_err(|e| {
        format!(
            "Failed to resolve bin target {}: {}",
            target.display(),
            e
        )
    })?;
    symlink(&absolute_target, &link_path).map_err(|e| {
        format!(
            "Failed to create bin symlink {} -> {}: {}",
            link_path.display(),
            absolute_target.display(),
            e
        )
    })?;
    Ok(())
}

#[cfg(windows)]
fn create_bin_entry(bin_dir: &Path, bin_name: &str, target: &Path) -> Result<(), String> {
    let cmd_path = bin_dir.join(format!("{}.cmd", bin_name));
    remove_existing_path(&cmd_path)?;
    let absolute_target = fs::canonicalize(target).map_err(|e| {
        format!(
            "Failed to resolve bin target {}: {}",
            target.display(),
            e
        )
    })?;
    let target_str = absolute_target.to_string_lossy().replace('"', "\"\"");
    let content = format!("@echo off\r\n\"{}\" %*\r\n", target_str);
    fs::write(&cmd_path, content)
        .map_err(|e| format!("Failed to write {}: {}", cmd_path.display(), e))?;
    Ok(())
}

fn remove_existing_path(path: &Path) -> Result<(), String> {
    if !path.exists() && fs::symlink_metadata(path).is_err() {
        return Ok(());
    }

    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Failed to inspect {}: {}", path.display(), e))?;
    if meta.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("Failed to remove {}: {}", path.display(), e))
    } else {
        fs::remove_file(path).map_err(|e| format!("Failed to remove {}: {}", path.display(), e))
    }
}

enum PostinstallApproval {
    AllowAll,
    DenyAll,
    Prompt,
}

impl PostinstallApproval {
    fn from_env() -> Result<Self, String> {
        let value = std::env::var("VELOX_PKG_POSTINSTALL")
            .ok()
            .map(|v| v.to_ascii_lowercase());
        match value.as_deref() {
            Some("1") | Some("true") | Some("allow") | Some("yes") => Ok(Self::AllowAll),
            Some("0") | Some("false") | Some("deny") | Some("no") => Ok(Self::DenyAll),
            Some(other) => Err(format!(
                "Invalid VELOX_PKG_POSTINSTALL='{}'. Use allow|deny|true|false|1|0",
                other
            )),
            None => Ok(Self::Prompt),
        }
    }

    fn approve(&mut self, package_name: &str, version: &str, script: &str) -> Result<bool, String> {
        match self {
            Self::AllowAll => Ok(true),
            Self::DenyAll => Ok(false),
            Self::Prompt => prompt_postinstall_approval(package_name, version, script).map(|choice| {
                match choice {
                    PromptChoice::Yes => true,
                    PromptChoice::No => false,
                    PromptChoice::All => {
                        *self = Self::AllowAll;
                        true
                    }
                    PromptChoice::None => {
                        *self = Self::DenyAll;
                        false
                    }
                }
            }),
        }
    }
}

enum PromptChoice {
    Yes,
    No,
    All,
    None,
}

fn prompt_postinstall_approval(
    package_name: &str,
    version: &str,
    script: &str,
) -> Result<PromptChoice, String> {
    if !std::io::stdin().is_terminal() {
        return Ok(PromptChoice::No);
    }

    println!(
        "{}Approve:{} run postinstall for {}@{}?",
        colors::YELLOW,
        colors::RESET,
        package_name,
        version
    );
    println!("  {}", script);

    loop {
        print!("  [y]es/[n]o/[a]ll/[x]none: ");
        std::io::stdout()
            .flush()
            .map_err(|e| format!("Failed to flush prompt: {}", e))?;

        let mut input = String::new();
        std::io::stdin()
            .read_line(&mut input)
            .map_err(|e| format!("Failed to read input: {}", e))?;
        match input.trim().to_ascii_lowercase().as_str() {
            "y" | "yes" => return Ok(PromptChoice::Yes),
            "n" | "no" => return Ok(PromptChoice::No),
            "a" | "all" => return Ok(PromptChoice::All),
            "x" | "none" => return Ok(PromptChoice::None),
            _ => {
                println!("Please answer y, n, a, or x.");
            }
        }
    }
}

fn run_package_script(
    package_name: &str,
    package_dir: &Path,
    script: &str,
    bin_dir: &Path,
) -> Result<(), String> {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(script);
        c
    } else {
        let mut c = Command::new("sh");
        c.arg("-c").arg(script);
        c
    };
    cmd.current_dir(package_dir);
    prepend_node_bin_to_path(&mut cmd, bin_dir);

    let status = cmd.status().map_err(|e| {
        format!(
            "Failed to execute postinstall for {} in {}: {}",
            package_name,
            package_dir.display(),
            e
        )
    })?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "postinstall failed for {} with exit code {}",
            package_name,
            status.code().unwrap_or(1)
        ))
    }
}

fn parse_package_request(input: &str) -> Result<(String, Option<String>), String> {
    if input.is_empty() {
        return Err("Package name cannot be empty".to_string());
    }

    if input.starts_with('@') {
        let slash = input
            .find('/')
            .ok_or_else(|| format!("Invalid scoped package '{}': expected @scope/name", input))?;

        let at_after_name = input[slash + 1..].rfind('@').map(|idx| idx + slash + 1);
        if let Some(at_idx) = at_after_name {
            let name = input[..at_idx].to_string();
            let version = input[at_idx + 1..].to_string();
            if version.is_empty() {
                return Err(format!("Invalid package spec '{}': empty version", input));
            }
            return Ok((name, Some(version)));
        }

        return Ok((input.to_string(), None));
    }

    if let Some(at_idx) = input.rfind('@') {
        let name = input[..at_idx].to_string();
        let version = input[at_idx + 1..].to_string();

        if name.is_empty() {
            return Err(format!("Invalid package spec '{}': empty name", input));
        }
        if version.is_empty() {
            return Err(format!("Invalid package spec '{}': empty version", input));
        }

        return Ok((name, Some(version)));
    }

    Ok((input.to_string(), None))
}

#[cfg(windows)]
fn compose_windows_script_command(script: &str, args: &[String]) -> String {
    if args.is_empty() {
        return script.to_string();
    }
    let escaped_args = args
        .iter()
        .map(|a| format!("\"{}\"", a.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{} {}", script, escaped_args)
}

#[cfg(not(windows))]
fn compose_unix_script_command(script: &str, args: &[String]) -> String {
    if args.is_empty() {
        return script.to_string();
    }
    let escaped_args = args
        .iter()
        .map(|a| format!("'{}'", a.replace('\'', "'\"'\"'")))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{} {}", script, escaped_args)
}

#[cfg(test)]
mod tests {
    use super::{matches_npm_version_req, parse_package_request, version_satisfies_request};
    use semver::Version;
    use serde_json::json;

    #[test]
    fn parse_unscoped() {
        let (name, version) = parse_package_request("hono@4.0.0").unwrap();
        assert_eq!(name, "hono");
        assert_eq!(version.as_deref(), Some("4.0.0"));
    }

    #[test]
    fn parse_scoped() {
        let (name, version) = parse_package_request("@types/node@20.11.0").unwrap();
        assert_eq!(name, "@types/node");
        assert_eq!(version.as_deref(), Some("20.11.0"));
    }

    #[test]
    fn parse_scoped_without_version() {
        let (name, version) = parse_package_request("@types/node").unwrap();
        assert_eq!(name, "@types/node");
        assert!(version.is_none());
    }

    #[test]
    fn version_match_semver_range() {
        let metadata = json!({
            "dist-tags": {"latest": "2.3.4"}
        });
        assert!(version_satisfies_request(
            &metadata,
            "2.3.4",
            Some("^2.0.0")
        ));
        assert!(!version_satisfies_request(
            &metadata,
            "1.9.9",
            Some("^2.0.0")
        ));
    }

    #[test]
    fn version_match_npm_or_x_range() {
        let v1 = Version::parse("1.5.0").unwrap();
        let v2 = Version::parse("2.9.1").unwrap();
        let v3 = Version::parse("3.0.0").unwrap();

        assert!(matches_npm_version_req(&v1, "1.x.x || 2.x.x"));
        assert!(matches_npm_version_req(&v2, "1.x.x || 2.x.x"));
        assert!(!matches_npm_version_req(&v3, "1.x.x || 2.x.x"));
    }

    #[test]
    fn version_match_npm_hyphen_range() {
        let v1 = Version::parse("1.4.0").unwrap();
        let v2 = Version::parse("2.9.1").unwrap();
        let v3 = Version::parse("3.0.0").unwrap();

        assert!(matches_npm_version_req(&v1, "1 - 2"));
        assert!(matches_npm_version_req(&v2, "1 - 2"));
        assert!(!matches_npm_version_req(&v3, "1 - 2"));
    }

    #[test]
    fn version_match_npm_space_comparator_set() {
        let inside = Version::parse("2.5.0").unwrap();
        let lower = Version::parse("2.1.2").unwrap();
        let upper = Version::parse("3.0.0").unwrap();

        assert!(matches_npm_version_req(&inside, ">= 2.1.2 < 3.0.0"));
        assert!(matches_npm_version_req(&lower, ">= 2.1.2 < 3.0.0"));
        assert!(!matches_npm_version_req(&upper, ">= 2.1.2 < 3.0.0"));
    }
}

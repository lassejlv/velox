use crate::colors;
use flate2::read::GzDecoder;
use semver::{Version, VersionReq};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::io::IsTerminal;
use std::io::Read;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

const LOCK_FILE: &str = "velox.lock";
const CACHE_ENV_VAR: &str = "VELOX_PKG_CACHE_DIR";
const METADATA_CACHE_DIR: &str = "metadata";
const TARBALL_CACHE_DIR: &str = "tarballs";

pub struct AddOptions {
    pub dev: bool,
    pub exact: bool,
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
    metadata_cache: HashMap<String, Value>,
    cache_root: PathBuf,
}

struct InstallReporter {
    start: Instant,
    installed_count: usize,
    lock_reused_count: usize,
    cache_reused_count: usize,
    resolved_count: usize,
    metadata_cache_hits: usize,
    tarball_cache_hits: usize,
    verbose: bool,
}

struct Spinner {
    stop: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
    message: String,
}

impl InstallReporter {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            installed_count: 0,
            lock_reused_count: 0,
            cache_reused_count: 0,
            resolved_count: 0,
            metadata_cache_hits: 0,
            tarball_cache_hits: 0,
            verbose: std::env::var("VELOX_PKG_VERBOSE")
                .ok()
                .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
                .unwrap_or(false),
        }
    }

    fn prefix(depth: usize) -> String {
        format!("{}{}", "  ".repeat(depth), colors::DIM)
    }

    fn resolving(&self, package_name: &str, requested: Option<&str>, depth: usize) {
        if !self.verbose && depth > 0 {
            return;
        }
        let requested = requested.unwrap_or("latest");
        println!(
            "{}{}resolve{} {} ({}){}",
            Self::prefix(depth),
            colors::CYAN,
            colors::RESET,
            package_name,
            requested,
            colors::RESET
        );
    }

    fn reused_lock(&mut self, package_name: &str, version: &str, depth: usize) {
        self.lock_reused_count += 1;
        if !self.verbose && depth > 0 {
            return;
        }
        println!(
            "{}{}lock{} {}@{}{}",
            Self::prefix(depth),
            colors::YELLOW,
            colors::RESET,
            package_name,
            version,
            colors::RESET
        );
    }

    fn reused_session(&self, package_name: &str, version: &str, depth: usize) {
        if !self.verbose && depth > 0 {
            return;
        }
        println!(
            "{}{}cache{} {}@{}{}",
            Self::prefix(depth),
            colors::CYAN,
            colors::RESET,
            package_name,
            version,
            colors::RESET
        );
    }

    fn installed(&mut self, package_name: &str, version: &str, dep_count: usize, depth: usize) {
        self.installed_count += 1;
        if !self.verbose && depth > 0 {
            return;
        }
        println!(
            "{}{}installed{} {}@{} {}(deps: {}){}",
            Self::prefix(depth),
            colors::GREEN,
            colors::RESET,
            package_name,
            version,
            colors::DIM,
            dep_count,
            colors::RESET
        );
    }

    fn summary(&self) {
        println!(
            "{}Done:{} {} package(s) installed, {} lock reuse(s), {} cache reuse(s), {} resolved, {} metadata cache hit(s), {} tarball cache hit(s) in {:.2}s",
            colors::BOLD,
            colors::RESET,
            self.installed_count,
            self.lock_reused_count,
            self.cache_reused_count,
            self.resolved_count,
            self.metadata_cache_hits,
            self.tarball_cache_hits,
            self.start.elapsed().as_secs_f64()
        );
        if !self.verbose {
            println!(
                "{}Tip:{} set VELOX_PKG_VERBOSE=1 for full dependency tree logs",
                colors::DIM,
                colors::RESET
            );
        }
    }

    fn count_resolve(&mut self) {
        self.resolved_count += 1;
    }

    fn count_cache_reuse(&mut self) {
        self.cache_reused_count += 1;
    }

    fn count_metadata_cache_hit(&mut self) {
        self.metadata_cache_hits += 1;
    }

    fn count_tarball_cache_hit(&mut self) {
        self.tarball_cache_hits += 1;
    }

    fn should_log(&self, depth: usize) -> bool {
        self.verbose || depth == 0
    }
}

impl Spinner {
    fn start(enabled: bool, message: &str) -> Self {
        if !enabled || !std::io::stderr().is_terminal() {
            return Self {
                stop: Arc::new(AtomicBool::new(true)),
                handle: None,
                message: message.to_string(),
            };
        }

        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop);
        let msg = message.to_string();
        let handle = thread::spawn(move || {
            let frames = ['|', '/', '-', '\\'];
            let mut i = 0usize;
            while !stop_clone.load(Ordering::Relaxed) {
                eprint!(
                    "\r{}{} {}{}",
                    colors::DIM,
                    msg,
                    frames[i % frames.len()],
                    colors::RESET
                );
                let _ = std::io::stderr().flush();
                i += 1;
                thread::sleep(std::time::Duration::from_millis(90));
            }
        });

        Self {
            stop,
            handle: Some(handle),
            message: message.to_string(),
        }
    }

    fn finish(mut self, success: bool) {
        if let Some(handle) = self.handle.take() {
            self.stop.store(true, Ordering::Relaxed);
            let _ = handle.join();
            let status = if success {
                format!("{}ok{}", colors::GREEN, colors::RESET)
            } else {
                format!("{}fail{}", colors::RED, colors::RESET)
            };
            eprintln!(
                "\r{}{} {}{}",
                colors::DIM,
                self.message,
                status,
                colors::RESET
            );
        }
    }
}

fn with_spinner<T, F>(enabled: bool, message: &str, work: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let spinner = Spinner::start(enabled, message);
    let result = work();
    spinner.finish(result.is_ok());
    result
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
        metadata_cache: HashMap::new(),
        cache_root,
    };
    let mut reporter = InstallReporter::new();

    for package in packages {
        let (name, requested) = parse_package_request(package)?;
        let resolved = install_recursive(
            &name,
            requested.as_deref(),
            node_modules_dir,
            &mut state,
            &mut reporter,
            0,
        )?;

        let record_version = if options.exact {
            resolved.clone()
        } else if let Some(req) = requested {
            req
        } else {
            format!("^{}", resolved)
        };

        set_dependency(&mut package_json, &name, &record_version, options.dev)?;
        println!(
            "{}tracked{} {} -> {}",
            colors::CYAN,
            colors::RESET,
            name,
            record_version
        );
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
        metadata_cache: HashMap::new(),
        cache_root,
    };
    let mut reporter = InstallReporter::new();

    for (name, req) in &root_deps {
        let _ = install_recursive(
            name,
            Some(req),
            node_modules_dir,
            &mut state,
            &mut reporter,
            0,
        )?;
    }

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
    print_dependency_tree(&root_deps, &state.installed_packages);
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

fn install_recursive(
    package_name: &str,
    requested: Option<&str>,
    node_modules_dir: &Path,
    state: &mut InstallState,
    reporter: &mut InstallReporter,
    depth: usize,
) -> Result<String, String> {
    reporter.count_resolve();
    reporter.resolving(package_name, requested, depth);

    if let Some(version) = state.installed_versions.get(package_name) {
        reporter.count_cache_reuse();
        reporter.reused_session(package_name, version, depth);
        return Ok(version.clone());
    }

    let metadata = fetch_package_metadata(package_name, state, reporter, depth)?;
    let locked = state.locked_versions.get(package_name).map(String::as_str);
    let resolved_version = resolve_version(&metadata, requested, locked)?;
    if matches!(locked, Some(v) if v == resolved_version) {
        reporter.reused_lock(package_name, &resolved_version, depth);
    }
    let tarball_url = get_tarball_url(&metadata, &resolved_version, package_name)?;

    install_package_files(
        package_name,
        &resolved_version,
        &tarball_url,
        node_modules_dir,
        state,
        reporter,
        depth,
    )?;

    state
        .installed_versions
        .insert(package_name.to_string(), resolved_version.clone());

    let dependencies = get_installed_dependencies(package_name, node_modules_dir)?;
    reporter.installed(package_name, &resolved_version, dependencies.len(), depth);

    state.installed_packages.insert(
        package_name.to_string(),
        InstalledPackage {
            version: resolved_version.clone(),
            resolved: tarball_url,
            dependencies: dependencies.clone(),
        },
    );

    for (dep_name, dep_req) in dependencies {
        let _ = install_recursive(
            &dep_name,
            Some(dep_req.as_str()),
            node_modules_dir,
            state,
            reporter,
            depth + 1,
        )?;
    }

    Ok(resolved_version)
}

fn fetch_package_metadata(
    package_name: &str,
    state: &mut InstallState,
    reporter: &mut InstallReporter,
    depth: usize,
) -> Result<Value, String> {
    if let Some(cached) = state.metadata_cache.get(package_name) {
        reporter.count_metadata_cache_hit();
        return Ok(cached.clone());
    }

    let cache_path = metadata_cache_path(&state.cache_root, package_name);
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
        state
            .metadata_cache
            .insert(package_name.to_string(), json.clone());
        reporter.count_metadata_cache_hit();
        return Ok(json);
    }

    let encoded = encode_registry_name(package_name);
    let url = format!("https://registry.npmjs.org/{}", encoded);

    let body = with_spinner(
        reporter.should_log(depth),
        &format!("fetch metadata {}", package_name),
        || {
            let response = ureq::get(&url)
                .call()
                .map_err(|e| format!("Failed to fetch metadata for {}: {}", package_name, e))?;

            let mut body = String::new();
            response
                .into_reader()
                .read_to_string(&mut body)
                .map_err(|e| format!("Failed to read metadata for {}: {}", package_name, e))?;
            Ok(body)
        },
    )?;

    let json: Value = serde_json::from_str(&body)
        .map_err(|e| format!("Failed to parse metadata for {}: {}", package_name, e))?;

    if let Some(parent) = cache_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&cache_path, format!("{}\n", body));
    state
        .metadata_cache
        .insert(package_name.to_string(), json.clone());

    Ok(json)
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

        if let Ok(version_req) = VersionReq::parse(req) {
            let mut matching: Vec<Version> = versions_obj
                .keys()
                .filter_map(|v| Version::parse(v).ok())
                .filter(|v| version_req.matches(v))
                .collect();

            matching.sort();
            if let Some(max) = matching.last() {
                return Ok(max.to_string());
            }
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

    if let (Ok(range), Ok(v)) = (VersionReq::parse(req), Version::parse(version)) {
        return range.matches(&v);
    }

    false
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

fn install_package_files(
    package_name: &str,
    version: &str,
    tarball_url: &str,
    node_modules_dir: &Path,
    state: &InstallState,
    reporter: &mut InstallReporter,
    depth: usize,
) -> Result<(), String> {
    let tarball_cache = tarball_cache_path(&state.cache_root, tarball_url);
    if !tarball_cache.exists() {
        let msg = format!("download {}@{}", package_name, version);
        with_spinner(reporter.should_log(depth), &msg, || {
            download_to_file(tarball_url, &tarball_cache)
        })?;
    } else {
        reporter.count_tarball_cache_hit();
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

    Ok(())
}

fn get_installed_dependencies(
    package_name: &str,
    node_modules_dir: &Path,
) -> Result<BTreeMap<String, String>, String> {
    let package_json_path = node_modules_dir.join(package_name).join("package.json");
    if !package_json_path.exists() {
        return Ok(BTreeMap::new());
    }

    let content = fs::read_to_string(&package_json_path).map_err(|e| {
        format!(
            "Failed to read installed package.json {}: {}",
            package_json_path.display(),
            e
        )
    })?;

    let json: Value = serde_json::from_str(&content).map_err(|e| {
        format!(
            "Failed to parse installed package.json {}: {}",
            package_json_path.display(),
            e
        )
    })?;

    Ok(get_dependency_map(&json, "dependencies"))
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
    if is_javascript_entry(bin_path)? {
        let mut cmd = Command::new("node");
        cmd.arg(bin_path);
        cmd.args(args);
        return Ok(cmd);
    }

    let mut cmd = Command::new(bin_path);
    cmd.args(args);
    Ok(cmd)
}

fn is_javascript_entry(path: &Path) -> Result<bool, String> {
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if matches!(ext, "js" | "mjs" | "cjs") {
            return Ok(true);
        }
    }

    let content = fs::read(path)
        .map_err(|e| format!("Failed to read entry script {}: {}", path.display(), e))?;
    if content.starts_with(b"#!") {
        let first_line_end = content
            .iter()
            .position(|b| *b == b'\n')
            .unwrap_or(content.len());
        let first_line = String::from_utf8_lossy(&content[..first_line_end]);
        if first_line.contains("node") {
            return Ok(true);
        }
    }
    Ok(false)
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

fn print_dependency_tree(
    roots: &BTreeMap<String, String>,
    installed: &HashMap<String, InstalledPackage>,
) {
    println!("\nDependency tree:");
    let root_names: Vec<String> = roots.keys().cloned().collect();
    for (i, name) in root_names.iter().enumerate() {
        let last = i + 1 == root_names.len();
        let mut trail = vec![name.clone()];
        print_tree_node(name, "", last, installed, &mut trail);
    }
}

fn print_tree_node(
    name: &str,
    prefix: &str,
    is_last: bool,
    installed: &HashMap<String, InstalledPackage>,
    trail: &mut Vec<String>,
) {
    let connector = if is_last { "`- " } else { "|- " };
    if let Some(pkg) = installed.get(name) {
        println!("{}{}{}@{}", prefix, connector, name, pkg.version);
        let next_prefix = if is_last {
            format!("{}   ", prefix)
        } else {
            format!("{}|  ", prefix)
        };

        let deps: Vec<String> = pkg.dependencies.keys().cloned().collect();
        for (i, dep) in deps.iter().enumerate() {
            let dep_last = i + 1 == deps.len();
            if trail.iter().any(|x| x == dep) {
                let cyc = if dep_last { "`- " } else { "|- " };
                println!("{}{}{} (cycle)", next_prefix, cyc, dep);
                continue;
            }
            trail.push(dep.clone());
            print_tree_node(dep, &next_prefix, dep_last, installed, trail);
            trail.pop();
        }
    } else {
        println!("{}{}{} (missing)", prefix, connector, name);
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

fn encode_registry_name(name: &str) -> String {
    name.replace('/', "%2F")
}

fn ensure_cache_dirs() -> Result<PathBuf, String> {
    let root = cache_root();
    fs::create_dir_all(root.join(METADATA_CACHE_DIR))
        .map_err(|e| format!("Failed to create metadata cache dir: {}", e))?;
    fs::create_dir_all(root.join(TARBALL_CACHE_DIR))
        .map_err(|e| format!("Failed to create tarball cache dir: {}", e))?;
    Ok(root)
}

fn cache_root() -> PathBuf {
    if let Ok(path) = std::env::var(CACHE_ENV_VAR) {
        return PathBuf::from(path);
    }
    if let Ok(home) = std::env::var("HOME") {
        return Path::new(&home).join(".cache").join("velox").join("pkg");
    }
    std::env::temp_dir().join("velox-pkg-cache")
}

fn metadata_cache_path(cache_root: &Path, package_name: &str) -> PathBuf {
    let encoded = encode_registry_name(package_name).replace('%', "_");
    cache_root
        .join(METADATA_CACHE_DIR)
        .join(format!("{}.json", encoded))
}

fn tarball_cache_path(cache_root: &Path, tarball_url: &str) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    tarball_url.hash(&mut hasher);
    let digest = hasher.finish();
    cache_root
        .join(TARBALL_CACHE_DIR)
        .join(format!("{:016x}.tgz", digest))
}

fn x_cache_dir_for_spec(cache_root: &Path, package_spec: &str) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    package_spec.hash(&mut hasher);
    let digest = hasher.finish();
    cache_root.join("x").join(format!("{:016x}", digest))
}

fn download_to_file(url: &str, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cache parent {}: {}", parent.display(), e))?;
    }

    let response = ureq::get(url)
        .call()
        .map_err(|e| format!("Failed to download tarball {}: {}", url, e))?;
    let mut reader = response.into_reader();

    let tmp = target.with_extension("tgz.part");
    let mut out = File::create(&tmp)
        .map_err(|e| format!("Failed to create temp cache file {}: {}", tmp.display(), e))?;
    std::io::copy(&mut reader, &mut out)
        .map_err(|e| format!("Failed to write tarball cache {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, target).map_err(|e| {
        format!(
            "Failed to finalize tarball cache {} -> {}: {}",
            tmp.display(),
            target.display(),
            e
        )
    })?;
    Ok(())
}

fn create_temp_dir(package_name: &str) -> Result<PathBuf, String> {
    let sanitized = package_name.replace('/', "_").replace('@', "");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let path = std::env::temp_dir().join(format!("velox-pkg-{}-{}", sanitized, nanos));
    fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create temp directory {}: {}", path.display(), e))?;
    Ok(path)
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create destination {}: {}", dst.display(), e))?;

    for entry in
        fs::read_dir(src).map_err(|e| format!("Failed to read source {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    entry.path().display(),
                    target.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn find_unpacked_root(temp_root: &Path) -> Option<PathBuf> {
    let standard = temp_root.join("package");
    if standard.exists() && standard.is_dir() {
        return Some(standard);
    }

    let mut dirs = fs::read_dir(temp_root)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_type().ok().filter(|t| t.is_dir()).map(|_| e.path()))
        .collect::<Vec<_>>();

    if dirs.len() == 1 {
        return dirs.pop();
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{parse_package_request, version_satisfies_request};
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
}

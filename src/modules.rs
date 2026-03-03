//! ES Module System for Velox
//!
//! Implements ES module loading with import/export support.

use crate::pkg;
use crate::transpiler;
use rusty_v8 as v8;
use serde_json::Value;
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

thread_local! {
    /// Cache of compiled modules by absolute path
    static MODULE_CACHE: RefCell<HashMap<String, v8::Global<v8::Module>>> = RefCell::new(HashMap::new());

    /// The base directory for resolving relative imports
    static BASE_DIR: RefCell<Option<PathBuf>> = RefCell::new(None);

    /// Track the main module path
    static MAIN_MODULE_PATH: RefCell<Option<String>> = RefCell::new(None);

    /// Import map: bare specifier -> path mapping
    static IMPORT_MAP: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
}

/// Load an import map from a JSON file
pub fn load_import_map(path: &Path) -> Result<(), String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read import map '{}': {}", path.display(), e))?;

    let json: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse import map: {}", e))?;

    let imports = json
        .get("imports")
        .and_then(|v| v.as_object())
        .ok_or("Import map must have an 'imports' object")?;

    IMPORT_MAP.with(|map| {
        let mut map = map.borrow_mut();
        for (key, value) in imports {
            if let Some(path_str) = value.as_str() {
                map.insert(key.clone(), path_str.to_string());
            }
        }
    });

    Ok(())
}

/// Set import map entries directly
#[allow(dead_code)]
pub fn set_import_map(entries: HashMap<String, String>) {
    IMPORT_MAP.with(|map| {
        *map.borrow_mut() = entries;
    });
}

/// Clear the import map
#[allow(dead_code)]
pub fn clear_import_map() {
    IMPORT_MAP.with(|map| map.borrow_mut().clear());
}

/// Try to resolve a specifier using the import map
fn resolve_from_import_map(specifier: &str) -> Option<String> {
    IMPORT_MAP.with(|map| {
        let map = map.borrow();

        // First try exact match
        if let Some(path) = map.get(specifier) {
            return Some(path.clone());
        }

        // Try prefix matching (for scoped packages like "@org/pkg/subpath")
        // Find the longest matching prefix
        let mut best_match: Option<(&str, &str)> = None;
        for (key, value) in map.iter() {
            if key.ends_with('/') && specifier.starts_with(key) {
                if best_match.is_none() || key.len() > best_match.unwrap().0.len() {
                    best_match = Some((key, value));
                }
            }
        }

        if let Some((prefix, replacement)) = best_match {
            let suffix = &specifier[prefix.len()..];
            return Some(format!("{}{}", replacement, suffix));
        }

        None
    })
}

/// Set the base directory for module resolution
pub fn set_base_dir(path: &Path) {
    let dir = if path.is_file() {
        path.parent().unwrap_or(path).to_path_buf()
    } else {
        path.to_path_buf()
    };
    BASE_DIR.with(|b| *b.borrow_mut() = Some(dir));
}

/// Get the base directory
fn get_base_dir() -> PathBuf {
    BASE_DIR.with(|b| {
        b.borrow()
            .clone()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
    })
}

/// Resolve a module specifier to an absolute path
fn resolve_module_path(specifier: &str, referrer_path: &str) -> Result<PathBuf, String> {
    // First, check the import map for bare specifiers
    if let Some(mapped) = resolve_from_import_map(specifier) {
        // The mapped value could be relative or absolute
        // If it starts with ./ or ../, resolve relative to base dir
        // Otherwise treat as-is
        if mapped.starts_with("./") || mapped.starts_with("../") {
            let base = get_base_dir();
            let resolved = base.join(&mapped);
            return resolve_with_extensions(&resolved);
        } else if mapped.starts_with('/') {
            return resolve_with_extensions(Path::new(&mapped));
        } else {
            // Could be a URL in the future, for now treat as relative to base
            let base = get_base_dir();
            let resolved = base.join(&mapped);
            return resolve_with_extensions(&resolved);
        }
    }

    let specifier_path = Path::new(specifier);

    // Handle relative imports (./foo, ../bar)
    if specifier.starts_with("./") || specifier.starts_with("../") {
        let referrer = Path::new(referrer_path);
        let base = if referrer.is_file() {
            referrer.parent().unwrap_or(referrer)
        } else {
            referrer
        };
        let resolved = base.join(specifier_path);
        return resolve_with_extensions(&resolved);
    }

    // Handle absolute imports (/path/to/file)
    if specifier.starts_with('/') {
        return resolve_with_extensions(specifier_path);
    }

    // Handle bare imports - try node_modules resolution
    if let Ok(path) = resolve_node_modules(specifier, referrer_path) {
        return Ok(path);
    }

    // Fallback: try relative to base
    let base = get_base_dir();
    let resolved = base.join(specifier_path);
    resolve_with_extensions(&resolved)
}

/// Try to resolve a path, adding extensions if needed (.ts, .js, /index.ts, /index.js)
fn resolve_with_extensions(path: &Path) -> Result<PathBuf, String> {
    // If the path already exists with extension, use it
    if path.exists() && path.is_file() {
        return Ok(path.canonicalize().unwrap_or_else(|_| path.to_path_buf()));
    }

    // Try adding extensions
    let extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".json"];
    for ext in &extensions {
        let with_ext = path.with_extension(&ext[1..]); // Remove leading dot
        if with_ext.exists() && with_ext.is_file() {
            return Ok(with_ext.canonicalize().unwrap_or(with_ext));
        }
        // Also try appending the extension (for paths like "./foo" -> "./foo.ts")
        let path_str = path.to_string_lossy();
        let appended = PathBuf::from(format!("{}{}", path_str, ext));
        if appended.exists() && appended.is_file() {
            return Ok(appended.canonicalize().unwrap_or(appended));
        }
    }

    // Try as directory with index file
    if path.is_dir() {
        for ext in &extensions {
            let index = path.join(format!("index{}", ext));
            if index.exists() && index.is_file() {
                return Ok(index.canonicalize().unwrap_or(index));
            }
        }
    }

    Err(format!("Cannot resolve module: {}", path.display()))
}

/// Resolve a bare specifier from node_modules
/// Walks up the directory tree looking for node_modules/<specifier>
fn resolve_node_modules(specifier: &str, referrer_path: &str) -> Result<PathBuf, String> {
    resolve_node_modules_internal(specifier, referrer_path, true)
}

fn resolve_node_modules_internal(
    specifier: &str,
    referrer_path: &str,
    allow_auto_install: bool,
) -> Result<PathBuf, String> {
    let referrer = Path::new(referrer_path);
    let mut current_dir = if referrer.is_file() {
        referrer.parent().map(|p| p.to_path_buf())
    } else {
        Some(referrer.to_path_buf())
    };

    // Parse the specifier to handle scoped packages (@org/pkg) and subpaths
    let (package_name, subpath) = parse_package_specifier(specifier);

    while let Some(dir) = current_dir {
        let node_modules = dir.join("node_modules").join(&package_name);

        if node_modules.exists() {
            // If there's a subpath, resolve it directly
            if let Some(sub) = &subpath {
                let with_subpath = node_modules.join(sub);
                if let Ok(resolved) = resolve_with_extensions(&with_subpath) {
                    return Ok(resolved);
                }
            }

            // Try to read package.json to find the entry point
            let package_json = node_modules.join("package.json");
            if package_json.exists() {
                if let Ok(entry) = get_package_entry(&package_json) {
                    let entry_path = node_modules.join(&entry);
                    if let Ok(resolved) = resolve_with_extensions(&entry_path) {
                        return Ok(resolved);
                    }
                }
            }

            // Try index file as fallback
            if let Ok(resolved) = resolve_with_extensions(&node_modules) {
                return Ok(resolved);
            }
        }

        current_dir = dir.parent().map(|p| p.to_path_buf());
    }

    if allow_auto_install
        && should_auto_install_missing_deps()
        && auto_install_missing_package(&package_name, referrer_path)?
    {
        return resolve_node_modules_internal(specifier, referrer_path, false);
    }

    Err(format!(
        "Cannot find module '{}' in node_modules",
        specifier
    ))
}

/// Parse a package specifier into package name and optional subpath
/// e.g., "lodash/fp" -> ("lodash", Some("fp"))
/// e.g., "@org/pkg/sub" -> ("@org/pkg", Some("sub"))
fn parse_package_specifier(specifier: &str) -> (String, Option<String>) {
    if specifier.starts_with('@') {
        // Scoped package: @org/pkg or @org/pkg/subpath
        let parts: Vec<&str> = specifier.splitn(3, '/').collect();
        if parts.len() >= 2 {
            let package_name = format!("{}/{}", parts[0], parts[1]);
            let subpath = if parts.len() == 3 {
                Some(parts[2].to_string())
            } else {
                None
            };
            return (package_name, subpath);
        }
    } else {
        // Regular package: pkg or pkg/subpath
        let parts: Vec<&str> = specifier.splitn(2, '/').collect();
        if parts.len() == 2 {
            return (parts[0].to_string(), Some(parts[1].to_string()));
        }
        return (parts[0].to_string(), None);
    }
    (specifier.to_string(), None)
}

fn should_auto_install_missing_deps() -> bool {
    std::env::var("VELOX_AUTO_INSTALL")
        .ok()
        .map(|v| !(v == "0" || v.eq_ignore_ascii_case("false") || v.eq_ignore_ascii_case("off")))
        .unwrap_or(true)
}

fn auto_install_missing_package(package_name: &str, referrer_path: &str) -> Result<bool, String> {
    let referrer = Path::new(referrer_path);
    let start_dir = if referrer.is_file() {
        referrer.parent().unwrap_or(referrer)
    } else {
        referrer
    };

    let Some(project_root) = find_project_root(start_dir) else {
        return Ok(false);
    };

    eprintln!("Auto-installing missing dependency '{}'", package_name);
    let already_declared = dependency_declared_in_package_json(&project_root, package_name)?;
    let original_cwd =
        std::env::current_dir().map_err(|e| format!("Failed to read current directory: {}", e))?;

    let install_result = (|| -> Result<(), String> {
        std::env::set_current_dir(&project_root)
            .map_err(|e| format!("Failed to enter project root: {}", e))?;

        if already_declared {
            pkg::install_from_package_json(true)
        } else {
            pkg::add_packages(
                &[package_name.to_string()],
                pkg::AddOptions {
                    dev: false,
                    exact: false,
                },
            )
        }
    })();

    let restore_result = std::env::set_current_dir(&original_cwd)
        .map_err(|e| format!("Failed to restore current directory: {}", e));

    if let Err(e) = restore_result {
        return Err(e);
    }

    install_result.map(|_| true)
}

fn find_project_root(start_dir: &Path) -> Option<PathBuf> {
    let mut current = Some(start_dir.to_path_buf());
    while let Some(dir) = current {
        if dir.join("package.json").exists() {
            return Some(dir);
        }
        current = dir.parent().map(|p| p.to_path_buf());
    }
    None
}

fn dependency_declared_in_package_json(project_root: &Path, package_name: &str) -> Result<bool, String> {
    let path = project_root.join("package.json");
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let json: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;

    let in_deps = json
        .get("dependencies")
        .and_then(Value::as_object)
        .map(|deps| deps.contains_key(package_name))
        .unwrap_or(false);
    let in_dev_deps = json
        .get("devDependencies")
        .and_then(Value::as_object)
        .map(|deps| deps.contains_key(package_name))
        .unwrap_or(false);

    Ok(in_deps || in_dev_deps)
}

/// Get the entry point from a package.json
fn get_package_entry(package_json_path: &Path) -> Result<String, String> {
    let content = std::fs::read_to_string(package_json_path)
        .map_err(|e| format!("Failed to read package.json: {}", e))?;

    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse package.json: {}", e))?;

    // Try "exports" first (modern packages)
    if let Some(exports) = json.get("exports") {
        // Handle string exports
        if let Some(entry) = exports.as_str() {
            return Ok(entry.to_string());
        }
        // Handle object exports with "." entry
        if let Some(obj) = exports.as_object() {
            if let Some(default) = obj.get(".") {
                // Could be string or object with "import"/"require"/"default"
                if let Some(entry) = default.as_str() {
                    return Ok(entry.to_string());
                }
                if let Some(obj) = default.as_object() {
                    // Try "import" first (ESM), then "default"
                    for key in ["import", "default", "require"] {
                        if let Some(entry) = obj.get(key).and_then(|v| v.as_str()) {
                            return Ok(entry.to_string());
                        }
                    }
                }
            }
        }
    }

    // Try "module" (ESM entry point)
    if let Some(module) = json.get("module").and_then(|v| v.as_str()) {
        return Ok(module.to_string());
    }

    // Try "main" (CommonJS, but might work)
    if let Some(main) = json.get("main").and_then(|v| v.as_str()) {
        return Ok(main.to_string());
    }

    // Default to index.js
    Ok("index.js".to_string())
}

fn should_wrap_commonjs_module(path: &str, source: &str) -> bool {
    if path.ends_with(".cjs") {
        return true;
    }

    if transpiler::is_typescript(path) || path.ends_with(".json") {
        return false;
    }

    if is_module_source(source) {
        return false;
    }

    source.contains("module.exports")
        || source.contains("exports.")
        || source.contains("require(")
        || source.contains("__esModule")
}

fn wrap_commonjs_as_esm(source: &str) -> String {
    format!(
        r#"
const __veloxCjs = globalThis.__veloxCjs || (globalThis.__veloxCjs = (() => {{
  const cache = new Map();
  const path = globalThis.Velox?.path;
  const fs = globalThis.Velox?.fs;

  if (!path || !fs) {{
    throw new Error("Velox.path and Velox.fs are required for CommonJS compatibility");
  }}

  const splitPackageSpecifier = (specifier) => {{
    if (specifier.startsWith("@")) {{
      const parts = specifier.split("/");
      const pkg = parts.slice(0, 2).join("/");
      const rest = parts.slice(2).join("/");
      return [pkg, rest || null];
    }}
    const parts = specifier.split("/");
    return [parts[0], parts.slice(1).join("/") || null];
  }};

  const tryResolveFile = (base) => {{
    const candidates = [
      `${{base}}.js`,
      `${{base}}.cjs`,
      `${{base}}.json`,
      path.join(base, "index.js"),
      path.join(base, "index.cjs"),
      path.join(base, "index.json"),
    ];
    if (fs.existsSync(base)) {{
      try {{
        const st = fs.statSync(base);
        if (st && st.isFile) return base;
      }} catch (_err) {{}}
    }}
    for (const candidate of candidates) {{
      if (fs.existsSync(candidate)) {{
        try {{
          const st = fs.statSync(candidate);
          if (st && st.isFile) return candidate;
        }} catch (_err) {{}}
      }}
    }}
    return null;
  }};

  const resolvePackageEntry = (pkgDir, subpath) => {{
    if (subpath) {{
      const withSub = tryResolveFile(path.join(pkgDir, subpath));
      if (withSub) return withSub;
    }}
    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (fs.existsSync(pkgJsonPath)) {{
      const raw = fs.readTextFileSync(pkgJsonPath);
      const pkg = JSON.parse(raw);
      if (typeof pkg.main === "string" && pkg.main.length > 0) {{
        const mainEntry = tryResolveFile(path.join(pkgDir, pkg.main));
        if (mainEntry) return mainEntry;
      }}
    }}
    return tryResolveFile(pkgDir);
  }};

  const resolveBare = (specifier, parentFilename) => {{
    const [pkgName, subpath] = splitPackageSpecifier(specifier);
    let dir = path.dirname(parentFilename);
    while (true) {{
      const pkgDir = path.join(dir, "node_modules", pkgName);
      if (fs.existsSync(pkgDir)) {{
        const resolved = resolvePackageEntry(pkgDir, subpath);
        if (resolved) return resolved;
      }}
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }}
    throw new Error(`Cannot resolve CommonJS module '${{specifier}}' from ${{parentFilename}}`);
  }};

  const resolve = (specifier, parentFilename) => {{
    if (
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier.startsWith("/")
    ) {{
      const base = specifier.startsWith("/")
        ? specifier
        : path.resolve(path.dirname(parentFilename), specifier);
      const resolved = tryResolveFile(base);
      if (resolved) return resolved;
      throw new Error(`Cannot resolve CommonJS module '${{specifier}}' from ${{parentFilename}}`);
    }}
    return resolveBare(specifier, parentFilename);
  }};

  const require = (specifier, parentFilename) => {{
    const normalized = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
    if (normalized === "fs") return globalThis.Velox.fs;
    if (normalized === "path") return globalThis.Velox.path;
    if (normalized === "process") return globalThis.process;
    if (normalized === "events") {{
      class EventEmitter {{
        constructor() {{ this._events = new Map(); }}
        on(name, fn) {{
          const list = this._events.get(name) || [];
          list.push(fn);
          this._events.set(name, list);
          return this;
        }}
        addListener(name, fn) {{ return this.on(name, fn); }}
        once(name, fn) {{
          const wrapped = (...args) => {{
            this.removeListener(name, wrapped);
            return fn.apply(this, args);
          }};
          return this.on(name, wrapped);
        }}
        off(name, fn) {{ return this.removeListener(name, fn); }}
        removeListener(name, fn) {{
          const list = this._events.get(name) || [];
          this._events.set(name, list.filter((cb) => cb !== fn));
          return this;
        }}
        removeAllListeners(name) {{
          if (typeof name === "undefined") this._events.clear();
          else this._events.delete(name);
          return this;
        }}
        emit(name, ...args) {{
          const list = this._events.get(name) || [];
          for (const fn of [...list]) fn.apply(this, args);
          return list.length > 0;
        }}
        listeners(name) {{
          return [...(this._events.get(name) || [])];
        }}
        setMaxListeners(_n) {{ return this; }}
      }}
      EventEmitter.defaultMaxListeners = 10;
      EventEmitter.EventEmitter = EventEmitter;
      return EventEmitter;
    }}

    const filename = resolve(normalized, parentFilename);
    if (cache.has(filename)) return cache.get(filename).exports;

    if (filename.endsWith(".json")) {{
      const module = {{ exports: JSON.parse(fs.readTextFileSync(filename)) }};
      cache.set(filename, module);
      return module.exports;
    }}

    const code = fs.readTextFileSync(filename);
    const module = {{ exports: {{}} }};
    cache.set(filename, module);

    const localRequire = (next) => require(next, filename);
    const __dirname = path.dirname(filename);
    const fn = new Function("require", "module", "exports", "__filename", "__dirname", code);
    fn(localRequire, module, module.exports, filename, __dirname);
    return module.exports;
  }};

  return {{ cache, require }};
}})());

const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const module = {{ exports: {{}} }};
const exports = module.exports;
const require = (specifier) => __veloxCjs.require(specifier, __filename);
{source}
const __velox_cjs_default = module.exports;
export default __velox_cjs_default;
"#
    )
}

/// Load and compile a module from file
fn load_module<'s>(
    scope: &mut v8::HandleScope<'s>,
    path: &Path,
) -> Result<v8::Local<'s, v8::Module>, String> {
    let path_str = path.to_string_lossy().to_string();

    // Check cache first
    let cached = MODULE_CACHE.with(|cache| {
        cache
            .borrow()
            .get(&path_str)
            .map(|g| v8::Local::new(scope, g.clone()))
    });

    if let Some(module) = cached {
        return Ok(module);
    }

    // Read source file
    let source = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read module '{}': {}", path_str, e))?;

    // Transpile if TypeScript
    let js_source = if transpiler::is_typescript(&path_str) {
        transpiler::transpile_typescript(&source, &path_str)?
    } else if path_str.ends_with(".json") {
        // Wrap JSON in export default
        format!("export default {};", source)
    } else {
        source
    };
    let js_source = if should_wrap_commonjs_module(&path_str, &js_source) {
        wrap_commonjs_as_esm(&js_source)
    } else {
        js_source
    };

    // Create source for compilation
    let code = v8::String::new(scope, &js_source).ok_or("Failed to create source string")?;
    let name = v8::String::new(scope, &path_str).unwrap();

    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        0,           // line offset
        0,           // column offset
        false,       // is shared cross origin
        0,           // script id
        name.into(), // source map url
        false,       // is opaque
        false,       // is wasm
        true,        // is module <-- IMPORTANT!
    );

    let source = v8::script_compiler::Source::new(code, Some(&origin));

    // Compile as module
    let module = v8::script_compiler::compile_module(scope, source)
        .ok_or_else(|| format!("Failed to compile module: {}", path_str))?;

    // Cache the module
    let global = v8::Global::new(scope, module);
    MODULE_CACHE.with(|cache| {
        cache.borrow_mut().insert(path_str, global);
    });

    Ok(module)
}

/// The resolve callback called by V8 when it encounters an import
fn resolve_module_callback<'a>(
    context: v8::Local<'a, v8::Context>,
    specifier: v8::Local<'a, v8::String>,
    _import_assertions: v8::Local<'a, v8::FixedArray>,
    referrer: v8::Local<'a, v8::Module>,
) -> Option<v8::Local<'a, v8::Module>> {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };

    let specifier_str = specifier.to_rust_string_lossy(scope);
    if is_node_builtin_specifier(&specifier_str) {
        return match load_builtin_module(scope, &specifier_str) {
            Ok(module) => Some(module),
            Err(e) => {
                let err = v8::String::new(scope, &e).unwrap();
                scope.throw_exception(err.into());
                None
            }
        };
    }

    // Get the referrer's path from the module cache
    // We need to find which path corresponds to this referrer module
    let referrer_path = MODULE_CACHE
        .with(|cache| {
            for (path, module) in cache.borrow().iter() {
                let local = v8::Local::new(scope, module.clone());
                if local.get_identity_hash() == referrer.get_identity_hash() {
                    return Some(path.clone());
                }
            }
            None
        })
        .unwrap_or_else(|| get_base_dir().to_string_lossy().to_string());

    // Resolve the module path
    let resolved_path = match resolve_module_path(&specifier_str, &referrer_path) {
        Ok(p) => p,
        Err(e) => {
            let err = v8::String::new(scope, &e).unwrap();
            scope.throw_exception(err.into());
            return None;
        }
    };

    // Load and compile the module
    match load_module(scope, &resolved_path) {
        Ok(module) => Some(module),
        Err(e) => {
            let err = v8::String::new(scope, &e).unwrap();
            scope.throw_exception(err.into());
            None
        }
    }
}

/// Execute a file as an ES module
pub fn execute_module<'s>(
    scope: &mut v8::HandleScope<'s>,
    filename: &str,
    source: &str,
) -> Result<v8::Local<'s, v8::Value>, String> {
    let path = Path::new(filename);
    let abs_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(path)
    };

    // Set base directory for imports
    set_base_dir(&abs_path);

    // Set this as the main module
    let path_str = abs_path.to_string_lossy().to_string();
    set_main_module(&path_str);

    // Transpile if TypeScript
    let js_source = if transpiler::is_typescript(filename) {
        transpiler::transpile_typescript(source, filename)?
    } else {
        source.to_string()
    };

    // Create source
    let path_str = abs_path.to_string_lossy().to_string();
    let code = v8::String::new(scope, &js_source).ok_or("Failed to create source string")?;
    let name = v8::String::new(scope, &path_str).unwrap();

    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        0,
        0,
        false,
        0,
        name.into(),
        false,
        false,
        true, // is module
    );

    let source = v8::script_compiler::Source::new(code, Some(&origin));

    // Compile the module
    let module = v8::script_compiler::compile_module(scope, source)
        .ok_or_else(|| format!("Failed to compile module: {}", filename))?;

    // Cache it
    let global = v8::Global::new(scope, module);
    MODULE_CACHE.with(|cache| {
        cache.borrow_mut().insert(path_str, global);
    });

    // Instantiate the module (this resolves imports)
    let result = module.instantiate_module(scope, resolve_module_callback);
    if result.is_none() || result == Some(false) {
        return Err("Failed to instantiate module".to_string());
    }

    // Evaluate the module
    let result = module.evaluate(scope).ok_or("Failed to evaluate module")?;

    // Check if module evaluation resulted in an error
    // Module status will be kErrored if there was a synchronous exception
    let status = module.get_status();
    if status == v8::ModuleStatus::Errored {
        let exception = module.get_exception();
        let msg = exception
            .to_string(scope)
            .map(|s| s.to_rust_string_lossy(scope))
            .unwrap_or_else(|| "Module evaluation failed".to_string());
        return Err(msg);
    }

    Ok(result)
}

/// Check if a source file uses ES module syntax
pub fn is_module_source(source: &str) -> bool {
    // Simple heuristic: check for import/export at the start of lines
    // Also check for import.meta usage
    // This is not 100% accurate but good enough for most cases
    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("import ")
            || trimmed.starts_with("import{")
            || trimmed.starts_with("export ")
            || trimmed.starts_with("export{")
            || trimmed.starts_with("export default")
        {
            return true;
        }
    }
    // Also check for import.meta anywhere in the source
    if source.contains("import.meta") {
        return true;
    }
    false
}

/// Clear the module cache
pub fn clear_cache() {
    MODULE_CACHE.with(|cache| cache.borrow_mut().clear());
}

/// Setup import.meta for a module
#[allow(dead_code)]
pub fn setup_import_meta<'s>(
    scope: &mut v8::HandleScope<'s>,
    filename: &str,
    is_main: bool,
) -> v8::Local<'s, v8::Object> {
    let import_meta = v8::Object::new(scope);

    // import.meta.url
    let url_key = v8::String::new(scope, "url").unwrap();
    let url_val = v8::String::new(scope, &format!("file://{}", filename)).unwrap();
    import_meta.set(scope, url_key.into(), url_val.into());

    // import.meta.main
    let main_key = v8::String::new(scope, "main").unwrap();
    let main_val = v8::Boolean::new(scope, is_main);
    import_meta.set(scope, main_key.into(), main_val.into());

    // import.meta.dirname
    let dirname_key = v8::String::new(scope, "dirname").unwrap();
    let dirname = Path::new(filename)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let dirname_val = v8::String::new(scope, &dirname).unwrap();
    import_meta.set(scope, dirname_key.into(), dirname_val.into());

    // import.meta.filename
    let filename_key = v8::String::new(scope, "filename").unwrap();
    let filename_val = v8::String::new(scope, filename).unwrap();
    import_meta.set(scope, filename_key.into(), filename_val.into());

    import_meta
}

/// Get the path for a module by looking it up in the cache by identity hash
fn get_module_path<'s>(
    scope: &mut v8::HandleScope<'s>,
    module: v8::Local<v8::Module>,
) -> Option<String> {
    MODULE_CACHE.with(|cache| {
        for (path, cached_module) in cache.borrow().iter() {
            let local = v8::Local::new(scope, cached_module.clone());
            if local.get_identity_hash() == module.get_identity_hash() {
                return Some(path.clone());
            }
        }
        None
    })
}

/// Check if a module is the main entry point
fn is_main_module(path: &str) -> bool {
    MAIN_MODULE_PATH.with(|main| main.borrow().as_ref().map(|m| m == path).unwrap_or(false))
}

/// Set the main module path
fn set_main_module(path: &str) {
    MAIN_MODULE_PATH.with(|main| {
        *main.borrow_mut() = Some(path.to_string());
    });
}

/// The import.meta callback - called by V8 when import.meta is accessed
pub extern "C" fn host_initialize_import_meta_object_callback(
    context: v8::Local<v8::Context>,
    module: v8::Local<v8::Module>,
    meta: v8::Local<v8::Object>,
) {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };

    // Find the module path from our cache
    let module_path = get_module_path(scope, module).unwrap_or_default();
    let is_main = is_main_module(&module_path);

    // import.meta.url
    let url_key = v8::String::new(scope, "url").unwrap();
    let url_val = v8::String::new(scope, &format!("file://{}", module_path)).unwrap();
    meta.set(scope, url_key.into(), url_val.into());

    // import.meta.main
    let main_key = v8::String::new(scope, "main").unwrap();
    let main_val = v8::Boolean::new(scope, is_main);
    meta.set(scope, main_key.into(), main_val.into());

    // import.meta.dirname
    let dirname_key = v8::String::new(scope, "dirname").unwrap();
    let dirname = Path::new(&module_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let dirname_val = v8::String::new(scope, &dirname).unwrap();
    meta.set(scope, dirname_key.into(), dirname_val.into());

    // import.meta.filename
    let filename_key = v8::String::new(scope, "filename").unwrap();
    let filename_val = v8::String::new(scope, &module_path).unwrap();
    meta.set(scope, filename_key.into(), filename_val.into());
}

/// The dynamic import callback - called by V8 when import() is used
pub extern "C" fn host_import_module_dynamically_callback(
    context: v8::Local<v8::Context>,
    referrer: v8::Local<v8::ScriptOrModule>,
    specifier: v8::Local<v8::String>,
    _import_assertions: v8::Local<v8::FixedArray>,
) -> *mut v8::Promise {
    let scope = &mut unsafe { v8::CallbackScope::new(context) };

    let specifier_str = specifier.to_rust_string_lossy(scope);

    // Create a promise resolver
    let resolver = match v8::PromiseResolver::new(scope) {
        Some(r) => r,
        None => return std::ptr::null_mut(),
    };
    let promise = resolver.get_promise(scope);

    if is_node_builtin_specifier(&specifier_str) {
        match load_builtin_module(scope, &specifier_str) {
            Ok(module) => {
                let namespace = module.get_module_namespace();
                resolver.resolve(scope, namespace);
                return &*promise as *const v8::Promise as *mut v8::Promise;
            }
            Err(e) => {
                let err_msg = v8::String::new(scope, &e).unwrap();
                let err = v8::Exception::error(scope, err_msg);
                resolver.reject(scope, err);
                return &*promise as *const v8::Promise as *mut v8::Promise;
            }
        }
    }

    // Get referrer path from the ScriptOrModule's resource name
    let referrer_resource = referrer.get_resource_name();
    let referrer_path = if referrer_resource.is_string() {
        referrer_resource.to_rust_string_lossy(scope)
    } else {
        get_base_dir().to_string_lossy().to_string()
    };

    // Resolve the module path
    let resolved_path = match resolve_module_path(&specifier_str, &referrer_path) {
        Ok(p) => p,
        Err(e) => {
            let err_msg = v8::String::new(scope, &e).unwrap();
            let err = v8::Exception::error(scope, err_msg);
            resolver.reject(scope, err);
            // Return the promise - we need to convert Local to raw pointer
            return &*promise as *const v8::Promise as *mut v8::Promise;
        }
    };

    // Load and compile the module
    let module = match load_module(scope, &resolved_path) {
        Ok(m) => m,
        Err(e) => {
            let err_msg = v8::String::new(scope, &e).unwrap();
            let err = v8::Exception::error(scope, err_msg);
            resolver.reject(scope, err);
            return &*promise as *const v8::Promise as *mut v8::Promise;
        }
    };

    // Instantiate the module
    let instantiate_result = module.instantiate_module(scope, resolve_module_callback);
    if instantiate_result.is_none() || instantiate_result == Some(false) {
        let err_msg = v8::String::new(scope, "Failed to instantiate module").unwrap();
        let err = v8::Exception::error(scope, err_msg);
        resolver.reject(scope, err);
        return &*promise as *const v8::Promise as *mut v8::Promise;
    }

    // Evaluate the module
    match module.evaluate(scope) {
        Some(_) => {
            // Get the module namespace (the exports)
            let namespace = module.get_module_namespace();
            resolver.resolve(scope, namespace);
        }
        None => {
            let err_msg = v8::String::new(scope, "Failed to evaluate module").unwrap();
            let err = v8::Exception::error(scope, err_msg);
            resolver.reject(scope, err);
        }
    }

    &*promise as *const v8::Promise as *mut v8::Promise
}

fn is_node_builtin_specifier(specifier: &str) -> bool {
    normalize_node_builtin_name(specifier).is_some()
}

fn normalize_node_builtin_name(specifier: &str) -> Option<&str> {
    let name = specifier.strip_prefix("node:").unwrap_or(specifier);
    match name {
        "fs" => Some("fs"),
        _ => None,
    }
}

fn builtin_module_cache_key(specifier: &str) -> String {
    format!("<velox:builtin:{}>", specifier)
}

fn builtin_module_source(specifier: &str) -> Option<String> {
    let name = normalize_node_builtin_name(specifier)?;
    match name {
        "fs" => Some(
            r#"
const fs = globalThis.Velox?.fs ?? {};
export default fs;
export const readFile = fs.readFile;
export const readFileSync = fs.readFileSync;
export const readTextFile = fs.readTextFile;
export const readTextFileSync = fs.readTextFileSync;
export const writeFile = fs.writeFile;
export const writeFileSync = fs.writeFileSync;
export const writeTextFile = fs.writeTextFile;
export const writeTextFileSync = fs.writeTextFileSync;
export const appendFile = fs.appendFile;
export const readDir = fs.readDir;
export const readDirSync = fs.readDirSync;
export const mkdir = fs.mkdir;
export const mkdirSync = fs.mkdirSync;
export const remove = fs.remove;
export const removeSync = fs.removeSync;
export const rename = fs.rename;
export const copy = fs.copy;
export const stat = fs.stat;
export const statSync = fs.statSync;
export const exists = fs.exists;
export const existsSync = fs.existsSync;
export const symlink = fs.symlink;
export const readLink = fs.readLink;
"#
            .trim()
            .to_string(),
        ),
        _ => None,
    }
}

fn load_builtin_module<'s>(
    scope: &mut v8::HandleScope<'s>,
    specifier: &str,
) -> Result<v8::Local<'s, v8::Module>, String> {
    let key = builtin_module_cache_key(specifier);
    let cached = MODULE_CACHE.with(|cache| {
        cache
            .borrow()
            .get(&key)
            .map(|g| v8::Local::new(scope, g.clone()))
    });
    if let Some(module) = cached {
        return Ok(module);
    }

    let source_code = builtin_module_source(specifier)
        .ok_or_else(|| format!("Unsupported Node builtin module '{}'", specifier))?;
    let code =
        v8::String::new(scope, &source_code).ok_or("Failed to create builtin module source")?;
    let name = v8::String::new(scope, &key).unwrap();

    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        0,
        0,
        false,
        0,
        name.into(),
        false,
        false,
        true,
    );
    let source = v8::script_compiler::Source::new(code, Some(&origin));
    let module = v8::script_compiler::compile_module(scope, source)
        .ok_or_else(|| format!("Failed to compile builtin module '{}'", specifier))?;

    let instantiate_result = module.instantiate_module(scope, resolve_module_callback);
    if instantiate_result.is_none() || instantiate_result == Some(false) {
        return Err(format!("Failed to instantiate builtin module '{}'", specifier));
    }

    let _ = module
        .evaluate(scope)
        .ok_or_else(|| format!("Failed to evaluate builtin module '{}'", specifier))?;

    let global = v8::Global::new(scope, module);
    MODULE_CACHE.with(|cache| {
        cache.borrow_mut().insert(key, global);
    });

    Ok(module)
}

//! A minimal ES module system implemented as a single-file bundler.
//!
//! JavaScriptCore's `JSEvaluateScript` does not understand ESM
//! `import`/`export` syntax — it throws a `SyntaxError` the moment it sees one.
//! So instead of feeding modules to JSC directly, we resolve the whole import
//! graph ahead of time, transpile every module to plain JS, rewrite all the
//! ESM statements into a tiny CommonJS-style module registry, and emit a single
//! self-contained script with **zero** `import`/`export` statements.
//!
//! The output looks roughly like:
//!
//! ```js
//! const __modules = {};
//! const __cache = {};
//! function require(id) { /* lazy init + cache */ }
//! __modules['0'] = function (module, exports, require) { /* module 0 */ };
//! __modules['1'] = function (module, exports, require) { /* module 1 */ };
//! require('0'); // the entry
//! ```
//!
//! ## Supported ESM forms
//!
//! Imports (relative specifiers only):
//!   - `import def from './m'`
//!   - `import { a, b as c } from './m'`
//!   - `import * as ns from './m'`
//!   - `import def, { a } from './m'` / `import def, * as ns from './m'`
//!   - `import './m'` (side-effect only)
//!
//! Exports:
//!   - `export const x = …` / `export let` / `export var`
//!   - `export function f() {}` / `export class C {}`
//!   - `export default <expr>` (and default function/class declarations)
//!   - `export { a, b as c }`
//!   - `export { a, b as c } from './m'` (re-export)
//!   - `export * from './m'` (re-export all)
//!   - `export * as ns from './m'`
//!
//! ## Known limitations
//!
//! ESM imports are hoisted and produce *live* bindings. This bundler emits the
//! `require(...)` glue **at the point of the import statement** using
//! `const`/`var` bindings, which is a pragmatic approximation: it handles the
//! common acyclic cases and keeps the cycle guard sound (cyclic imports always
//! terminate via CommonJS's partially-populated `exports`). The one rough edge
//! is import *cycles*: a named binding (`import { f } from './m'`) destructured
//! at the top of a module captures whatever `m`'s `exports` held at that
//! instant, so if the two modules call back into each other's not-yet-assigned
//! named exports it sees `undefined`. Namespace imports (`import * as m`) avoid
//! this because access is deferred to the live module object. We do not
//! reproduce true ESM live bindings or full hoisting.
//!
//! ## Bare specifiers / `node_modules`
//!
//! Bare specifiers (e.g. `import _ from "lodash"`) resolve Node CommonJS-style:
//! starting from the importer's directory we walk UP toward the filesystem
//! root, and at each ancestor `d` we look for `d/node_modules/<name>`. The
//! first hit wins. A specifier is split into a package name and an optional
//! subpath, where a leading `@scope/` is part of the name:
//!   - `lodash` -> (`lodash`, none)
//!   - `lodash/fp` -> (`lodash`, `fp`)
//!   - `@scope/pkg` -> (`@scope/pkg`, none)
//!   - `@scope/pkg/sub` -> (`@scope/pkg`, `sub`)
//!
//! With a subpath we resolve `<pkgDir>/<subpath>` using the very same
//! extension/`index` fallback as relative imports. Without a subpath we read
//! `<pkgDir>/package.json` and pick the entry: the `exports` `"."` target if
//! present, else `main`, else `index.js`; then the same extension/index
//! fallback is applied.
//!
//! The `exports` field is parsed with `serde_json` (`resolve_exports_target`):
//! a bare string, a `"."` subpath map, or a bare condition object. Conditions
//! are resolved in preference order `node`/`import`/`module`/`default`/`require`,
//! and unknown conditions real packages ship (`types`, `browser`,
//! `@zod/source`, …) are skipped; nested condition objects and array fallbacks
//! are handled. `main` is the fallback, then `index.js`.
//!
//! Both ESM- and CommonJS-authored packages run: every resolved module flows
//! through `crate::transpile::transpile`, and the bundler follows `require(...)`
//! and dynamic `import(...)` call graphs (via a `Visit` pass) the same way it
//! follows static `import`, so a CJS package's `module.exports`/relative
//! `require`s bundle correctly. Module wrappers are synchronous unless the module
//! uses top-level `await` (detected during the same pass) — so a synchronous
//! init error propagates through `require` instead of becoming a swallowed
//! promise rejection. Node builtins (`fs`, `path`, `node:*`, …) and any
//! unresolvable bare specifier produce a clear `ModuleError`. TypeScript
//! type-only imports/exports are stripped by the transpile step before we ever
//! see them (so unused type-only imports never reach resolution).

use std::collections::{BTreeSet, HashMap};
use std::fmt;
use std::path::{Path, PathBuf};

use oxc::allocator::Allocator;
use oxc::ast::ast::{
    Argument, ArrowFunctionExpression, AwaitExpression, CallExpression, Declaration,
    ExportDefaultDeclarationKind, Expression, ForOfStatement, Function, ImportDeclarationSpecifier,
    ImportExpression, ModuleExportName, Statement,
};
use oxc::ast_visit::{Visit, walk};
use oxc::parser::Parser;
use oxc::span::{SourceType, Span};
use oxc_resolver::{ResolveOptions, Resolver};

/// Walks an AST collecting `require('<literal>')` calls and dynamic
/// `import('<literal>')` expressions (so the bundler follows CommonJS `require`
/// and runtime `import()` the same way it follows static `import`), and notes
/// whether the module uses **top-level await** (an `await` not nested inside any
/// function), which decides whether its wrapper must be `async`.
/// Non-literal `require(expr)`/`import(expr)` is left alone (resolved at runtime).
#[derive(Default)]
struct RequireCollector {
    /// `require('x')` — span of the string-literal *argument* + its value.
    calls: Vec<(Span, String)>,
    /// `import('x')` — span of the *whole* expression + the specifier value.
    dynamic_imports: Vec<(Span, String)>,
    /// Nesting depth inside function bodies (top level is 0).
    fn_depth: u32,
    /// True if an `await` appears at the module's top level.
    has_top_level_await: bool,
}

impl<'a> Visit<'a> for RequireCollector {
    fn visit_call_expression(&mut self, call: &CallExpression<'a>) {
        if let Expression::Identifier(callee) = &call.callee
            && callee.name == "require"
            && call.arguments.len() == 1
            && let Argument::StringLiteral(lit) = &call.arguments[0]
        {
            self.calls.push((lit.span, lit.value.to_string()));
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_import_expression(&mut self, import: &ImportExpression<'a>) {
        if let Expression::StringLiteral(lit) = &import.source {
            self.dynamic_imports
                .push((import.span, lit.value.to_string()));
        }
        walk::walk_import_expression(self, import);
    }

    // Track function nesting so only *top-level* awaits flip the flag.
    fn visit_function(&mut self, func: &Function<'a>, flags: oxc::semantic::ScopeFlags) {
        self.fn_depth += 1;
        walk::walk_function(self, func, flags);
        self.fn_depth -= 1;
    }
    fn visit_arrow_function_expression(&mut self, arrow: &ArrowFunctionExpression<'a>) {
        self.fn_depth += 1;
        walk::walk_arrow_function_expression(self, arrow);
        self.fn_depth -= 1;
    }
    fn visit_await_expression(&mut self, await_expr: &AwaitExpression<'a>) {
        if self.fn_depth == 0 {
            self.has_top_level_await = true;
        }
        walk::walk_await_expression(self, await_expr);
    }
    // `for await (… of …)` at the top level also requires an async wrapper.
    fn visit_for_of_statement(&mut self, stmt: &ForOfStatement<'a>) {
        if self.fn_depth == 0 && stmt.r#await {
            self.has_top_level_await = true;
        }
        walk::walk_for_of_statement(self, stmt);
    }
}

/// Everything that can go wrong while bundling.
#[derive(Debug)]
pub enum ModuleError {
    /// A module file could not be found on disk (after trying all extensions).
    NotFound {
        /// The specifier as written in the source (e.g. `./math`).
        specifier: String,
        /// The file that contained the import.
        importer: PathBuf,
    },
    /// A file existed but could not be read.
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    /// Transpiling or parsing a module produced diagnostics.
    Parse { path: PathBuf, message: String },
    /// An ESM construct we deliberately do not support.
    Unsupported { path: PathBuf, message: String },
    /// A bare specifier referring to a Node built-in module (e.g. `fs`,
    /// `path`, `node:os`), which this runtime does not provide.
    Builtin {
        /// The specifier as written (e.g. `fs` or `node:path`).
        specifier: String,
        /// The file that contained the import.
        importer: PathBuf,
    },
}

impl fmt::Display for ModuleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ModuleError::NotFound {
                specifier,
                importer,
            } => write!(
                f,
                "cannot find module '{}' imported from {}",
                specifier,
                importer.display()
            ),
            ModuleError::Read { path, source } => {
                write!(f, "failed to read {}: {}", path.display(), source)
            }
            ModuleError::Parse { path, message } => {
                write!(f, "failed to parse {}:\n{}", path.display(), message)
            }
            ModuleError::Unsupported { path, message } => {
                write!(f, "unsupported syntax in {}: {}", path.display(), message)
            }
            ModuleError::Builtin {
                specifier,
                importer,
            } => write!(
                f,
                "cannot import Node built-in module '{}' (imported from {}): \
                 velox does not provide Node's standard library",
                specifier,
                importer.display()
            ),
        }
    }
}

impl std::error::Error for ModuleError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            ModuleError::Read { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// A single edit to the transpiled source: replace `[start, end)` with `text`.
/// Edits are applied right-to-left so earlier offsets stay valid.
struct Edit {
    start: u32,
    end: u32,
    text: String,
}

/// Resolve, transpile and rewrite the whole import graph rooted at `entry`,
/// returning one runnable JavaScript string with no `import`/`export` left.
pub fn bundle(entry: &Path) -> Result<String, ModuleError> {
    Ok(bundle_with_deps(entry)?.0)
}

/// Like [`bundle`], but also returns every source file that went into the bundle
/// (the entry plus all transitively-resolved local modules) — for `--watch`.
pub fn bundle_with_deps(entry: &Path) -> Result<(String, Vec<PathBuf>), ModuleError> {
    let entry = absolutize(entry);
    let mut graph = Graph::default();
    let entry_id = graph.load(&entry)?;
    let js = graph.emit(entry_id);
    Ok((js, graph.paths.clone()))
}

/// Like [`bundle`], but served from an on-disk cache when none of the source
/// files that went into the bundle have changed — skipping the resolve +
/// transpile + rewrite of the whole graph on repeat runs. Set `$VELOX_NO_CACHE`
/// to disable.
pub fn bundle_cached(entry: &Path) -> Result<String, ModuleError> {
    let entry = absolutize(entry);
    if std::env::var_os("VELOX_NO_CACHE").is_none()
        && let Some(js) = read_bundle_cache(&entry)
    {
        return Ok(js);
    }
    let (js, deps) = bundle_with_deps(&entry)?;
    write_bundle_cache(&entry, &js, &deps);
    Ok(js)
}

/// Make `entry` absolute (against cwd) and lexically normalized. oxc_resolver
/// needs an absolute base to walk `node_modules`.
fn absolutize(entry: &Path) -> PathBuf {
    let entry = if entry.is_absolute() {
        entry.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(entry)
    };
    normalize(&entry)
}

/// Directory holding cached bundles (`$VELOX_CACHE` or `~/.velox/cache`).
fn bundle_cache_dir() -> Option<PathBuf> {
    let base = match std::env::var_os("VELOX_CACHE") {
        Some(c) => PathBuf::from(c),
        None => PathBuf::from(std::env::var_os("HOME")?)
            .join(".velox")
            .join("cache"),
    };
    Some(base.join("bundles"))
}

/// Stable cache key for an absolute entry path.
fn bundle_cache_key(entry: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    entry.to_string_lossy().hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Modified-time of the running velox binary (so a rebuilt/upgraded velox
/// invalidates bundle caches even when the version string is unchanged).
fn velox_binary_mtime() -> Option<u64> {
    file_stamp(&std::env::current_exe().ok()?).map(|(mtime, _)| mtime)
}

/// (modified-time-nanos, size) for a source file, for cache validation.
fn file_stamp(path: &Path) -> Option<(u64, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let mtime = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos() as u64;
    Some((mtime, m.len()))
}

/// Return the cached bundle if every recorded dependency is unchanged and the
/// cache was written by this velox version.
fn read_bundle_cache(entry: &Path) -> Option<String> {
    let dir = bundle_cache_dir()?;
    let key = bundle_cache_key(entry);
    let meta_text = std::fs::read_to_string(dir.join(format!("{key}.meta"))).ok()?;
    let meta: serde_json::Value = serde_json::from_str(&meta_text).ok()?;
    // Invalidate if the cache format, velox version, or the velox binary itself
    // changed (the latter catches dev rebuilds + upgrades that keep the same
    // version string but bundle differently).
    if meta["version"].as_str() != Some(env!("CARGO_PKG_VERSION"))
        || meta["format"].as_u64() != Some(1)
        || meta["velox"].as_u64() != velox_binary_mtime()
    {
        return None;
    }
    let deps = meta["deps"].as_array()?;
    if deps.is_empty() {
        return None;
    }
    for d in deps {
        let path = d[0].as_str()?;
        let (mtime, size) = file_stamp(Path::new(path))?; // missing file → cache miss
        if d[1].as_u64() != Some(mtime) || d[2].as_u64() != Some(size) {
            return None;
        }
    }
    let js = std::fs::read_to_string(dir.join(format!("{key}.js"))).ok()?;
    // Restore the source-map table so stack frames still map on a cache hit.
    if let Ok(map) = std::fs::read_to_string(dir.join(format!("{key}.map"))) {
        crate::sourcemap::load_serialized(&map);
    }
    Some(js)
}

/// Persist the bundle and a manifest of its source files' stamps (best-effort).
fn write_bundle_cache(entry: &Path, js: &str, deps: &[PathBuf]) {
    let Some(dir) = bundle_cache_dir() else {
        return;
    };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let mut dep_json = Vec::with_capacity(deps.len());
    for d in deps {
        if let Some((mtime, size)) = file_stamp(d) {
            dep_json.push(serde_json::json!([d.to_string_lossy(), mtime, size]));
        }
    }
    let meta = serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "format": 1,
        "velox": velox_binary_mtime(),
        "deps": dep_json,
    });
    let key = bundle_cache_key(entry);
    let _ = std::fs::write(dir.join(format!("{key}.js")), js);
    let _ = std::fs::write(dir.join(format!("{key}.meta")), meta.to_string());
    // Persist the source-map table built during emit, for mapping on cache hits.
    let _ = std::fs::write(
        dir.join(format!("{key}.map")),
        crate::sourcemap::serialize_table(),
    );
}

/// The resolved module graph: a stable ordering of modules plus the rewritten
/// body for each.
#[derive(Default)]
struct Graph {
    /// Absolute, normalized path -> module id (index into `bodies`).
    ids: HashMap<PathBuf, usize>,
    /// Rewritten CommonJS bodies, indexed by module id.
    bodies: Vec<String>,
    /// Absolute source path for each module id (for `__dirname`/`__filename`).
    paths: Vec<PathBuf>,
    /// Whether each module needs an `async` wrapper (uses top-level await). Most
    /// modules don't — a sync wrapper lets synchronous init errors propagate
    /// through `require` instead of becoming a swallowed promise rejection.
    needs_async: Vec<bool>,
    /// Codegen source-map tokens for each module (empty when unavailable, e.g.
    /// coverage-instrumented or JSON modules), for stack-frame mapping.
    maps: Vec<crate::transpile::MapTokens>,
    /// Whether each module's body has an `__esModule` line prepended (shifts the
    /// body's line numbers by one vs the codegen output the map describes).
    esm: Vec<bool>,
    /// Canonical names of the `node:*` builtins to inject (transitive closure of
    /// what was imported), kept sorted for deterministic output.
    needed_builtins: BTreeSet<&'static str>,
}

/// Where a specifier resolves to.
enum Resolution {
    /// A file on disk.
    File(PathBuf),
    /// A supported Node builtin, by canonical name (e.g. `util`).
    Builtin(&'static str),
}

impl Graph {
    /// Ensure `path` (and everything it imports) is in the graph; return its id.
    ///
    /// Uses a `loaded` guard (the entry is reserved in `ids` *before* its
    /// dependencies are processed) so import cycles terminate. CommonJS makes
    /// cyclic imports safe at runtime via partially-populated `exports`.
    fn load(&mut self, path: &Path) -> Result<usize, ModuleError> {
        if let Some(&id) = self.ids.get(path) {
            return Ok(id);
        }

        // Reserve this module's id up front so cyclic imports resolve to it
        // instead of recursing forever.
        let id = self.bodies.len();
        self.ids.insert(path.to_path_buf(), id);
        self.bodies.push(String::new());
        self.paths.push(path.to_path_buf());
        self.needs_async.push(false);
        self.maps.push(Vec::new());
        self.esm.push(false);

        let source = std::fs::read_to_string(path).map_err(|source| ModuleError::Read {
            path: path.to_path_buf(),
            source,
        })?;
        // Strip a leading `#!` shebang (executable scripts / npm `bin` files) —
        // JSC rejects it. Keep the newline so reported line numbers don't shift.
        let source = strip_shebang(source);

        // A `.json` module exports its parsed contents (JSON is a subset of JS
        // object-literal syntax, so it's a valid right-hand side as-is).
        if path.extension().is_some_and(|e| e == "json") {
            self.bodies[id] = format!("module.exports = {};", source.trim());
            return Ok(id);
        }

        // Transpile FIRST: this strips TypeScript/JSX but keeps import/export
        // statements (oxc's codegen preserves them), so we can find and rewrite
        // them in the next step.
        let (js, tokens) = crate::coverage::instrument_or_transpile_mapped(path, &source).map_err(
            |diagnostics| ModuleError::Parse {
                path: path.to_path_buf(),
                message: format_diagnostics(&source, &diagnostics),
            },
        )?;

        let (body, needs_async, is_esm) = self.rewrite_module(path, &js)?;
        self.bodies[id] = body;
        self.needs_async[id] = needs_async;
        self.maps[id] = tokens;
        self.esm[id] = is_esm;
        Ok(id)
    }

    /// Parse the already-transpiled JS for `path`, collect span-based edits that
    /// turn ESM statements into CommonJS, and apply them.
    fn rewrite_module(
        &mut self,
        path: &Path,
        js: &str,
    ) -> Result<(String, bool, bool), ModuleError> {
        let allocator = Allocator::default();
        // The transpiled output is plain JS, but parsing it as a module is what
        // lets oxc surface the (preserved) import/export statements.
        let source_type = SourceType::mjs();
        let parsed = Parser::new(&allocator, js, source_type).parse();
        if !parsed.errors.is_empty() {
            return Err(ModuleError::Parse {
                path: path.to_path_buf(),
                message: format_diagnostics(js, &parsed.errors),
            });
        }

        let dir = path.parent().unwrap_or_else(|| Path::new("."));
        let mut edits: Vec<Edit> = Vec::new();

        for statement in &parsed.program.body {
            match statement {
                Statement::ImportDeclaration(decl) => {
                    let id = self.resolve_and_load(&decl.source.value, dir, path)?;
                    let replacement = rewrite_import(decl, &id);
                    edits.push(Edit {
                        start: decl.span.start,
                        end: decl.span.end,
                        text: replacement,
                    });
                }
                Statement::ExportNamedDeclaration(decl) => {
                    let replacement = if let Some(source) = &decl.source {
                        // Re-export: `export { a, b as c } from './m'`.
                        let id = self.resolve_and_load(&source.value, dir, path)?;
                        rewrite_reexport_named(decl, &id)
                    } else if let Some(declaration) = &decl.declaration {
                        // `export const x = …`, `export function f(){}`, etc.
                        rewrite_export_decl(path, declaration, js)?
                    } else {
                        // `export { a, b as c }` referring to local bindings.
                        rewrite_export_specifiers(decl)
                    };
                    edits.push(Edit {
                        start: decl.span.start,
                        end: decl.span.end,
                        text: replacement,
                    });
                }
                Statement::ExportDefaultDeclaration(decl) => {
                    let replacement =
                        rewrite_export_default(&decl.declaration, js, decl.span.start);
                    edits.push(Edit {
                        start: decl.span.start,
                        end: decl.span.end,
                        text: replacement,
                    });
                }
                Statement::ExportAllDeclaration(decl) => {
                    let id = self.resolve_and_load(&decl.source.value, dir, path)?;
                    let replacement = match &decl.exported {
                        // `export * as ns from './m'`
                        Some(name) => {
                            format!(
                                "exports[{}] = __velox_require('{}');",
                                js_string(name_str(name)),
                                id
                            )
                        }
                        // `export * from './m'`
                        None => format!(
                            "{{ const __m = __velox_require('{}'); for (const __k in __m) {{ \
                               if (__k !== 'default') exports[__k] = __m[__k]; }} }}",
                            id
                        ),
                    };
                    edits.push(Edit {
                        start: decl.span.start,
                        end: decl.span.end,
                        text: replacement,
                    });
                }
                _ => {}
            }
        }

        // Any import/export edit means this module used ESM syntax. Mark it
        // `__esModule` (as esbuild/tsc/Node do for transpiled ESM) so the
        // default-import interop routes its default through `.default` rather
        // than treating the whole `exports` object as the default.
        let is_esm = !edits.is_empty();

        // Follow CommonJS `require('<literal>')` the same way we follow `import`:
        // resolve each to a bundled module id and rewrite the specifier. A
        // specifier that fails to resolve is left untouched (so the runtime
        // loader handles `node:` builtins and a package's own try/catch around
        // an optional dependency still works).
        let mut collector = RequireCollector::default();
        collector.visit_program(&parsed.program);
        for (span, specifier) in collector.calls {
            if let Ok(id) = self.resolve_and_load(&specifier, dir, path) {
                edits.push(Edit {
                    start: span.start,
                    end: span.end,
                    text: format!("'{id}'"),
                });
            }
        }
        // Dynamic `import('x')` → a promise of the module's namespace (so it
        // resolves through the bundle's registry instead of JSC's module loader,
        // which can't see `node_modules`).
        for (span, specifier) in collector.dynamic_imports {
            if let Ok(id) = self.resolve_and_load(&specifier, dir, path) {
                edits.push(Edit {
                    start: span.start,
                    end: span.end,
                    text: format!("__velox_import('{id}')"),
                });
            }
        }

        // `import.meta` is module-only syntax that JSC rejects in a script, so
        // rewrite it to a per-module object defined in the wrapper preamble
        // (carries the module's own `url`/`dirname`/`filename`/`resolve`).
        let mut body = apply_edits(js, edits).replace("import.meta", "__velox_module_meta");
        if is_esm {
            body.insert_str(
                0,
                "Object.defineProperty(exports, '__esModule', { value: true });\n",
            );
        }
        Ok((body, collector.has_top_level_await, is_esm))
    }

    /// Resolve a specifier against `dir`, load the target, and return the id to
    /// use in the runtime `require(...)` call (numeric for files, `node:<name>`
    /// for builtins).
    fn resolve_and_load(
        &mut self,
        specifier: &str,
        dir: &Path,
        importer: &Path,
    ) -> Result<String, ModuleError> {
        match resolve(specifier, dir, importer)? {
            Resolution::File(path) => Ok(self.load(&path)?.to_string()),
            Resolution::Builtin(name) => {
                self.mark_builtin(name);
                Ok(format!("node:{name}"))
            }
        }
    }

    /// Mark a builtin (and the builtins it `require`s, transitively) for emit.
    fn mark_builtin(&mut self, name: &'static str) {
        if !self.needed_builtins.insert(name) {
            return;
        }
        if let Some((_, shim)) = crate::node::BUILTINS
            .iter()
            .chain(crate::oxc_helpers::OXC_HELPERS.iter())
            .find(|(n, _)| *n == name)
        {
            for dep in builtin_requires(shim) {
                self.mark_builtin(dep);
            }
        }
    }

    /// Stitch every rewritten module body into the final bundle. Also records,
    /// per module, the bundle line range its body occupies so a runtime stack
    /// frame can be mapped back to the original source (`crate::sourcemap`).
    fn emit(&self, entry_id: usize) -> String {
        // Count of '\n' emitted so far; bundle line of the next char = lines + 1.
        let mut lines: u32 = 0;
        let mut spans: Vec<crate::sourcemap::ModuleSpan> = Vec::new();
        fn count_nl(s: &str) -> u32 {
            s.bytes().filter(|&b| b == b'\n').count() as u32
        }

        let mut out = String::new();
        out.push_str(BUNDLE_PRELUDE);
        lines += count_nl(BUNDLE_PRELUDE);
        for (id, body) in self.bodies.iter().enumerate() {
            // Only modules with top-level `await` get an `async` wrapper (which
            // enables TLA). All others are synchronous so that a thrown error
            // during init propagates through `require` instead of becoming a
            // swallowed promise rejection (which would leave `module.exports`
            // empty — silently breaking the requiring module).
            let async_kw = if *self.needs_async.get(id).unwrap_or(&false) {
                "async "
            } else {
                ""
            };
            // `require` is passed as `__velox_require` and re-bound to `const
            // require` in the preamble — UNLESS the module declares its own
            // (the ESM `const require = createRequire(import.meta.url)` pattern,
            // e.g. yargs), in which case a param named `require` would collide.
            let wrapper = format!(
                "__modules['{id}'] = {async_kw}function (module, exports, __velox_require) {{\n"
            );
            out.push_str(&wrapper);
            lines += count_nl(&wrapper);
            let preamble = module_preamble(self.paths.get(id), body);
            out.push_str(&preamble);
            lines += count_nl(&preamble);

            // The body begins on the next bundle line.
            let start_line = lines + 1;
            out.push_str(body);
            lines += count_nl(body);
            // `body` doesn't end in a newline, so its last line is the current
            // (lines+1)'th line; record the inclusive end.
            let end_line = lines + 1;
            if !self.maps.get(id).map(Vec::is_empty).unwrap_or(true) {
                spans.push(crate::sourcemap::ModuleSpan {
                    start_line,
                    end_line,
                    esm_shift: if *self.esm.get(id).unwrap_or(&false) {
                        1
                    } else {
                        0
                    },
                    file: crate::sourcemap::display_path(self.paths.get(id)),
                    tokens: self.maps[id].clone(),
                });
            }

            out.push_str("\n};\n");
            lines += 2;
        }

        // Inject the transitively-needed Node builtin shims. They are CommonJS
        // bodies and may `require('node:<other>')` each other.
        for name in &self.needed_builtins {
            if let Some((_, shim)) = crate::node::BUILTINS
                .iter()
                .chain(crate::oxc_helpers::OXC_HELPERS.iter())
                .find(|(n, _)| n == name)
            {
                // Builtin shims never use top-level await — sync wrappers so their
                // init errors propagate too.
                out.push_str(&format!(
                    "__modules['node:{name}'] = function (module, exports, require) {{\n"
                ));
                out.push_str(shim);
                out.push_str("\n};\n");
            }
        }

        // Run the entry module, surfacing any rejection from a top-level
        // `await` (which settles later, on the event loop) as an uncaught error.
        out.push_str(&format!(
            "(function () {{\n  \
               const module = {{ exports: {{}} }};\n  \
               __cache['{0}'] = module;\n  \
               Promise.resolve(__modules['{0}'](module, module.exports, require))\n    \
                 .then(function () {{ __velox_maybe_serve(module.exports); }}, function (e) {{ __velox_uncaught(String(e) + (e && e.stack ? '\\n' + String(e.stack) : '')); }});\n\
             }})();\n",
            entry_id
        ));
        crate::sourcemap::set_table(spans);
        out
    }
}

/// Remove a leading `#!`-shebang line, replacing it with a blank line so that
/// line numbers in diagnostics stay aligned with the original source.
fn strip_shebang(source: String) -> String {
    if source.starts_with("#!") {
        return match source.find('\n') {
            Some(nl) => source[nl..].to_string(),
            None => String::new(),
        };
    }
    source
}

/// Per-module preamble injected at the top of each wrapper: gives the module
/// its own `__filename`/`__dirname`, an `import.meta` stand-in, a dirname-aware
/// `require.resolve`, and populates `module.filename`/`module.path`.
fn module_preamble(path: Option<&PathBuf>, body: &str) -> String {
    let Some(path) = path else {
        return String::new();
    };
    let filename = path.to_string_lossy();
    let dirname = path
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();
    let url = format!("file://{filename}");
    let f = serde_json::to_string(filename.as_ref()).unwrap_or_else(|_| "\"\"".into());
    let d = serde_json::to_string(&dirname).unwrap_or_else(|_| "\"\"".into());
    let u = serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".into());

    // Some originally-ESM modules declare their own `__dirname`/`__filename`
    // (legal in real ESM, where Node injects neither — e.g. yargs' esm shim does
    // `const __dirname = ...`). Injecting our own `const` then collides ("Cannot
    // declare a const variable twice"). Skip the binding the module defines
    // itself, and reference the string literals elsewhere so there's no TDZ.
    let mut out = String::new();
    out.push_str(&format!("const __velox_pdir = {d};\n"));
    // Re-bind the renamed `require` param — unless the module brings its own.
    if !declares_binding(body, "require") {
        out.push_str(
            "const require = __velox_require;\n\
             require.resolve = function (id) { \
               if (typeof id !== 'string' || id.startsWith('node:')) return id; \
               if (id.startsWith('.') || id.startsWith('/')) { \
                 try { return require('node:path').resolve(__velox_pdir, id); } catch (e) { return id; } \
               } return id; };\n",
        );
    }
    if !declares_binding(body, "__filename") {
        out.push_str(&format!("const __filename = {f};\n"));
    }
    if !declares_binding(body, "__dirname") {
        out.push_str(&format!("const __dirname = {d};\n"));
    }
    out.push_str(&format!(
        "const __velox_module_meta = {{ url: {u}, filename: {f}, dirname: {d}, \
         resolve: function (s) {{ try {{ return new URL(s, {u}).href; }} catch (e) {{ return s; }} }} }};\n\
         module.filename = {f}; module.path = {d};\n"
    ));
    out
}

/// True if `body` contains a top-level-ish `const`/`let`/`var <name>` or a
/// destructured declaration binding `<name>`. A conservative substring scan —
/// false positives only cause us to skip an injected binding the module is
/// already providing, which is the safe direction.
fn declares_binding(body: &str, name: &str) -> bool {
    for kw in ["const ", "let ", "var "] {
        let mut search = body;
        while let Some(pos) = search.find(kw) {
            let after = &search[pos + kw.len()..];
            let trimmed = after.trim_start();
            if let Some(rest) = trimmed.strip_prefix(name) {
                // Ensure it's a whole identifier (next char isn't ident-continuation).
                if !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_' || c == '$') {
                    return true;
                }
            }
            search = &search[pos + kw.len()..];
        }
    }
    false
}

/// Runtime glue prepended to every bundle: the registry and lazy `require`.
const BUNDLE_PRELUDE: &str = r#"const __modules = {};
const __cache = {};
function require(id) {
  if (__cache[id]) return __cache[id].exports;
  // `node:` builtins always go through the one shared global loader so the
  // bundle and the runtime (e.g. the global WebSocket/fetch) get the SAME
  // singleton instance. This is essential for stateful I/O shims (net/http/…)
  // that install process-global native handlers — two instances would clobber
  // each other's handler registrations.
  if (typeof id === 'string' && id.indexOf('node:') === 0 && typeof globalThis.__velox_builtin_require === 'function') {
    return globalThis.__velox_builtin_require(id);
  }
  // Not bundled (e.g. a CommonJS-style `require('node:fs')` the bundler never saw
  // as an import) — fall back to the runtime's lazy builtin loader.
  if (!__modules[id]) {
    if (typeof globalThis.__velox_builtin_require === 'function') return globalThis.__velox_builtin_require(id);
    throw new Error("Cannot find module '" + id + "'");
  }
  const module = { exports: {} };
  __cache[id] = module;
  __modules[id](module, module.exports, require);
  return module.exports;
}
// Build an ES-module namespace object from a (CJS or ESM) module's exports, for
// dynamic `import()`. A CJS module's exports become the `default`, with its own
// enumerable keys surfaced as named exports (matching Node's interop).
function __velox_ns(m) {
  if (m && m.__esModule && m.default !== undefined && Object.prototype.hasOwnProperty.call(m, 'default')) return m;
  const ns = {};
  if (m && (typeof m === 'object' || typeof m === 'function')) {
    for (const k in m) { try { ns[k] = m[k]; } catch (e) {} }
  }
  // The default export of a plain CommonJS module is the WHOLE `module.exports`
  // (Node interop) — even if it happens to carry its own `.default` property
  // (e.g. winston defines an `exports.default` getter returning a subset). Only
  // a transpiled-ESM module (`__esModule`) routes default through `.default`.
  ns.default = (m && m.__esModule && ('default' in m)) ? m.default : m;
  return ns;
}
// Dynamic import: a promise of the resolved module's namespace, going through
// the bundle registry (JSC's own module loader can't see node_modules).
function __velox_import(id) {
  return Promise.resolve().then(function () { return __velox_ns(require(id)); });
}
// Bun-style auto-serve: if the entry module's `export default` is a server
// object (`{ port?, fetch }`) or a web-framework app exposing `.fetch`
// (Hono/Elysia/…), start a server for it automatically. Opt out by exporting
// something without a `fetch` method, or just call `.listen()`/`Velox.serve`
// yourself.
function __velox_maybe_serve(exports) {
  var def = exports && exports.default;
  if (!def || (typeof def !== 'object' && typeof def !== 'function')) return;
  if (typeof def.fetch !== 'function') return;
  if (globalThis.__velox_served) return;
  if (globalThis.Velox && typeof globalThis.Velox.serve === 'function') {
    globalThis.__velox_served = true;
    globalThis.Velox.serve(def);
  }
}
"#;

/// Rewrite a single `import` declaration into CommonJS bindings.
fn rewrite_import(decl: &oxc::ast::ast::ImportDeclaration, id: &str) -> String {
    // Use the unshadowable `__velox_require` param, not `require`: import glue
    // runs at module top, before any user `const require = createRequire(...)`
    // (the ESM-shim pattern in yargs etc.) would be initialized.
    let request = format!("__velox_require('{}')", id);

    // Side-effect-only import: `import './m'`.
    let Some(specifiers) = &decl.specifiers else {
        return format!("{};", request);
    };
    if specifiers.is_empty() {
        return format!("{};", request);
    }

    // Cache the required module in a unique temp so we only call require once,
    // then destructure/bind from it.
    let tmp = format!("__imp{}", decl.span.start);
    let mut out = format!("const {} = {};", tmp, request);

    for spec in specifiers {
        match spec {
            ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                // CJS interop (Node `esModuleInterop`): a plain CommonJS module's
                // default import is the whole `module.exports`; only a transpiled
                // ESM module (`__esModule`) routes the default through `.default`.
                // (winston defines its own `exports.default` getter returning a
                // subset — preferring `.default` would wrongly pick that.)
                out.push_str(&format!(
                    " const {0} = ({1} && {1}.__esModule && '{2}' in {1}) ? {1}.default : {1};",
                    &s.local.name, tmp, "default"
                ));
            }
            ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                out.push_str(&format!(" const {} = {};", &s.local.name, tmp));
            }
            ImportDeclarationSpecifier::ImportSpecifier(s) => {
                let imported = name_str(&s.imported);
                out.push_str(&format!(
                    " const {} = {}[{}];",
                    &s.local.name,
                    tmp,
                    js_string(imported)
                ));
            }
        }
    }
    out
}

/// Rewrite `export <decl>` — keep the original declaration text verbatim, then
/// append `exports.<name> = <name>` for every binding it introduces.
/// A live (getter-backed) named export, so reads see later reassignments of the
/// local binding — ESM live-binding semantics, which `exports.x = x` would lose.
fn live_export_binding(name: &str) -> String {
    format!(
        "\nObject.defineProperty(exports, '{name}', {{ enumerable: true, configurable: true, get: function () {{ return {name}; }} }});"
    )
}

/// Collect every identifier a binding pattern introduces, recursing through
/// object/array destructuring and default-value patterns (so
/// `export const { a, b: c } = …` / `export const [x, ...y] = …` export all
/// their names).
fn collect_binding_names(pattern: &oxc::ast::ast::BindingPattern, out: &mut Vec<String>) {
    use oxc::ast::ast::BindingPattern;
    match pattern {
        BindingPattern::BindingIdentifier(ident) => out.push(ident.name.to_string()),
        BindingPattern::ObjectPattern(obj) => {
            for prop in &obj.properties {
                collect_binding_names(&prop.value, out);
            }
            if let Some(rest) = &obj.rest {
                collect_binding_names(&rest.argument, out);
            }
        }
        BindingPattern::ArrayPattern(arr) => {
            for elem in arr.elements.iter().flatten() {
                collect_binding_names(elem, out);
            }
            if let Some(rest) = &arr.rest {
                collect_binding_names(&rest.argument, out);
            }
        }
        BindingPattern::AssignmentPattern(assign) => collect_binding_names(&assign.left, out),
    }
}

fn rewrite_export_decl(
    path: &Path,
    declaration: &Declaration,
    source: &str,
) -> Result<String, ModuleError> {
    match declaration {
        Declaration::VariableDeclaration(var) => {
            // Keep the whole `const x = …, y = …` verbatim, then export names.
            // Use a live getter (not `exports.x = x`) so a binding assigned after
            // the `export` statement still reads through — e.g. the TS-enum
            // pattern `export var E; (function (E) { … })(E || (E = {}))`, where a
            // value-capture would freeze the export at its initial `undefined`.
            let text = slice(source, var.span.start, var.span.end);
            let mut out = text.to_string();
            for d in &var.declarations {
                let mut names = Vec::new();
                collect_binding_names(&d.id, &mut names);
                for name in names {
                    out.push_str(&live_export_binding(&name));
                }
            }
            Ok(out)
        }
        Declaration::FunctionDeclaration(func) => {
            let text = slice(source, func.span.start, func.span.end);
            let name = func
                .id
                .as_ref()
                .map(|i| i.name.as_str())
                .unwrap_or_default();
            Ok(format!("{}\nexports.{} = {};", text, name, name))
        }
        Declaration::ClassDeclaration(class) => {
            let text = slice(source, class.span.start, class.span.end);
            let name = class
                .id
                .as_ref()
                .map(|i| i.name.as_str())
                .unwrap_or_default();
            Ok(format!("{}\nexports.{} = {};", text, name, name))
        }
        _ => Err(ModuleError::Unsupported {
            path: path.to_path_buf(),
            message: "this `export` declaration form is not supported".to_string(),
        }),
    }
}

/// Rewrite `export { a, b as c }` (no `from`) into `exports.* = local`.
fn rewrite_export_specifiers(decl: &oxc::ast::ast::ExportNamedDeclaration) -> String {
    let mut out = String::new();
    for spec in &decl.specifiers {
        let local = name_str(&spec.local);
        let exported = name_str(&spec.exported);
        out.push_str(&format!("exports[{}] = {};", js_string(exported), local));
    }
    out
}

/// Rewrite `export { a, b as c } from './m'` (re-export from another module).
fn rewrite_reexport_named(decl: &oxc::ast::ast::ExportNamedDeclaration, id: &str) -> String {
    let tmp = format!("__re{}", decl.span.start);
    let mut out = format!("const {} = __velox_require('{}');", tmp, id);
    for spec in &decl.specifiers {
        let local = name_str(&spec.local);
        let exported = name_str(&spec.exported);
        out.push_str(&format!(
            " exports[{}] = {}[{}];",
            js_string(exported),
            tmp,
            js_string(local)
        ));
    }
    out
}

/// Rewrite `export default <expr|decl>` into `exports.default = …`.
fn rewrite_export_default(
    kind: &ExportDefaultDeclarationKind,
    source: &str,
    _start: u32,
) -> String {
    match kind {
        // `export default function foo() {}` — keep the named function so it can
        // recurse, then export it.
        ExportDefaultDeclarationKind::FunctionDeclaration(func) => {
            let text = slice(source, func.span.start, func.span.end);
            match &func.id {
                Some(id) => format!("{}\nexports.default = {};", text, id.name),
                None => format!("exports.default = {};", text),
            }
        }
        ExportDefaultDeclarationKind::ClassDeclaration(class) => {
            let text = slice(source, class.span.start, class.span.end);
            match &class.id {
                Some(id) => format!("{}\nexports.default = {};", text, id.name),
                None => format!("exports.default = {};", text),
            }
        }
        ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => {
            // Type-only; nothing to emit at runtime.
            String::new()
        }
        // Any expression form: `export default <expr>`.
        other => {
            let span = oxc::span::GetSpan::span(other);
            let text = slice(source, span.start, span.end);
            format!("exports.default = {};", text)
        }
    }
}

// --- resolution ---------------------------------------------------------

/// Resolve a specifier against the importing dir.
///
/// Relative specifiers (`./x`, `../y`) resolve against `dir` with extension /
/// `index` fallback. Bare specifiers (`lodash`, `@scope/pkg/sub`) resolve
/// through `node_modules` Node-style (see the module docs). Node built-ins are
/// rejected with [`ModuleError::Builtin`].
fn resolve(specifier: &str, dir: &Path, importer: &Path) -> Result<Resolution, ModuleError> {
    // Node builtins are matched first (before the filesystem): velox ships its
    // own shims (`BUILTINS`, including non-Node ones like `_http_common`), and
    // `node:*`/bare builtins must route to them, not node_modules. Relative and
    // `#imports` specifiers can never be builtins, so skip the check for them.
    // A trailing slash forces userland resolution in Node (`require('punycode/')`
    // is the node_modules package, never the builtin — tr46/whatwg-url rely on
    // this to shadow the deprecated `punycode` builtin). Skip the builtin check
    // for such specifiers and strip the slash before handing off to the resolver.
    let trailing_slash = !is_relative_specifier(specifier) && specifier.ends_with('/');
    if !is_relative_specifier(specifier) && !specifier.starts_with('#') && !trailing_slash {
        if let Some(name) = supported_builtin(specifier) {
            return Ok(Resolution::Builtin(name));
        }
        if is_node_builtin(specifier) {
            return Err(ModuleError::Builtin {
                specifier: specifier.to_string(),
                importer: importer.to_path_buf(),
            });
        }
    }
    let specifier = if trailing_slash {
        specifier.trim_end_matches('/')
    } else {
        specifier
    };

    // Everything else — relative paths, bare packages (with `exports`/`imports`
    // conditions, scoped names, dir-index, `.cjs`/`.mjs`/`.json`, TS `.ts`/`.tsx`
    // and the `.js`→`.ts` alias), and `#name` internal imports — goes through
    // oxc_resolver (Node-compatible resolution, shared with oxc/Rspack).
    //
    // Two passes: first prefer the `require`/CommonJS build of dual packages
    // (velox bundles to CJS and its bundler is most robust with CJS builds),
    // then fall back to a resolver with `import` active for pure-ESM packages.
    // This mirrors velox's long-standing "prefer the CJS build" behaviour.
    let result = VELOX_RESOLVER_CJS
        .with(|r| r.resolve(dir, specifier))
        .or_else(|_| VELOX_RESOLVER_ESM.with(|r| r.resolve(dir, specifier)));
    result
        .map(|r| Resolution::File(normalize(r.path())))
        .map_err(|_| ModuleError::NotFound {
            specifier: specifier.to_string(),
            importer: importer.to_path_buf(),
        })
}

thread_local! {
    /// CJS-preferring resolver (no `import` condition) — picks the `require`
    /// build of dual packages. Per JS thread (worker_threads each get one).
    static VELOX_RESOLVER_CJS: Resolver = Resolver::new(velox_resolve_options(false));
    /// Fallback with `import` active, for pure-ESM packages.
    static VELOX_RESOLVER_ESM: Resolver = Resolver::new(velox_resolve_options(true));
}

/// Resolution options matching velox's runtime: TS + JS extensions, export
/// conditions, and the `.js`→`.ts` extension alias. `allow_import` activates the
/// `import` condition (used only as a fallback so CJS builds win by default).
fn velox_resolve_options(allow_import: bool) -> ResolveOptions {
    let s = |x: &str| x.to_string();
    let mut condition_names = vec![s("node")];
    if allow_import {
        condition_names.push(s("import"));
    }
    condition_names.push(s("require"));
    condition_names.push(s("default"));
    ResolveOptions {
        extensions: vec![
            s(".ts"),
            s(".tsx"),
            s(".mts"),
            s(".cts"),
            s(".js"),
            s(".jsx"),
            s(".mjs"),
            s(".cjs"),
            s(".json"),
            s(".node"),
        ],
        condition_names,
        // Prefer the CommonJS `main` (velox bundles to CJS) but fall back to
        // `module` for ESM-only legacy packages without an `exports` map.
        main_fields: vec![s("main"), s("module")],
        extension_alias: vec![
            (s(".js"), vec![s(".ts"), s(".tsx"), s(".js"), s(".jsx")]),
            (s(".mjs"), vec![s(".mts"), s(".mjs")]),
            (s(".cjs"), vec![s(".cts"), s(".cjs")]),
        ],
        ..ResolveOptions::default()
    }
}

/// If `specifier` names a Node builtin we ship a shim for, return its canonical
/// name. Tries the full specifier first (so subpaths like `fs/promises` or
/// `timers/promises` win), then the base (`node:util/types` → `util`).
fn supported_builtin(specifier: &str) -> Option<&'static str> {
    let without_prefix = specifier.strip_prefix("node:").unwrap_or(specifier);
    let names = || {
        crate::node::BUILTINS
            .iter()
            .chain(crate::oxc_helpers::OXC_HELPERS.iter())
            .map(|(name, _)| *name)
    };
    if let Some(name) = names().find(|name| *name == without_prefix) {
        return Some(name);
    }
    let base = without_prefix.split('/').next().unwrap_or(without_prefix);
    names().find(|name| *name == base)
}

/// Scan a builtin shim's source for `require('node:x')` to find its builtin
/// dependencies (so only the transitively-needed shims are bundled).
fn builtin_requires(shim: &str) -> Vec<&'static str> {
    let mut deps = Vec::new();
    let mut rest = shim;
    while let Some(idx) = rest.find("require(") {
        rest = &rest[idx + "require(".len()..];
        let quote = match rest.as_bytes().first() {
            Some(&b) if b == b'\'' || b == b'"' => b as char,
            _ => continue,
        };
        let body = &rest[1..];
        if let Some(end) = body.find(quote) {
            if let Some(name) = supported_builtin(&body[..end]) {
                deps.push(name);
            }
            rest = &body[end..];
        }
    }
    deps
}

/// Is this bare specifier a known Node built-in module? Covers the common
/// names plus any `node:` prefixed specifier.
fn is_node_builtin(specifier: &str) -> bool {
    if specifier.starts_with("node:") {
        return true;
    }
    // The base (pre-subpath) name is what matters, e.g. `fs/promises` -> `fs`.
    let base = specifier.split('/').next().unwrap_or(specifier);
    const BUILTINS: &[&str] = &[
        "assert",
        "buffer",
        "child_process",
        "cluster",
        "console",
        "constants",
        "crypto",
        "dgram",
        "dns",
        "domain",
        "events",
        "fs",
        "http",
        "http2",
        "https",
        "inspector",
        "module",
        "net",
        "os",
        "path",
        "perf_hooks",
        "process",
        "punycode",
        "querystring",
        "readline",
        "repl",
        "stream",
        "string_decoder",
        "sys",
        "timers",
        "tls",
        "trace_events",
        "tty",
        "url",
        "util",
        "v8",
        "vm",
        "wasi",
        "worker_threads",
        "zlib",
    ];
    BUILTINS.contains(&base)
}

/// Is this a relative specifier (`./x`, `../y`) rather than a bare one?
fn is_relative_specifier(specifier: &str) -> bool {
    // `.`/`..` are directory self/parent references (e.g. `require('..')`).
    specifier == "."
        || specifier == ".."
        || specifier.starts_with("./")
        || specifier.starts_with("../")
}

/// Normalize a path lexically (resolve `.` and `..`) without touching the FS,
/// so the same module reached via different specifiers maps to one id.
fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

// --- small string helpers ----------------------------------------------

/// Pull the textual name out of a `ModuleExportName` (ignoring its variant).
fn name_str<'a>(name: &'a ModuleExportName<'a>) -> &'a str {
    match name {
        ModuleExportName::IdentifierName(n) => n.name.as_str(),
        ModuleExportName::IdentifierReference(n) => n.name.as_str(),
        ModuleExportName::StringLiteral(n) => n.value.as_str(),
    }
}

/// Slice `[start, end)` bytes out of `source` (offsets come from oxc spans,
/// which are byte offsets into the same string we parsed).
fn slice(source: &str, start: u32, end: u32) -> &str {
    &source[start as usize..end as usize]
}

/// Encode `s` as a double-quoted JS string literal.
fn js_string(s: &str) -> String {
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

/// Apply span edits to `source` right-to-left so earlier offsets stay valid.
fn apply_edits(source: &str, mut edits: Vec<Edit>) -> String {
    edits.sort_by_key(|b| std::cmp::Reverse(b.start));
    let mut out = source.to_string();
    for edit in edits {
        out.replace_range(edit.start as usize..edit.end as usize, &edit.text);
    }
    out
}

/// Render oxc diagnostics into a readable, multi-line string.
fn format_diagnostics(source: &str, diagnostics: &[oxc::diagnostics::OxcDiagnostic]) -> String {
    let _ = source;
    diagnostics
        .iter()
        .map(|d| format!("  {}", d))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_dot_and_dotdot() {
        assert_eq!(normalize(Path::new("a/./b")), PathBuf::from("a/b"));
        assert_eq!(normalize(Path::new("a/b/../c")), PathBuf::from("a/c"));
        assert_eq!(normalize(Path::new("./a/b")), PathBuf::from("a/b"));
    }

    #[test]
    fn relative_vs_bare_specifiers() {
        assert!(is_relative_specifier("./x"));
        assert!(is_relative_specifier("../y/z"));
        assert!(!is_relative_specifier("react"));
        assert!(!is_relative_specifier("@scope/pkg"));
    }

    #[test]
    fn js_string_escapes() {
        assert_eq!(js_string("a"), "\"a\"");
        assert_eq!(js_string("a\"b"), "\"a\\\"b\"");
        assert_eq!(js_string("a\\b"), "\"a\\\\b\"");
    }

    #[test]
    fn apply_edits_right_to_left() {
        // Replace [0,3) with "X" and [4,7) with "Y" in "abc def".
        let edits = vec![
            Edit {
                start: 0,
                end: 3,
                text: "X".to_string(),
            },
            Edit {
                start: 4,
                end: 7,
                text: "Y".to_string(),
            },
        ];
        assert_eq!(apply_edits("abc def", edits), "X Y");
    }

    #[test]
    fn slice_extracts_span() {
        assert_eq!(slice("hello world", 6, 11), "world");
    }

    // --- bare specifier parsing ---------------------------------------

    #[test]
    fn node_builtins_detected() {
        assert!(is_node_builtin("fs"));
        assert!(is_node_builtin("path"));
        assert!(is_node_builtin("fs/promises"));
        assert!(is_node_builtin("node:os"));
        assert!(is_node_builtin("node:anything"));
        assert!(!is_node_builtin("lodash"));
        assert!(!is_node_builtin("@scope/pkg"));
    }

    // --- node_modules upward walk -------------------------------------

    // --- package.json entry selection ---------------------------------
}

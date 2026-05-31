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

/// Extensions tried (in order) when a relative specifier has no usable
/// extension of its own, both directly and under an `index.` file. Includes
/// CommonJS (`cjs`) and ESM (`mjs`) so real npm packages resolve, plus `json`.
const RESOLVE_EXTENSIONS: &[&str] = &["ts", "tsx", "js", "jsx", "cjs", "mjs", "json"];

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
    let entry = normalize(entry);
    let mut graph = Graph::default();
    let entry_id = graph.load(&entry)?;
    let js = graph.emit(entry_id);
    Ok((js, graph.paths.clone()))
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

        let source = std::fs::read_to_string(path).map_err(|source| ModuleError::Read {
            path: path.to_path_buf(),
            source,
        })?;

        // A `.json` module exports its parsed contents (JSON is a subset of JS
        // object-literal syntax, so it's a valid right-hand side as-is).
        if path.extension().is_some_and(|e| e == "json") {
            self.bodies[id] = format!("module.exports = {};", source.trim());
            return Ok(id);
        }

        // Transpile FIRST: this strips TypeScript/JSX but keeps import/export
        // statements (oxc's codegen preserves them), so we can find and rewrite
        // them in the next step.
        let js = crate::transpile::transpile(path, &source).map_err(|diagnostics| {
            ModuleError::Parse {
                path: path.to_path_buf(),
                message: format_diagnostics(&source, &diagnostics),
            }
        })?;

        let (body, needs_async) = self.rewrite_module(path, &js)?;
        self.bodies[id] = body;
        self.needs_async[id] = needs_async;
        Ok(id)
    }

    /// Parse the already-transpiled JS for `path`, collect span-based edits that
    /// turn ESM statements into CommonJS, and apply them.
    fn rewrite_module(&mut self, path: &Path, js: &str) -> Result<(String, bool), ModuleError> {
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
        Ok((body, collector.has_top_level_await))
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
        if let Some((_, shim)) = crate::node::BUILTINS.iter().find(|(n, _)| *n == name) {
            for dep in builtin_requires(shim) {
                self.mark_builtin(dep);
            }
        }
    }

    /// Stitch every rewritten module body into the final bundle.
    fn emit(&self, entry_id: usize) -> String {
        let mut out = String::new();
        out.push_str(BUNDLE_PRELUDE);
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
            out.push_str(&format!(
                "__modules['{id}'] = {async_kw}function (module, exports, __velox_require) {{\n"
            ));
            out.push_str(&module_preamble(self.paths.get(id), body));
            out.push_str(body);
            out.push_str("\n};\n");
        }

        // Inject the transitively-needed Node builtin shims. They are CommonJS
        // bodies and may `require('node:<other>')` each other.
        for name in &self.needed_builtins {
            if let Some((_, shim)) = crate::node::BUILTINS.iter().find(|(n, _)| n == name) {
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
        out
    }
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
fn rewrite_export_decl(
    path: &Path,
    declaration: &Declaration,
    source: &str,
) -> Result<String, ModuleError> {
    match declaration {
        Declaration::VariableDeclaration(var) => {
            // Keep the whole `const x = …, y = …` verbatim, then export names.
            let text = slice(source, var.span.start, var.span.end);
            let mut out = text.to_string();
            for d in &var.declarations {
                match &d.id {
                    oxc::ast::ast::BindingPattern::BindingIdentifier(ident) => {
                        let name = ident.name.as_str();
                        out.push_str(&format!("\nexports.{} = {};", name, name));
                    }
                    _ => {
                        return Err(ModuleError::Unsupported {
                            path: path.to_path_buf(),
                            message: "destructuring patterns in `export` declarations are not \
                                      supported; assign first, then `export { … }`"
                                .to_string(),
                        });
                    }
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
    if is_relative_specifier(specifier) {
        let base = dir.join(specifier);
        return resolve_file_or_index(&base)
            .map(Resolution::File)
            .ok_or_else(|| ModuleError::NotFound {
                specifier: specifier.to_string(),
                importer: importer.to_path_buf(),
            });
    }

    // `#name` — package-internal subpath imports (the package.json `imports`
    // field of the nearest enclosing package), used by chalk and many others.
    if specifier.starts_with('#') {
        return resolve_imports_field(specifier, dir, importer);
    }

    // Node builtins: provide a shim for the supported ones, otherwise report the
    // missing standard-library module clearly.
    if let Some(name) = supported_builtin(specifier) {
        return Ok(Resolution::Builtin(name));
    }
    if is_node_builtin(specifier) {
        return Err(ModuleError::Builtin {
            specifier: specifier.to_string(),
            importer: importer.to_path_buf(),
        });
    }

    resolve_bare(specifier, dir, importer).map(Resolution::File)
}

/// If `specifier` names a Node builtin we ship a shim for, return its canonical
/// name. Tries the full specifier first (so subpaths like `fs/promises` or
/// `timers/promises` win), then the base (`node:util/types` → `util`).
fn supported_builtin(specifier: &str) -> Option<&'static str> {
    let without_prefix = specifier.strip_prefix("node:").unwrap_or(specifier);
    let names = || crate::node::BUILTINS.iter().map(|(name, _)| *name);
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

/// Resolve a base path as a file: exact path, then `base.<ext>`.
fn resolve_file(base: &Path) -> Option<PathBuf> {
    if base.is_file() {
        return Some(normalize(base));
    }
    for ext in RESOLVE_EXTENSIONS {
        let candidate = append_ext(base, ext);
        if candidate.is_file() {
            return Some(normalize(&candidate));
        }
    }
    None
}

/// Resolve a base path with the shared file/directory fallback rules: a file
/// (exact or `base.<ext>`), then — if `base` is a directory — its package.json
/// `main`/`exports` entry (so `require('../some-dir')` works like Node), then
/// `base/index.<ext>`.
fn resolve_file_or_index(base: &Path) -> Option<PathBuf> {
    if let Some(file) = resolve_file(base) {
        return Some(file);
    }
    if base.is_dir() {
        // A directory: honor its package.json main/exports before index.
        for entry in package_entries(base) {
            let target = base.join(&entry);
            if target != base
                && let Some(file) = resolve_file(&target).or_else(|| {
                    RESOLVE_EXTENSIONS.iter().find_map(|ext| {
                        let c = target.join(format!("index.{ext}"));
                        c.is_file().then(|| normalize(&c))
                    })
                })
            {
                return Some(file);
            }
        }
    }
    for ext in RESOLVE_EXTENSIONS {
        let candidate = base.join(format!("index.{}", ext));
        if candidate.is_file() {
            return Some(normalize(&candidate));
        }
    }
    None
}

/// Resolve a `#name` subpath import against the nearest enclosing package.json
/// `imports` field. Handles exact keys and a single `*` wildcard pattern, with
/// conditional targets resolved in the same preference order as `exports`.
fn resolve_imports_field(
    specifier: &str,
    dir: &Path,
    importer: &Path,
) -> Result<Resolution, ModuleError> {
    let not_found = || ModuleError::NotFound {
        specifier: specifier.to_string(),
        importer: importer.to_path_buf(),
    };
    let mut current = Some(dir);
    while let Some(d) = current {
        let text = std::fs::read_to_string(d.join("package.json")).ok();
        if let Some(text) = text
            && let Ok(json) = serde_json::from_str::<serde_json::Value>(&text)
            && let Some(imports) = json.get("imports").and_then(|v| v.as_object())
        {
            // 1. Exact key match.
            if let Some(target) = imports.get(specifier) {
                let mut cands = Vec::new();
                collect_conditions(target, &mut cands);
                for c in cands {
                    if let Some(p) = resolve_file_or_index(&d.join(&c)) {
                        return Ok(Resolution::File(p));
                    }
                }
            }
            // 2. Single-`*` wildcard pattern (`#internal/*` -> `./src/*.js`).
            for (key, target) in imports {
                if let Some(star) = key.find('*') {
                    let (prefix, suffix) = (&key[..star], &key[star + 1..]);
                    if specifier.len() >= prefix.len() + suffix.len()
                        && specifier.starts_with(prefix)
                        && specifier.ends_with(suffix)
                    {
                        let captured = &specifier[prefix.len()..specifier.len() - suffix.len()];
                        let mut cands = Vec::new();
                        collect_conditions(target, &mut cands);
                        for c in cands {
                            let resolved = c.replace('*', captured);
                            if let Some(p) = resolve_file_or_index(&d.join(&resolved)) {
                                return Ok(Resolution::File(p));
                            }
                        }
                    }
                }
            }
            // The nearest `imports` field is authoritative; stop walking.
            return Err(not_found());
        }
        current = d.parent();
    }
    Err(not_found())
}

/// Candidate target paths for a package subpath via its `exports` map
/// (`<pkgDir>/package.json` `exports["./<sub>"]`), in condition preference order.
/// Handles exact keys and single-`*` wildcard patterns (`"./feat/*"`). Empty if
/// the package has no `exports` field or the subpath isn't mapped.
fn exports_subpath_candidates(pkg_dir: &Path, sub: &str) -> Vec<String> {
    let mut out = Vec::new();
    let Ok(text) = std::fs::read_to_string(pkg_dir.join("package.json")) else {
        return out;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return out;
    };
    let Some(exports) = json.get("exports").and_then(|v| v.as_object()) else {
        return out;
    };
    let key = format!("./{sub}");
    // 1. Exact subpath key.
    if let Some(target) = exports.get(&key) {
        collect_conditions(target, &mut out);
        return out;
    }
    // 2. Single-`*` wildcard pattern (`"./feat/*": "./dist/feat/*.js"`).
    for (k, target) in exports {
        if let Some(star) = k.find('*') {
            let (prefix, suffix) = (&k[..star], &k[star + 1..]);
            if key.len() >= prefix.len() + suffix.len()
                && key.starts_with(prefix)
                && key.ends_with(suffix)
            {
                let captured = &key[prefix.len()..key.len() - suffix.len()];
                let mut raw = Vec::new();
                collect_conditions(target, &mut raw);
                out.extend(raw.into_iter().map(|c| c.replace('*', captured)));
                return out;
            }
        }
    }
    out
}

/// Resolve a bare specifier through `node_modules`.
fn resolve_bare(specifier: &str, dir: &Path, importer: &Path) -> Result<PathBuf, ModuleError> {
    let (name, subpath) = parse_bare_specifier(specifier);

    // Walk UP from the importer's directory to the filesystem root, taking the
    // first ancestor whose `node_modules/<name>` directory exists.
    let pkg_dir = find_package_dir(dir, name).ok_or_else(|| ModuleError::NotFound {
        specifier: specifier.to_string(),
        importer: importer.to_path_buf(),
    })?;

    // With a subpath, first consult the package's `exports` subpath map (modern
    // packages like hono map `"./ws"` -> `"./dist/ws/index.js"`); fall back to a
    // direct `<pkgDir>/<subpath>` join for packages without `exports`.
    if let Some(sub) = subpath {
        for cand in exports_subpath_candidates(&pkg_dir, sub) {
            if let Some(resolved) = resolve_file_or_index(&pkg_dir.join(&cand)) {
                return Ok(resolved);
            }
        }
        let base = pkg_dir.join(sub);
        return resolve_file_or_index(&base).ok_or_else(|| ModuleError::NotFound {
            specifier: specifier.to_string(),
            importer: importer.to_path_buf(),
        });
    }

    // No subpath: try each package.json entry candidate (exports conditions,
    // then main) in order — so a package whose preferred-condition target is
    // missing still resolves via a later candidate — then fall back to `index`.
    for entry_rel in package_entries(&pkg_dir) {
        if let Some(resolved) = resolve_file_or_index(&pkg_dir.join(&entry_rel)) {
            return Ok(resolved);
        }
    }
    // Last-ditch: a bare `index.<ext>` inside the package directory.
    resolve_file_or_index(&pkg_dir.join("index")).ok_or_else(|| ModuleError::NotFound {
        specifier: specifier.to_string(),
        importer: importer.to_path_buf(),
    })
}

/// Walk up from `dir` to the filesystem root, returning the first existing
/// `<ancestor>/node_modules/<name>` directory.
fn find_package_dir(dir: &Path, name: &str) -> Option<PathBuf> {
    let mut current = Some(dir);
    while let Some(d) = current {
        let candidate = d.join("node_modules").join(name);
        if candidate.is_dir() {
            return Some(normalize(&candidate));
        }
        current = d.parent();
    }
    None
}

/// Split a bare specifier into `(package_name, optional_subpath)`. A leading
/// `@scope/` is part of the package name, so the first path segment after the
/// scope (if any) is the boundary.
///
/// - `lodash` -> (`lodash`, `None`)
/// - `lodash/fp` -> (`lodash`, `Some("fp")`)
/// - `lodash/fp/curry` -> (`lodash`, `Some("fp/curry")`)
/// - `@scope/pkg` -> (`@scope/pkg`, `None`)
/// - `@scope/pkg/sub/x` -> (`@scope/pkg`, `Some("sub/x")`)
fn parse_bare_specifier(specifier: &str) -> (&str, Option<&str>) {
    if let Some(rest) = specifier.strip_prefix('@') {
        // Scoped: the name spans two segments (`@scope/pkg`).
        match rest.split_once('/') {
            // No slash after `@scope` — malformed, but treat the whole thing as
            // the name and let resolution fail with NotFound.
            None => (specifier, None),
            Some((_scope, after_scope)) => match after_scope.split_once('/') {
                // `@scope/pkg`
                None => (specifier, None),
                // `@scope/pkg/sub...` — name is everything up to the 2nd slash.
                Some((_pkg, sub)) => {
                    let name_len = specifier.len() - sub.len() - 1; // drop the '/'
                    (&specifier[..name_len], Some(sub))
                }
            },
        }
    } else {
        match specifier.split_once('/') {
            None => (specifier, None),
            Some((name, sub)) => (name, Some(sub)),
        }
    }
}

/// Read `<pkgDir>/package.json` and return candidate entry paths (relative to
/// the package directory) in preference order: the `exports` `"."` targets, then
/// `main`. The caller tries each against the filesystem.
fn package_entries(pkg_dir: &Path) -> Vec<String> {
    match std::fs::read_to_string(pkg_dir.join("package.json")) {
        Ok(text) => extract_package_entries(&text),
        Err(_) => Vec::new(),
    }
}

/// Minimal, hand-rolled extraction of an entry from package.json text.
///
/// Resolution order (matching Node's preference for ESM packages):
///   1. A top-level `"exports"` field:
///      - a bare string (`"exports": "./i.js"`), or
///      - an object's `"."` key (`{ ".": "./i.js" }`), which may itself be a
///        string or a conditional object whose `import`/`default`/`require`
///        keys are tried in that order.
///   2. A top-level `"main"` string.
///
/// Returns `None` if neither is found; the caller then defaults to `index.js`.
/// This is intentionally shallow (see module docs): it does not handle arrays,
/// nested non-`.` subpath patterns, comments, or escaped quotes inside values.
#[cfg(test)]
fn extract_package_entry(text: &str) -> Option<String> {
    extract_package_entries(text).into_iter().next()
}

/// All candidate entry paths for a package, in preference order: the `exports`
/// `"."` targets (across recognized conditions) followed by `main`. The caller
/// tries each against the filesystem, so a package whose preferred-condition
/// target is missing still resolves via a later candidate.
fn extract_package_entries(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(manifest) = serde_json::from_str::<serde_json::Value>(text)
        && let Some(exports) = manifest.get("exports")
    {
        collect_exports_targets(exports, &mut out);
    }
    if let Some(main) = extract_json_string_field(text, "main") {
        out.push(main);
    }
    out
}

/// Collect an `exports` value's targets: a bare string, a `"."` subpath map, or
/// a bare condition object.
fn collect_exports_targets(exports: &serde_json::Value, out: &mut Vec<String>) {
    match exports {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Object(map) => {
            // Keys starting with "." mean a subpath map → use the "." entry;
            // otherwise the object is itself a set of conditions.
            if map.keys().any(|k| k.starts_with('.')) {
                if let Some(dot) = map.get(".") {
                    collect_conditions(dot, out);
                }
            } else {
                collect_conditions(exports, out);
            }
        }
        _ => {}
    }
}

/// Collect a conditional-exports value's targets in preference order. velox
/// bundles to CommonJS, so it prefers the `require` build (avoids the
/// ESM-default-interop pitfall on a package's internal `require()` calls), then
/// falls back to `default`/`import`. Unknown conditions (`types`, `@zod/source`,
/// `browser`, …) are ignored.
fn collect_conditions(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Object(map) => {
            for cond in ["node", "require", "default", "import", "module"] {
                if let Some(target) = map.get(cond) {
                    collect_conditions(target, out);
                }
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_conditions(item, out);
            }
        }
        _ => {}
    }
}

/// Find a top-level `"main"`-style string field anywhere in the text and return
/// its value. Whitespace-robust; assumes the value is a plain string.
fn extract_json_string_field(text: &str, key: &str) -> Option<String> {
    let after = find_field_value_start(text, key)?;
    let rest = after.trim_start();
    if rest.starts_with('"') {
        read_json_string(rest)
    } else {
        None
    }
}

/// Locate `"<key>"` followed (after optional whitespace) by `:`, returning the
/// slice immediately AFTER the colon. Searches every occurrence so a key inside
/// a nested object can be found too.
fn find_field_value_start<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    let needle = format!("\"{}\"", key);
    let mut from = 0usize;
    while let Some(pos) = text[from..].find(&needle) {
        let abs = from + pos;
        let after_key = &text[abs + needle.len()..];
        let trimmed = after_key.trim_start();
        if let Some(after_colon) = trimmed.strip_prefix(':') {
            return Some(after_colon);
        }
        from = abs + needle.len();
    }
    None
}

/// Read a JSON string literal that `s` is positioned at (must start with `"`),
/// returning its contents with simple `\"` and `\\` unescaping. Stops at the
/// closing quote.
fn read_json_string(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'"') {
        return None;
    }
    let mut out = String::new();
    let mut chars = s[1..].chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => return Some(out),
            '\\' => match chars.next() {
                Some('"') => out.push('"'),
                Some('\\') => out.push('\\'),
                Some('/') => out.push('/'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some(other) => out.push(other),
                None => return None,
            },
            other => out.push(other),
        }
    }
    None
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

/// Append `.ext` to a path's file name, preserving any existing one
/// (`foo` -> `foo.ts`, `foo.js` -> `foo.js.ts`). This is intentional so the
/// "exact" check in `resolve` handles already-extensioned paths.
fn append_ext(path: &Path, ext: &str) -> PathBuf {
    let mut s = path.as_os_str().to_os_string();
    s.push(".");
    s.push(ext);
    PathBuf::from(s)
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
    fn append_ext_adds_extension() {
        assert_eq!(append_ext(Path::new("a/b"), "ts"), PathBuf::from("a/b.ts"));
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
    fn parse_bare_unscoped() {
        assert_eq!(parse_bare_specifier("lodash"), ("lodash", None));
        assert_eq!(parse_bare_specifier("lodash/fp"), ("lodash", Some("fp")));
        assert_eq!(
            parse_bare_specifier("lodash/fp/curry"),
            ("lodash", Some("fp/curry"))
        );
    }

    #[test]
    fn parse_bare_scoped() {
        assert_eq!(parse_bare_specifier("@scope/pkg"), ("@scope/pkg", None));
        assert_eq!(
            parse_bare_specifier("@scope/pkg/sub"),
            ("@scope/pkg", Some("sub"))
        );
        assert_eq!(
            parse_bare_specifier("@scope/pkg/sub/deep"),
            ("@scope/pkg", Some("sub/deep"))
        );
    }

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

    #[test]
    fn find_package_dir_walks_up() {
        let tmp = std::env::temp_dir().join(format!("velox_walk_{}", std::process::id()));
        let nested = tmp.join("a").join("b").join("c");
        // Package lives two levels up, under a/node_modules/greet.
        let pkg = tmp.join("a").join("node_modules").join("greet");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::create_dir_all(&nested).unwrap();

        let found = find_package_dir(&nested, "greet").expect("should find package");
        assert_eq!(found, normalize(&pkg));

        // A name that does not exist anywhere returns None.
        assert!(find_package_dir(&nested, "nope").is_none());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn find_package_dir_scoped() {
        let tmp = std::env::temp_dir().join(format!("velox_scoped_{}", std::process::id()));
        let here = tmp.join("proj");
        let pkg = here.join("node_modules").join("@scope").join("pkg");
        std::fs::create_dir_all(&pkg).unwrap();

        let found = find_package_dir(&here, "@scope/pkg").expect("scoped package");
        assert_eq!(found, normalize(&pkg));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    // --- package.json entry selection ---------------------------------

    #[test]
    fn entry_prefers_exports_over_main() {
        let json = r#"{ "main": "./main.js", "exports": "./exp.js" }"#;
        assert_eq!(extract_package_entry(json).as_deref(), Some("./exp.js"));
    }

    #[test]
    fn entry_exports_string() {
        let json = r#"{ "exports": "./i.js" }"#;
        assert_eq!(extract_package_entry(json).as_deref(), Some("./i.js"));
    }

    #[test]
    fn entry_exports_dot_string() {
        let json = r#"{ "exports": { ".": "./dot.js" } }"#;
        assert_eq!(extract_package_entry(json).as_deref(), Some("./dot.js"));
    }

    #[test]
    fn entry_exports_dot_conditional_prefers_require() {
        // velox bundles to CommonJS, so it prefers the `require` build (avoids
        // the ESM-default-interop pitfall on internal `require()` calls).
        let json = r#"{
            "exports": { ".": { "import": "./esm.js", "require": "./cjs.js", "default": "./d.js" } }
        }"#;
        assert_eq!(extract_package_entry(json).as_deref(), Some("./cjs.js"));
    }

    #[test]
    fn entry_exports_skips_unknown_conditions() {
        // Non-standard conditions (types, @scope/source) are ignored; falls to import.
        let json = r#"{
            "exports": { ".": { "@acme/source": "./src.ts", "types": "./t.d.ts", "import": "./esm.js" } }
        }"#;
        assert_eq!(extract_package_entry(json).as_deref(), Some("./esm.js"));
    }

    #[test]
    fn entry_exports_dot_conditional_falls_back_to_default_then_require() {
        let only_default = r#"{ "exports": { ".": { "default": "./d.js" } } }"#;
        assert_eq!(
            extract_package_entry(only_default).as_deref(),
            Some("./d.js")
        );
        let only_require = r#"{ "exports": { ".": { "require": "./r.js" } } }"#;
        assert_eq!(
            extract_package_entry(only_require).as_deref(),
            Some("./r.js")
        );
    }

    #[test]
    fn entry_main_when_no_exports() {
        let json = r#"{ "name": "x", "main": "lib/index.js", "version": "1.0.0" }"#;
        assert_eq!(extract_package_entry(json).as_deref(), Some("lib/index.js"));
    }

    #[test]
    fn entry_none_when_neither() {
        let json = r#"{ "name": "x", "version": "1.0.0" }"#;
        assert_eq!(extract_package_entry(json), None);
    }

    #[test]
    fn entry_whitespace_robust() {
        let json = "{\n  \"exports\"   :   {\n    \".\" :  \"./ws.js\"\n  }\n}";
        assert_eq!(extract_package_entry(json).as_deref(), Some("./ws.js"));
    }

    #[test]
    fn read_json_string_unescapes() {
        assert_eq!(read_json_string(r#""abc""#).as_deref(), Some("abc"));
        assert_eq!(read_json_string(r#""a\"b""#).as_deref(), Some("a\"b"));
        assert_eq!(read_json_string(r#""a/b": 1"#).as_deref(), Some("a/b"));
    }
}

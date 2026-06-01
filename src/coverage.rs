//! Code-coverage instrumentation for `velox test --coverage`.
//!
//! When active, [`instrument_or_transpile`] replaces the plain transpile step in
//! the bundler (`module.rs`) for *local* source files: every statement and
//! function body gets a `__VCOV(n)` counter call injected, where `n` indexes a
//! point table recorded here. At runtime the injected counters populate a global
//! hit array; the test runner (`builtins/test.js`) reads that array plus the
//! point table (emitted by [`Coverage::prelude_js`]) and prints a coverage
//! report. All reporting lives in JS — Rust only instruments and ships the map.
//!
//! Granularity is statement + function level (istanbul-style). Single-statement
//! un-braced bodies (`if (x) return;`) and import/export/function declarations
//! aren't counted as line points, so they're simply excluded from the
//! denominator rather than mis-reported.

use std::cell::RefCell;
use std::path::Path;

use oxc::allocator::{Allocator, TakeIn, Vec as OxcVec};
use oxc::ast::ast::{
    Argument, ArrowFunctionExpression, ConditionalExpression, Expression, Function, IfStatement,
    Statement, SwitchStatement,
};
use oxc::ast::{AstBuilder, NONE};
use oxc::ast_visit::VisitMut;
use oxc::ast_visit::walk_mut::{
    walk_arrow_function_expression, walk_conditional_expression, walk_function, walk_if_statement,
    walk_statements, walk_switch_statement,
};
use oxc::codegen::Codegen;
use oxc::diagnostics::OxcDiagnostic;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::{GetSpan, SPAN, SourceType};
use oxc::syntax::number::NumberBase;
use oxc::syntax::scope::ScopeFlags;
use oxc::transformer::{TransformOptions, Transformer};

/// What an instrumented point measures (mirrored in the JS point table).
const KIND_STMT: u8 = 0;
const KIND_FN: u8 = 1;
const KIND_BRANCH: u8 = 2;

/// One instrumented point. Its index in [`Coverage::points`] is the `n` passed
/// to the injected `__VCOV(n)` call. `group` ties the arms of one branch point
/// (if/ternary/switch) together; it's 0 for statements and functions.
struct Point {
    file: u32,
    line: u32,
    kind: u8,
    group: u32,
}

/// Accumulates the point table across every instrumented module in one bundle.
#[derive(Default)]
pub struct Coverage {
    /// Display paths (relative to cwd when possible), indexed by file id.
    files: Vec<String>,
    points: Vec<Point>,
    /// Monotonic id handed to each branch point so its arms group together.
    next_group: u32,
}

thread_local! {
    /// The collector for the in-progress coverage build, if any. Set by
    /// [`begin`], drained by [`finish`].
    static ACTIVE: RefCell<Option<Coverage>> = const { RefCell::new(None) };
}

/// Start collecting coverage for the bundle about to be built on this thread.
pub fn begin() {
    ACTIVE.with(|a| *a.borrow_mut() = Some(Coverage::default()));
}

/// Stop collecting and return what was gathered (None if [`begin`] wasn't called).
pub fn finish() -> Option<Coverage> {
    ACTIVE.with(|a| a.borrow_mut().take())
}

/// Whether coverage collection is active on this thread.
pub fn is_active() -> bool {
    ACTIVE.with(|a| a.borrow().is_some())
}

/// The bundler's transpile hook: instrument when coverage is active and `path`
/// is a coverable local source file, else fall back to a plain transpile. Also
/// returns codegen source-map tokens for stack-frame mapping (empty when the
/// module is coverage-instrumented, since its line numbers no longer match the
/// original source).
pub fn instrument_or_transpile_mapped(
    path: &Path,
    source: &str,
) -> Result<(String, crate::transpile::MapTokens), Vec<OxcDiagnostic>> {
    if is_active() && is_coverable(path) {
        let code = ACTIVE.with(|a| {
            a.borrow_mut()
                .as_mut()
                .expect("active")
                .instrument(path, source)
        })?;
        Ok((code, Vec::new()))
    } else {
        crate::transpile::transpile_with_map(path, source, true)
    }
}

/// A file is coverable if it's a JS/TS source that isn't a dependency, a test
/// file, or the generated test driver — i.e. the actual source under test.
fn is_coverable(path: &Path) -> bool {
    let ext_ok = matches!(
        path.extension().and_then(|e| e.to_str()),
        Some("ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs")
    );
    if !ext_ok {
        return false;
    }
    if path.components().any(|c| c.as_os_str() == "node_modules") {
        return false;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.starts_with(".velox-test-") || name.contains(".test.") || name.contains(".spec.") {
        return false;
    }
    !path
        .components()
        .any(|c| matches!(c.as_os_str().to_str(), Some("test" | "tests" | "__tests__")))
}

impl Coverage {
    /// Transpile `source` like `transpile::transpile`, but inject `__VCOV(n)`
    /// counters and record each point against `path`.
    fn instrument(&mut self, path: &Path, source: &str) -> Result<String, Vec<OxcDiagnostic>> {
        let file_id = self.files.len() as u32;
        self.files.push(display_path(path));
        let line_starts = line_starts(source);

        let allocator = Allocator::default();
        let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::ts());

        let parser_ret = Parser::new(&allocator, source, source_type).parse();
        if !parser_ret.errors.is_empty() {
            return Err(parser_ret.errors);
        }
        let mut program = parser_ret.program;

        let scoping = SemanticBuilder::new()
            .with_enum_eval(true)
            .build(&program)
            .semantic
            .into_scoping();
        let options = TransformOptions::default();
        let transformer_ret =
            Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
        if !transformer_ret.errors.is_empty() {
            return Err(transformer_ret.errors);
        }

        let mut instr = Instrumenter {
            builder: AstBuilder::new(&allocator),
            points: &mut self.points,
            next_group: &mut self.next_group,
            file_id,
            line_starts: &line_starts,
        };
        instr.visit_program(&mut program);

        Ok(Codegen::new().build(&program).code)
    }

    /// JS prelude that defines the runtime counter + the point table, evaluated
    /// before any instrumented module runs. Prepended to the coverage bundle.
    pub fn prelude_js(&self) -> String {
        let mut s = String::from(
            "globalThis.__VCOV_H=[];\
             globalThis.__VCOV=function(n){__VCOV_H[n]=(__VCOV_H[n]|0)+1;};\
             globalThis.__VCOV_MAP={\"files\":[",
        );
        for (i, f) in self.files.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&json_string(f));
        }
        s.push_str("],\"points\":[");
        for (i, p) in self.points.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            // [file, line, kind, group]
            s.push_str(&format!("[{},{},{},{}]", p.file, p.line, p.kind, p.group));
        }
        s.push_str("]};\n");
        s
    }

    /// Whether anything was instrumented (no points → nothing to report).
    pub fn is_empty(&self) -> bool {
        self.points.is_empty()
    }
}

/// Injects `__VCOV(n)` counters before each statement, at the top of each
/// function body, and into each branch arm (if/ternary/switch).
struct Instrumenter<'a, 'c> {
    builder: AstBuilder<'a>,
    points: &'c mut Vec<Point>,
    next_group: &'c mut u32,
    file_id: u32,
    line_starts: &'c [u32],
}

impl<'a> Instrumenter<'a, '_> {
    /// Record a point of `kind` (in `group` for branches) and return its index.
    fn new_point(&mut self, line: u32, kind: u8, group: u32) -> u32 {
        let id = self.points.len() as u32;
        self.points.push(Point {
            file: self.file_id,
            line,
            kind,
            group,
        });
        id
    }

    /// Allocate a fresh branch-group id (shared by one branch point's arms).
    fn new_group(&mut self) -> u32 {
        let g = *self.next_group;
        *self.next_group += 1;
        g
    }

    /// 1-based line for a byte offset.
    fn line_of(&self, offset: u32) -> u32 {
        (self.line_starts.partition_point(|&s| s <= offset)) as u32
    }

    /// Build the expression `__VCOV(id)` (used inline in branch arms).
    fn counter_expr(&self, id: u32) -> Expression<'a> {
        let b = self.builder;
        let callee = b.expression_identifier(SPAN, "__VCOV");
        let arg = Argument::from(b.expression_numeric_literal(
            SPAN,
            id as f64,
            None,
            NumberBase::Decimal,
        ));
        let args = OxcVec::from_iter_in([arg], b.allocator);
        b.expression_call(SPAN, callee, NONE, args, false)
    }

    /// Build the statement `__VCOV(id);`.
    fn counter(&self, id: u32) -> Statement<'a> {
        let call = self.counter_expr(id);
        self.builder.statement_expression(SPAN, call)
    }

    /// Prepend a branch counter to a statement arm, wrapping a bare (non-block)
    /// statement in a block so the counter has somewhere to live.
    fn instrument_arm(&mut self, stmt: &mut Statement<'a>, id: u32) {
        let counter = self.counter(id);
        if let Statement::BlockStatement(block) = stmt {
            block.body.insert(0, counter);
        } else {
            let original = stmt.take_in(self.builder.allocator);
            let body = OxcVec::from_iter_in([counter, original], self.builder.allocator);
            *stmt = self.builder.statement_block(SPAN, body);
        }
    }

    /// Wrap an expression arm as `(__VCOV(id), expr)` so the counter fires
    /// without changing the value the arm yields.
    fn instrument_expr_arm(&mut self, expr: &mut Expression<'a>, id: u32) {
        let counter = self.counter_expr(id);
        let original = expr.take_in(self.builder.allocator);
        let seq = OxcVec::from_iter_in([counter, original], self.builder.allocator);
        *expr = self.builder.expression_sequence(SPAN, seq);
    }
}

/// Statements we don't put a line-counter in front of: hoisted declarations
/// (covered via function coverage instead), module syntax, and our own injected
/// counters (so re-walking can't double-instrument them).
fn skip_line_point(stmt: &Statement) -> bool {
    match stmt {
        Statement::FunctionDeclaration(_)
        | Statement::ImportDeclaration(_)
        | Statement::ExportNamedDeclaration(_)
        | Statement::ExportDefaultDeclaration(_)
        | Statement::ExportAllDeclaration(_)
        | Statement::EmptyStatement(_) => true,
        Statement::ExpressionStatement(es) => is_counter_call(&es.expression),
        _ => false,
    }
}

/// True for an already-injected `__VCOV(...)` call expression.
fn is_counter_call(expr: &Expression) -> bool {
    if let Expression::CallExpression(call) = expr
        && let Expression::Identifier(id) = &call.callee
    {
        return id.name == "__VCOV";
    }
    false
}

impl<'a> VisitMut<'a> for Instrumenter<'a, '_> {
    fn visit_statements(&mut self, stmts: &mut OxcVec<'a, Statement<'a>>) {
        let mut rebuilt = OxcVec::with_capacity_in(stmts.len() * 2, self.builder.allocator);
        for stmt in stmts.drain(..) {
            if !skip_line_point(&stmt) {
                let line = self.line_of(stmt.span().start);
                if line > 0 {
                    let id = self.new_point(line, KIND_STMT, 0);
                    rebuilt.push(self.counter(id));
                }
            }
            rebuilt.push(stmt);
        }
        *stmts = rebuilt;
        // Recurse so nested blocks / function bodies get instrumented too.
        walk_statements(self, stmts);
    }

    fn visit_function(&mut self, func: &mut Function<'a>, flags: ScopeFlags) {
        if let Some(body) = &mut func.body {
            let line = self.line_of(func.span.start);
            if line > 0 {
                let id = self.new_point(line, KIND_FN, 0);
                let counter = self.counter(id);
                body.statements.insert(0, counter);
            }
        }
        walk_function(self, func, flags);
    }

    fn visit_arrow_function_expression(&mut self, arrow: &mut ArrowFunctionExpression<'a>) {
        // Block-bodied arrows count as functions; expression-bodied arrows
        // (`x => x + 1`) have no statement list to prepend to and are covered
        // transitively by their enclosing statement.
        if !arrow.expression {
            let line = self.line_of(arrow.span.start);
            if line > 0 {
                let id = self.new_point(line, KIND_FN, 0);
                let counter = self.counter(id);
                arrow.body.statements.insert(0, counter);
            }
        }
        walk_arrow_function_expression(self, arrow);
    }

    fn visit_if_statement(&mut self, if_stmt: &mut IfStatement<'a>) {
        let group = self.new_group();
        // Consequent arm.
        let cline = self.line_of(if_stmt.consequent.span().start);
        let cid = self.new_point(cline, KIND_BRANCH, group);
        self.instrument_arm(&mut if_stmt.consequent, cid);
        // Alternate arm — synthesize an `else { … }` when there's no source one
        // so the "condition was false" path is still counted.
        let aline = match &if_stmt.alternate {
            Some(alt) => self.line_of(alt.span().start),
            None => self.line_of(if_stmt.span.start),
        };
        let aid = self.new_point(aline, KIND_BRANCH, group);
        match &mut if_stmt.alternate {
            Some(alt) => self.instrument_arm(alt, aid),
            None => {
                let counter = self.counter(aid);
                let body = OxcVec::from_iter_in([counter], self.builder.allocator);
                if_stmt.alternate = Some(self.builder.statement_block(SPAN, body));
            }
        }
        walk_if_statement(self, if_stmt);
    }

    fn visit_conditional_expression(&mut self, cond: &mut ConditionalExpression<'a>) {
        let group = self.new_group();
        let cline = self.line_of(cond.consequent.span().start);
        let cid = self.new_point(cline, KIND_BRANCH, group);
        self.instrument_expr_arm(&mut cond.consequent, cid);
        let aline = self.line_of(cond.alternate.span().start);
        let aid = self.new_point(aline, KIND_BRANCH, group);
        self.instrument_expr_arm(&mut cond.alternate, aid);
        walk_conditional_expression(self, cond);
    }

    fn visit_switch_statement(&mut self, switch: &mut SwitchStatement<'a>) {
        let group = self.new_group();
        for case in switch.cases.iter_mut() {
            let line = self.line_of(case.span.start);
            let id = self.new_point(line, KIND_BRANCH, group);
            let counter = self.counter(id);
            case.consequent.insert(0, counter);
        }
        walk_switch_statement(self, switch);
    }
}

/// Byte offsets at which each line begins (`line_starts[0] == 0`). Used to map a
/// span offset back to a 1-based line via `partition_point`.
fn line_starts(source: &str) -> Vec<u32> {
    let mut starts = vec![0u32];
    for (i, b) in source.bytes().enumerate() {
        if b == b'\n' {
            starts.push((i + 1) as u32);
        }
    }
    starts
}

/// A path relative to the cwd when possible (shorter report rows), else as-is.
fn display_path(path: &Path) -> String {
    if let Ok(cwd) = std::env::current_dir()
        && let Ok(rel) = path.strip_prefix(&cwd)
    {
        return rel.to_string_lossy().into_owned();
    }
    path.to_string_lossy().into_owned()
}

/// Minimal JSON string escaping for file paths.
fn json_string(s: &str) -> String {
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

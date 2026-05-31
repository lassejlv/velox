//! TypeScript/JSX → JavaScript transpilation via oxc.
//!
//! We only *strip* TypeScript and lower JSX — there's no module system yet,
//! so imports/exports are left as-is for JavaScriptCore to choke on (by design).

use std::path::Path;

use oxc::allocator::Allocator;
use oxc::codegen::Codegen;
use oxc::diagnostics::OxcDiagnostic;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};

/// Transpile `source` (named by `path`, which drives language inference) into
/// plain JavaScript. Returns the generated code, or the collected diagnostics.
pub fn transpile(path: &Path, source: &str) -> Result<String, Vec<OxcDiagnostic>> {
    let allocator = Allocator::default();

    // Infer TS/TSX/JSX/JS from the extension; unknown extensions are treated
    // as TypeScript so the REPL accepts type annotations.
    let source_type = SourceType::from_path(path).unwrap_or_else(|_| SourceType::ts());

    let parser_ret = Parser::new(&allocator, source, source_type).parse();
    if !parser_ret.errors.is_empty() {
        return Err(parser_ret.errors);
    }
    let mut program = parser_ret.program;

    // The transformer needs scope/symbol information to rename bindings safely.
    let scoping = SemanticBuilder::new()
        .with_enum_eval(true) // required for `enum` lowering
        .build(&program)
        .semantic
        .into_scoping();

    let options = TransformOptions::default();
    let transformer_ret =
        Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
    if !transformer_ret.errors.is_empty() {
        return Err(transformer_ret.errors);
    }

    Ok(Codegen::new().build(&program).code)
}

//! TypeScript/JSX → JavaScript transpilation via oxc.
//!
//! We only *strip* TypeScript and lower JSX — there's no module system yet,
//! so imports/exports are left as-is for JavaScriptCore to choke on (by design).

use std::path::Path;

use oxc::allocator::Allocator;
use oxc::codegen::{Codegen, CodegenOptions};
use oxc::diagnostics::OxcDiagnostic;
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};

/// A flattened source-map token: `(generated_line, generated_col, source_line)`,
/// all 0-based. Enough to map a generated line back to its original line; the
/// generating file is tracked per-module by the bundler, so the source id isn't
/// needed here.
pub type MapTokens = Vec<(u32, u32, u32)>;

/// Transpile `source` (named by `path`, which drives language inference) into
/// plain JavaScript. Returns the generated code, or the collected diagnostics.
pub fn transpile(path: &Path, source: &str) -> Result<String, Vec<OxcDiagnostic>> {
    Ok(transpile_with_map(path, source, false)?.0)
}

/// Like [`transpile`], but also returns codegen source-map tokens when
/// `with_map` is set (used by the bundler to map runtime stack frames back to
/// original source lines).
pub fn transpile_with_map(
    path: &Path,
    source: &str,
    with_map: bool,
) -> Result<(String, MapTokens), Vec<OxcDiagnostic>> {
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

    let codegen = if with_map {
        Codegen::new().with_options(CodegenOptions {
            source_map_path: Some(path.to_path_buf()),
            ..CodegenOptions::default()
        })
    } else {
        Codegen::new()
    };
    let ret = codegen.build(&program);
    // Flatten the map to plain tuples so the rest of velox needs no
    // `oxc_sourcemap` types (it's only a transitive dependency).
    let tokens = ret
        .map
        .map(|m| {
            m.get_tokens()
                .map(|t| (t.get_dst_line(), t.get_dst_col(), t.get_src_line()))
                .collect()
        })
        .unwrap_or_default();
    Ok((ret.code, tokens))
}

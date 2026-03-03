use oxc_allocator::Allocator;
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};
use std::path::Path;

pub fn transpile_typescript(source: &str, filename: &str) -> Result<String, String> {
    let allocator = Allocator::default();

    let source_type = if filename.ends_with(".tsx") {
        SourceType::tsx()
    } else {
        SourceType::ts()
    };

    let ret = Parser::new(&allocator, source, source_type).parse();

    if !ret.errors.is_empty() {
        return Err(ret
            .errors
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("\n"));
    }

    let mut program = ret.program;

    let semantic = SemanticBuilder::new().build(&program).semantic;
    let scoping = semantic.into_scoping();

    let transform_options = TransformOptions::default();
    let transformer = Transformer::new(&allocator, Path::new(filename), &transform_options);
    let transform_ret = transformer.build_with_scoping(scoping, &mut program);

    if !transform_ret.errors.is_empty() {
        return Err(transform_ret
            .errors
            .iter()
            .map(|e| e.to_string())
            .collect::<Vec<_>>()
            .join("\n"));
    }

    let code = Codegen::new()
        .with_scoping(Some(transform_ret.scoping))
        .build(&program)
        .code;

    Ok(code)
}

pub fn is_typescript(filename: &str) -> bool {
    filename.ends_with(".ts") || filename.ends_with(".tsx")
}

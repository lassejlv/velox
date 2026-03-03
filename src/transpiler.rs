use oxc_allocator::Allocator;
use oxc_codegen::{Codegen, CodegenOptions};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};
use std::fs;
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

/// Format a JavaScript/TypeScript file using oxc's code generator
pub fn format_file(path: &str) -> Result<(), String> {
    let source = fs::read_to_string(path).map_err(|e| format!("Cannot read file: {}", e))?;

    let allocator = Allocator::default();
    let source_type = get_source_type(path);

    let ret = Parser::new(&allocator, &source, source_type).parse();

    if !ret.errors.is_empty() {
        return Err(ret
            .errors
            .iter()
            .map(|e| format!("{}: {}", path, e))
            .collect::<Vec<_>>()
            .join("\n"));
    }

    // Use codegen with minify=false for readable formatting
    let codegen_options = CodegenOptions::default();
    let formatted = Codegen::new()
        .with_options(codegen_options)
        .build(&ret.program)
        .code;

    // Only write if content changed
    if formatted != source {
        fs::write(path, formatted).map_err(|e| format!("Cannot write file: {}", e))?;
    }

    Ok(())
}

/// Check syntax of a JavaScript/TypeScript file
pub fn check_syntax(path: &str) -> Result<(), String> {
    let source = fs::read_to_string(path).map_err(|e| format!("Cannot read file: {}", e))?;

    let allocator = Allocator::default();
    let source_type = get_source_type(path);

    let ret = Parser::new(&allocator, &source, source_type).parse();

    if !ret.errors.is_empty() {
        return Err(ret
            .errors
            .iter()
            .map(|e| format!("{}: {}", path, e))
            .collect::<Vec<_>>()
            .join("\n"));
    }

    Ok(())
}

fn get_source_type(path: &str) -> SourceType {
    if path.ends_with(".tsx") {
        SourceType::tsx()
    } else if path.ends_with(".ts") {
        SourceType::ts()
    } else if path.ends_with(".jsx") {
        SourceType::jsx()
    } else if path.ends_with(".mjs") {
        SourceType::mjs()
    } else {
        SourceType::mjs() // Default to JS with ESM
    }
}

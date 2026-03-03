use rusty_v8 as v8;
use std::path::{Path, PathBuf, MAIN_SEPARATOR};

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    // Get or create Velox object
    let velox_key = v8::String::new(scope, "Velox").unwrap();
    let velox = match global.get(scope, velox_key.into()) {
        Some(v) if v.is_object() => v8::Local::<v8::Object>::try_from(v).unwrap(),
        _ => {
            let obj = v8::Object::new(scope);
            global.set(scope, velox_key.into(), obj.into());
            obj
        }
    };

    // Create path namespace
    let path_obj = v8::Object::new(scope);

    // Path manipulation functions
    set_function(scope, path_obj, "join", join);
    set_function(scope, path_obj, "resolve", resolve);
    set_function(scope, path_obj, "dirname", dirname);
    set_function(scope, path_obj, "basename", basename);
    set_function(scope, path_obj, "extname", extname);
    set_function(scope, path_obj, "normalize", normalize);
    set_function(scope, path_obj, "isAbsolute", is_absolute);
    set_function(scope, path_obj, "relative", relative);
    set_function(scope, path_obj, "parse", parse);
    set_function(scope, path_obj, "format", format);

    // Constants
    let sep_key = v8::String::new(scope, "sep").unwrap();
    let sep_val = v8::String::new(scope, &MAIN_SEPARATOR.to_string()).unwrap();
    path_obj.set(scope, sep_key.into(), sep_val.into());

    let delimiter_key = v8::String::new(scope, "delimiter").unwrap();
    let delimiter_val = if cfg!(windows) { ";" } else { ":" };
    let delimiter_str = v8::String::new(scope, delimiter_val).unwrap();
    path_obj.set(scope, delimiter_key.into(), delimiter_str.into());

    let path_key = v8::String::new(scope, "path").unwrap();
    velox.set(scope, path_key.into(), path_obj.into());
}

fn set_function(
    scope: &mut v8::ContextScope<v8::HandleScope>,
    obj: v8::Local<v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let func = v8::Function::new(scope, callback).unwrap();
    let key = v8::String::new(scope, name).unwrap();
    obj.set(scope, key.into(), func.into());
}

// Velox.path.join(...paths: string[]): string
fn join(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let mut path = PathBuf::new();

    for i in 0..args.length() {
        let arg = args.get(i);
        if arg.is_string() {
            let s = arg.to_rust_string_lossy(scope);
            if s.starts_with('/') && i > 0 {
                // Absolute path resets
                path = PathBuf::from(&s);
            } else {
                path.push(&s);
            }
        }
    }

    let result = path.to_string_lossy();
    let result_str = v8::String::new(scope, &result).unwrap();
    rv.set(result_str.into());
}

// Velox.path.resolve(...paths: string[]): string
fn resolve(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let mut path = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));

    for i in 0..args.length() {
        let arg = args.get(i);
        if arg.is_string() {
            let s = arg.to_rust_string_lossy(scope);
            let p = Path::new(&s);
            if p.is_absolute() {
                path = p.to_path_buf();
            } else {
                path.push(&s);
            }
        }
    }

    // Normalize the path
    let normalized = normalize_path(&path);
    let result_str = v8::String::new(scope, &normalized).unwrap();
    rv.set(result_str.into());
}

// Velox.path.dirname(path: string): string
fn dirname(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path_arg = args.get(0);
    if !path_arg.is_string() {
        let result = v8::String::new(scope, ".").unwrap();
        rv.set(result.into());
        return;
    }

    let path_str = path_arg.to_rust_string_lossy(scope);
    let path = Path::new(&path_str);

    let result = match path.parent() {
        Some(p) if p.to_string_lossy().is_empty() => ".",
        Some(p) => &p.to_string_lossy(),
        None => ".",
    };

    let result_str = v8::String::new(scope, result).unwrap();
    rv.set(result_str.into());
}

// Velox.path.basename(path: string, suffix?: string): string
fn basename(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path_arg = args.get(0);
    if !path_arg.is_string() {
        let result = v8::String::new(scope, "").unwrap();
        rv.set(result.into());
        return;
    }

    let path_str = path_arg.to_rust_string_lossy(scope);
    let path = Path::new(&path_str);

    let mut name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // Handle suffix
    if args.length() > 1 {
        let suffix_arg = args.get(1);
        if suffix_arg.is_string() {
            let suffix = suffix_arg.to_rust_string_lossy(scope);
            if name.ends_with(&suffix) {
                name = name[..name.len() - suffix.len()].to_string();
            }
        }
    }

    let result_str = v8::String::new(scope, &name).unwrap();
    rv.set(result_str.into());
}

// Velox.path.extname(path: string): string
fn extname(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path_arg = args.get(0);
    if !path_arg.is_string() {
        let result = v8::String::new(scope, "").unwrap();
        rv.set(result.into());
        return;
    }

    let path_str = path_arg.to_rust_string_lossy(scope);
    let path = Path::new(&path_str);

    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();

    let result_str = v8::String::new(scope, &ext).unwrap();
    rv.set(result_str.into());
}

// Velox.path.normalize(path: string): string
fn normalize(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path_arg = args.get(0);
    if !path_arg.is_string() {
        let result = v8::String::new(scope, ".").unwrap();
        rv.set(result.into());
        return;
    }

    let path_str = path_arg.to_rust_string_lossy(scope);
    let normalized = normalize_path(Path::new(&path_str));

    let result_str = v8::String::new(scope, &normalized).unwrap();
    rv.set(result_str.into());
}

// Velox.path.isAbsolute(path: string): boolean
fn is_absolute(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path_arg = args.get(0);
    if !path_arg.is_string() {
        rv.set(v8::Boolean::new(scope, false).into());
        return;
    }

    let path_str = path_arg.to_rust_string_lossy(scope);
    let is_abs = Path::new(&path_str).is_absolute();

    rv.set(v8::Boolean::new(scope, is_abs).into());
}

// Velox.path.relative(from: string, to: string): string
fn relative(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let from_arg = args.get(0);
    let to_arg = args.get(1);

    if !from_arg.is_string() || !to_arg.is_string() {
        let result = v8::String::new(scope, "").unwrap();
        rv.set(result.into());
        return;
    }

    let from_str = from_arg.to_rust_string_lossy(scope);
    let to_str = to_arg.to_rust_string_lossy(scope);

    // Make paths absolute
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));

    let from_path = if Path::new(&from_str).is_absolute() {
        PathBuf::from(&from_str)
    } else {
        cwd.join(&from_str)
    };

    let to_path = if Path::new(&to_str).is_absolute() {
        PathBuf::from(&to_str)
    } else {
        cwd.join(&to_str)
    };

    // Normalize both paths
    let from_normalized = normalize_path(&from_path);
    let to_normalized = normalize_path(&to_path);

    let from_parts: Vec<&str> = from_normalized
        .split('/')
        .filter(|s| !s.is_empty())
        .collect();
    let to_parts: Vec<&str> = to_normalized.split('/').filter(|s| !s.is_empty()).collect();

    // Find common prefix
    let mut common_len = 0;
    for (a, b) in from_parts.iter().zip(to_parts.iter()) {
        if a == b {
            common_len += 1;
        } else {
            break;
        }
    }

    // Build relative path
    let mut result = Vec::new();

    // Add ".." for each remaining part in from_path
    for _ in common_len..from_parts.len() {
        result.push("..");
    }

    // Add remaining parts from to_path
    for part in &to_parts[common_len..] {
        result.push(*part);
    }

    let result_path = if result.is_empty() {
        ".".to_string()
    } else {
        result.join("/")
    };

    let result_str = v8::String::new(scope, &result_path).unwrap();
    rv.set(result_str.into());
}

// Velox.path.parse(path: string): ParsedPath
fn parse(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path_arg = args.get(0);
    let path_str = if path_arg.is_string() {
        path_arg.to_rust_string_lossy(scope)
    } else {
        String::new()
    };

    let path = Path::new(&path_str);

    // root: "/" for absolute paths, "" for relative
    let root = if path.is_absolute() {
        if cfg!(windows) {
            path.components()
                .next()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            "/".to_string()
        }
    } else {
        String::new()
    };

    // dir: directory portion
    let dir = path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    // base: filename with extension
    let base = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // ext: extension with dot
    let ext = path
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();

    // name: filename without extension
    let name = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    // Create result object
    let obj = v8::Object::new(scope);

    let root_key = v8::String::new(scope, "root").unwrap();
    let root_val = v8::String::new(scope, &root).unwrap();
    obj.set(scope, root_key.into(), root_val.into());

    let dir_key = v8::String::new(scope, "dir").unwrap();
    let dir_val = v8::String::new(scope, &dir).unwrap();
    obj.set(scope, dir_key.into(), dir_val.into());

    let base_key = v8::String::new(scope, "base").unwrap();
    let base_val = v8::String::new(scope, &base).unwrap();
    obj.set(scope, base_key.into(), base_val.into());

    let ext_key = v8::String::new(scope, "ext").unwrap();
    let ext_val = v8::String::new(scope, &ext).unwrap();
    obj.set(scope, ext_key.into(), ext_val.into());

    let name_key = v8::String::new(scope, "name").unwrap();
    let name_val = v8::String::new(scope, &name).unwrap();
    obj.set(scope, name_key.into(), name_val.into());

    rv.set(obj.into());
}

// Velox.path.format(obj: ParsedPath): string
fn format(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let obj_arg = args.get(0);
    if !obj_arg.is_object() {
        let result = v8::String::new(scope, "").unwrap();
        rv.set(result.into());
        return;
    }

    let obj = v8::Local::<v8::Object>::try_from(obj_arg).unwrap();

    // Get properties
    let get_str = |scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, key: &str| -> String {
        let key_v8 = v8::String::new(scope, key).unwrap();
        match obj.get(scope, key_v8.into()) {
            Some(v) if v.is_string() => v.to_rust_string_lossy(scope),
            _ => String::new(),
        }
    };

    let dir = get_str(scope, obj, "dir");
    let root = get_str(scope, obj, "root");
    let base = get_str(scope, obj, "base");
    let name = get_str(scope, obj, "name");
    let ext = get_str(scope, obj, "ext");

    // Build path: if dir is provided, use dir + base (or name + ext)
    // If no dir, use root + base (or name + ext)
    let result = if !dir.is_empty() {
        if !base.is_empty() {
            format!("{}/{}", dir, base)
        } else {
            format!("{}/{}{}", dir, name, ext)
        }
    } else if !root.is_empty() {
        if !base.is_empty() {
            format!("{}{}", root, base)
        } else {
            format!("{}{}{}", root, name, ext)
        }
    } else if !base.is_empty() {
        base
    } else {
        format!("{}{}", name, ext)
    };

    let result_str = v8::String::new(scope, &result).unwrap();
    rv.set(result_str.into());
}

// Helper: normalize a path by resolving . and ..
fn normalize_path(path: &Path) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let is_absolute = path.is_absolute();

    for component in path.components() {
        match component {
            std::path::Component::RootDir => {}
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if parts.is_empty() && !is_absolute {
                    parts.push("..");
                } else if !parts.is_empty() && parts.last() != Some(&"..") {
                    parts.pop();
                }
            }
            std::path::Component::Normal(s) => {
                parts.push(s.to_str().unwrap_or(""));
            }
            std::path::Component::Prefix(p) => {
                parts.push(p.as_os_str().to_str().unwrap_or(""));
            }
        }
    }

    if is_absolute {
        format!("/{}", parts.join("/"))
    } else if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

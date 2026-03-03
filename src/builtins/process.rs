use crate::permissions;
use rusty_v8 as v8;
use std::cell::RefCell;
use std::env;

thread_local! {
    static SCRIPT_ARGS: RefCell<Vec<String>> = RefCell::new(Vec::new());
    static EXEC_PATH: RefCell<String> = RefCell::new(String::new());
}

/// Set the script arguments (called from main before script execution)
pub fn set_args(exec_path: String, args: Vec<String>) {
    EXEC_PATH.with(|ep| {
        *ep.borrow_mut() = exec_path;
    });
    SCRIPT_ARGS.with(|sa| {
        *sa.borrow_mut() = args;
    });
}

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

    // Velox.args - script arguments (after script path)
    let args_array = SCRIPT_ARGS.with(|sa| {
        let args = sa.borrow();
        let arr = v8::Array::new(scope, args.len() as i32);
        for (i, arg) in args.iter().enumerate() {
            let val = v8::String::new(scope, arg).unwrap();
            arr.set_index(scope, i as u32, val.into());
        }
        arr
    });
    let args_key = v8::String::new(scope, "args").unwrap();
    velox.set(scope, args_key.into(), args_array.into());

    // Velox.execPath - path to velox binary
    let exec_path = EXEC_PATH.with(|ep| ep.borrow().clone());
    let exec_path_key = v8::String::new(scope, "execPath").unwrap();
    let exec_path_val = v8::String::new(scope, &exec_path).unwrap();
    velox.set(scope, exec_path_key.into(), exec_path_val.into());

    // Velox.pid - process ID
    let pid_key = v8::String::new(scope, "pid").unwrap();
    let pid_val = v8::Integer::new(scope, std::process::id() as i32);
    velox.set(scope, pid_key.into(), pid_val.into());

    // Velox.platform - "darwin", "linux", or "windows"
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "unknown"
    };
    let platform_key = v8::String::new(scope, "platform").unwrap();
    let platform_val = v8::String::new(scope, platform).unwrap();
    velox.set(scope, platform_key.into(), platform_val.into());

    // Velox.arch - "x64" or "arm64"
    let arch = if cfg!(target_arch = "x86_64") {
        "x64"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "unknown"
    };
    let arch_key = v8::String::new(scope, "arch").unwrap();
    let arch_val = v8::String::new(scope, arch).unwrap();
    velox.set(scope, arch_key.into(), arch_val.into());

    // Velox.version
    let version_key = v8::String::new(scope, "version").unwrap();
    let version_val = v8::String::new(scope, env!("CARGO_PKG_VERSION")).unwrap();
    velox.set(scope, version_key.into(), version_val.into());

    // Velox.cwd() - get current working directory
    set_function(scope, velox, "cwd", cwd);

    // Velox.chdir(path) - change current working directory
    set_function(scope, velox, "chdir", chdir);

    // Velox.exit(code) - exit the process
    set_function(scope, velox, "exit", exit);

    // Velox.env - environment variables object
    let env_obj = create_env_object(scope);
    let env_key = v8::String::new(scope, "env").unwrap();
    velox.set(scope, env_key.into(), env_obj.into());
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

// Velox.cwd(): string
fn cwd(scope: &mut v8::HandleScope, _args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let cwd = env::current_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| String::from("/"));

    let result = v8::String::new(scope, &cwd).unwrap();
    rv.set(result.into());
}

// Velox.chdir(path: string): void
fn chdir(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let path_arg = args.get(0);
    if !path_arg.is_string() {
        let err = v8::String::new(scope, "chdir requires a string path").unwrap();
        scope.throw_exception(err.into());
        return;
    }

    let path = path_arg.to_rust_string_lossy(scope);
    if let Err(e) = env::set_current_dir(&path) {
        let err = v8::String::new(scope, &format!("chdir failed: {}", e)).unwrap();
        scope.throw_exception(err.into());
    }
}

// Velox.exit(code?: number): never
fn exit(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let code = if args.length() > 0 {
        let code_arg = args.get(0);
        if code_arg.is_number() {
            code_arg.int32_value(scope).unwrap_or(0)
        } else {
            0
        }
    } else {
        0
    };

    std::process::exit(code);
}

// Create Velox.env object with get/set/delete/toObject methods
fn create_env_object<'s>(
    scope: &mut v8::ContextScope<'s, v8::HandleScope>,
) -> v8::Local<'s, v8::Object> {
    let env_obj = v8::Object::new(scope);

    // env.get(key: string): string | undefined
    set_function(scope, env_obj, "get", env_get);

    // env.set(key: string, value: string): void
    set_function(scope, env_obj, "set", env_set);

    // env.delete(key: string): void
    set_function(scope, env_obj, "delete", env_delete);

    // env.toObject(): Record<string, string>
    set_function(scope, env_obj, "toObject", env_to_object);

    // Also set all current env vars as properties for proxy-like access
    for (key, value) in env::vars() {
        let key_v8 = v8::String::new(scope, &key).unwrap();
        let val_v8 = v8::String::new(scope, &value).unwrap();
        env_obj.set(scope, key_v8.into(), val_v8.into());
    }

    env_obj
}

// Velox.env.get(key: string): string | undefined
fn env_get(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let key_arg = args.get(0);
    if !key_arg.is_string() {
        rv.set(v8::undefined(scope).into());
        return;
    }

    let key = key_arg.to_rust_string_lossy(scope);

    // Check env permission
    if let Err(e) = permissions::check_env(&key) {
        let err = v8::String::new(scope, &e).unwrap();
        scope.throw_exception(err.into());
        return;
    }

    match env::var(&key) {
        Ok(value) => {
            let result = v8::String::new(scope, &value).unwrap();
            rv.set(result.into());
        }
        Err(_) => {
            rv.set(v8::undefined(scope).into());
        }
    }
}

// Velox.env.set(key: string, value: string): void
fn env_set(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    if args.length() < 2 {
        return;
    }

    let key_arg = args.get(0);
    let val_arg = args.get(1);

    if !key_arg.is_string() || !val_arg.is_string() {
        return;
    }

    let key = key_arg.to_rust_string_lossy(scope);
    let value = val_arg.to_rust_string_lossy(scope);

    // Check env permission
    if let Err(e) = permissions::check_env(&key) {
        let err = v8::String::new(scope, &e).unwrap();
        scope.throw_exception(err.into());
        return;
    }

    // SAFETY: We're in a single-threaded JS runtime
    unsafe { env::set_var(&key, &value) };
}

// Velox.env.delete(key: string): void
fn env_delete(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let key_arg = args.get(0);
    if !key_arg.is_string() {
        return;
    }

    let key = key_arg.to_rust_string_lossy(scope);

    // Check env permission
    if let Err(e) = permissions::check_env(&key) {
        let err = v8::String::new(scope, &e).unwrap();
        scope.throw_exception(err.into());
        return;
    }

    // SAFETY: We're in a single-threaded JS runtime
    unsafe { env::remove_var(&key) };
}

// Velox.env.toObject(): Record<string, string>
fn env_to_object(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    // Check for full env permission
    if let Err(e) = permissions::check(permissions::PermissionKind::Env, None) {
        // If no full permission, return empty object
        let err = v8::String::new(scope, &e).unwrap();
        scope.throw_exception(err.into());
        return;
    }

    let obj = v8::Object::new(scope);

    for (key, value) in env::vars() {
        let key_v8 = v8::String::new(scope, &key).unwrap();
        let val_v8 = v8::String::new(scope, &value).unwrap();
        obj.set(scope, key_v8.into(), val_v8.into());
    }

    rv.set(obj.into());
}

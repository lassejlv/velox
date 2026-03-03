use crate::event_loop::EventLoopHandle;
use crate::permissions;
use rusty_v8 as v8;
use std::cell::RefCell;
use std::collections::HashMap;
use std::process::{Command, Stdio};

thread_local! {
    static EVENT_LOOP: RefCell<Option<EventLoopHandle>> = RefCell::new(None);
    static CHILD_PROCESSES: RefCell<HashMap<u32, std::process::Child>> = RefCell::new(HashMap::new());
    static NEXT_CHILD_ID: RefCell<u32> = RefCell::new(0);
}

pub fn set_event_loop(handle: EventLoopHandle) {
    EVENT_LOOP.with(|el| {
        *el.borrow_mut() = Some(handle);
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

    // Velox.exec(command): Promise<ExecResult>
    set_function(scope, velox, "exec", exec);

    // Velox.execSync(command): ExecResult
    set_function(scope, velox, "execSync", exec_sync);

    // Velox.spawn(command, options?): ChildProcess
    set_function(scope, velox, "spawn", spawn);
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

fn set_method(
    scope: &mut v8::HandleScope,
    obj: v8::Local<v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let func = v8::Function::new(scope, callback).unwrap();
    let key = v8::String::new(scope, name).unwrap();
    obj.set(scope, key.into(), func.into());
}

// Velox.execSync(command: string): ExecResult
fn exec_sync(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let cmd_arg = args.get(0);
    if !cmd_arg.is_string() {
        let err = v8::String::new(scope, "exec requires a command string").unwrap();
        scope.throw_exception(err.into());
        return;
    }

    let command = cmd_arg.to_rust_string_lossy(scope);

    // Check run permission - extract the program name from the command
    let program = extract_program(&command);
    if let Err(e) = permissions::check_run(&program) {
        let err = v8::String::new(scope, &e).unwrap();
        scope.throw_exception(err.into());
        return;
    }

    let result = run_command(&command);

    let obj = create_exec_result(scope, &result);
    rv.set(obj.into());
}

// Velox.exec(command: string): Promise<ExecResult>
fn exec(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let cmd_arg = args.get(0);
    if !cmd_arg.is_string() {
        let err = v8::String::new(scope, "exec requires a command string").unwrap();
        scope.throw_exception(err.into());
        return;
    }

    let command = cmd_arg.to_rust_string_lossy(scope);

    // Check run permission - extract the program name from the command
    let program = extract_program(&command);
    if let Err(e) = permissions::check_run(&program) {
        let err = v8::String::new(scope, &e).unwrap();
        scope.throw_exception(err.into());
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);

    let handle = EVENT_LOOP.with(|el| el.borrow().clone());
    if let Some(handle) = handle {
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || {
            let result = run_command(&command);

            Box::new(
                move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    let obj = create_exec_result(scope, &result);
                    resolver.resolve(scope, obj.into());
                },
            )
        });

        rv.set(promise.into());
    } else {
        let err = v8::String::new(scope, "Event loop not initialized").unwrap();
        scope.throw_exception(err.into());
    }
}

struct ExecResultData {
    code: i32,
    stdout: String,
    stderr: String,
    success: bool,
}

fn run_command(command: &str) -> ExecResultData {
    let shell = if cfg!(target_os = "windows") {
        ("cmd", "/C")
    } else {
        ("sh", "-c")
    };

    match Command::new(shell.0).arg(shell.1).arg(command).output() {
        Ok(output) => ExecResultData {
            code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            success: output.status.success(),
        },
        Err(e) => ExecResultData {
            code: -1,
            stdout: String::new(),
            stderr: e.to_string(),
            success: false,
        },
    }
}

fn create_exec_result<'s>(
    scope: &mut v8::HandleScope<'s>,
    result: &ExecResultData,
) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);

    let code_key = v8::String::new(scope, "code").unwrap();
    let code_val = v8::Integer::new(scope, result.code);
    obj.set(scope, code_key.into(), code_val.into());

    let stdout_key = v8::String::new(scope, "stdout").unwrap();
    let stdout_val = v8::String::new(scope, &result.stdout).unwrap();
    obj.set(scope, stdout_key.into(), stdout_val.into());

    let stderr_key = v8::String::new(scope, "stderr").unwrap();
    let stderr_val = v8::String::new(scope, &result.stderr).unwrap();
    obj.set(scope, stderr_key.into(), stderr_val.into());

    let success_key = v8::String::new(scope, "success").unwrap();
    let success_val = v8::Boolean::new(scope, result.success);
    obj.set(scope, success_key.into(), success_val.into());

    obj
}

// Velox.spawn(command: string, options?: SpawnOptions): ChildProcess
fn spawn(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let cmd_arg = args.get(0);
    if !cmd_arg.is_string() {
        let err = v8::String::new(scope, "spawn requires a command string").unwrap();
        scope.throw_exception(err.into());
        return;
    }

    let command = cmd_arg.to_rust_string_lossy(scope);

    // Check run permission - extract the program name from the command
    let program = extract_program(&command);
    if let Err(e) = permissions::check_run(&program) {
        let err = v8::String::new(scope, &e).unwrap();
        scope.throw_exception(err.into());
        return;
    }

    // Parse options
    let mut cwd: Option<String> = None;
    let mut env_vars: Option<HashMap<String, String>> = None;
    let mut stdin_mode = "piped";
    let mut stdout_mode = "piped";
    let mut stderr_mode = "piped";

    if args.length() > 1 {
        let opts_arg = args.get(1);
        if opts_arg.is_object() {
            let opts = v8::Local::<v8::Object>::try_from(opts_arg).unwrap();

            // cwd
            let cwd_key = v8::String::new(scope, "cwd").unwrap();
            if let Some(v) = opts.get(scope, cwd_key.into()) {
                if v.is_string() {
                    cwd = Some(v.to_rust_string_lossy(scope));
                }
            }

            // env
            let env_key = v8::String::new(scope, "env").unwrap();
            if let Some(v) = opts.get(scope, env_key.into()) {
                if v.is_object() {
                    let env_obj = v8::Local::<v8::Object>::try_from(v).unwrap();
                    let mut map = HashMap::new();
                    if let Some(names) = env_obj.get_own_property_names(scope) {
                        for i in 0..names.length() {
                            if let Some(key) = names.get_index(scope, i) {
                                if let Some(val) = env_obj.get(scope, key) {
                                    let k = key.to_rust_string_lossy(scope);
                                    let v = val.to_rust_string_lossy(scope);
                                    map.insert(k, v);
                                }
                            }
                        }
                    }
                    env_vars = Some(map);
                }
            }

            // stdin/stdout/stderr modes
            let stdin_key = v8::String::new(scope, "stdin").unwrap();
            if let Some(v) = opts.get(scope, stdin_key.into()) {
                if v.is_string() {
                    stdin_mode = match v.to_rust_string_lossy(scope).as_str() {
                        "inherit" => "inherit",
                        "null" => "null",
                        _ => "piped",
                    };
                }
            }

            let stdout_key = v8::String::new(scope, "stdout").unwrap();
            if let Some(v) = opts.get(scope, stdout_key.into()) {
                if v.is_string() {
                    stdout_mode = match v.to_rust_string_lossy(scope).as_str() {
                        "inherit" => "inherit",
                        "null" => "null",
                        _ => "piped",
                    };
                }
            }

            let stderr_key = v8::String::new(scope, "stderr").unwrap();
            if let Some(v) = opts.get(scope, stderr_key.into()) {
                if v.is_string() {
                    stderr_mode = match v.to_rust_string_lossy(scope).as_str() {
                        "inherit" => "inherit",
                        "null" => "null",
                        _ => "piped",
                    };
                }
            }
        }
    }

    // Build command
    let shell = if cfg!(target_os = "windows") {
        ("cmd", "/C")
    } else {
        ("sh", "-c")
    };

    let mut cmd = Command::new(shell.0);
    cmd.arg(shell.1).arg(&command);

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    if let Some(env) = env_vars {
        cmd.envs(env);
    }

    // Set stdio
    cmd.stdin(match stdin_mode {
        "inherit" => Stdio::inherit(),
        "null" => Stdio::null(),
        _ => Stdio::piped(),
    });
    cmd.stdout(match stdout_mode {
        "inherit" => Stdio::inherit(),
        "null" => Stdio::null(),
        _ => Stdio::piped(),
    });
    cmd.stderr(match stderr_mode {
        "inherit" => Stdio::inherit(),
        "null" => Stdio::null(),
        _ => Stdio::piped(),
    });

    match cmd.spawn() {
        Ok(child) => {
            let pid = child.id();

            // Store child process
            let child_id = NEXT_CHILD_ID.with(|id| {
                let mut id = id.borrow_mut();
                let current = *id;
                *id += 1;
                current
            });

            CHILD_PROCESSES.with(|cp| {
                cp.borrow_mut().insert(child_id, child);
            });

            // Create ChildProcess object
            let obj = v8::Object::new(scope);

            // pid
            let pid_key = v8::String::new(scope, "pid").unwrap();
            let pid_val = v8::Integer::new_from_unsigned(scope, pid);
            obj.set(scope, pid_key.into(), pid_val.into());

            // Store child_id in internal field for kill/status
            let id_key = v8::String::new(scope, "_childId").unwrap();
            let id_val = v8::Integer::new_from_unsigned(scope, child_id);
            obj.set(scope, id_key.into(), id_val.into());

            // kill method
            set_method(scope, obj, "kill", child_kill);

            // wait method (returns Promise<{code, success}>)
            set_method(scope, obj, "wait", child_wait);

            // output method (waits and returns stdout as string)
            set_method(scope, obj, "output", child_output);

            rv.set(obj.into());
        }
        Err(e) => {
            let err = v8::String::new(scope, &format!("spawn failed: {}", e)).unwrap();
            scope.throw_exception(err.into());
        }
    }
}

// ChildProcess.kill(signal?: string): void
fn child_kill(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let this = args.this();
    let id_key = v8::String::new(scope, "_childId").unwrap();

    if let Some(id_val) = this.get(scope, id_key.into()) {
        if let Some(child_id) = id_val.uint32_value(scope) {
            CHILD_PROCESSES.with(|cp| {
                if let Some(child) = cp.borrow_mut().get_mut(&child_id) {
                    let _ = child.kill();
                }
            });
        }
    }
}

// ChildProcess.wait(): Promise<{code, success}>
fn child_wait(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let id_key = v8::String::new(scope, "_childId").unwrap();

    let child_id = if let Some(id_val) = this.get(scope, id_key.into()) {
        id_val.uint32_value(scope).unwrap_or(0)
    } else {
        0
    };

    // Extract child from map on main thread before spawning
    let child_opt = CHILD_PROCESSES.with(|cp| cp.borrow_mut().remove(&child_id));

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);

    let handle = EVENT_LOOP.with(|el| el.borrow().clone());
    if let Some(handle) = handle {
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || {
            let result = if let Some(mut child) = child_opt {
                match child.wait() {
                    Ok(status) => Some((status.code().unwrap_or(-1), status.success())),
                    Err(_) => Some((-1, false)),
                }
            } else {
                None
            };

            Box::new(
                move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    if let Some((code, success)) = result {
                        let obj = v8::Object::new(scope);

                        let code_key = v8::String::new(scope, "code").unwrap();
                        let code_val = v8::Integer::new(scope, code);
                        obj.set(scope, code_key.into(), code_val.into());

                        let success_key = v8::String::new(scope, "success").unwrap();
                        let success_val = v8::Boolean::new(scope, success);
                        obj.set(scope, success_key.into(), success_val.into());

                        resolver.resolve(scope, obj.into());
                    } else {
                        let err = v8::String::new(scope, "Child process not found").unwrap();
                        resolver.reject(scope, err.into());
                    }
                },
            )
        });

        rv.set(promise.into());
    }
}

// ChildProcess.output(): Promise<string> - waits and returns stdout
fn child_output(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let id_key = v8::String::new(scope, "_childId").unwrap();

    let child_id = if let Some(id_val) = this.get(scope, id_key.into()) {
        id_val.uint32_value(scope).unwrap_or(0)
    } else {
        0
    };

    // Extract child from map on main thread before spawning
    let child_opt = CHILD_PROCESSES.with(|cp| cp.borrow_mut().remove(&child_id));

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);

    let handle = EVENT_LOOP.with(|el| el.borrow().clone());
    if let Some(handle) = handle {
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || {
            let result = if let Some(child) = child_opt {
                match child.wait_with_output() {
                    Ok(output) => Some(String::from_utf8_lossy(&output.stdout).to_string()),
                    Err(e) => Some(format!("Error: {}", e)),
                }
            } else {
                None
            };

            Box::new(
                move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    if let Some(stdout) = result {
                        let val = v8::String::new(scope, &stdout).unwrap();
                        resolver.resolve(scope, val.into());
                    } else {
                        let err = v8::String::new(scope, "Child process not found").unwrap();
                        resolver.reject(scope, err.into());
                    }
                },
            )
        });

        rv.set(promise.into());
    }
}

/// Extract the program name from a shell command for permission checking
fn extract_program(command: &str) -> String {
    // Split on whitespace and get the first part
    let trimmed = command.trim();

    // Handle commands that start with environment variables (VAR=val cmd)
    let parts: Vec<&str> = trimmed.split_whitespace().collect();
    for part in parts {
        // Skip environment variable assignments
        if !part.contains('=') {
            // Extract just the program name (remove path)
            return part.rsplit('/').next().unwrap_or(part).to_string();
        }
    }

    // Fallback to the whole command if we can't parse it
    trimmed.to_string()
}

use crate::event_loop::EventLoopHandle;
use crate::permissions;
use rusty_v8 as v8;
use std::cell::RefCell;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::SystemTime;

thread_local! {
    static EVENT_LOOP: RefCell<Option<EventLoopHandle>> = RefCell::new(None);
}

pub fn set_event_loop(handle: EventLoopHandle) {
    EVENT_LOOP.with(|el| {
        *el.borrow_mut() = Some(handle);
    });
}

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    // Create Velox object if it doesn't exist
    let velox_key = v8::String::new(scope, "Velox").unwrap();
    let velox = match global.get(scope, velox_key.into()) {
        Some(v) if v.is_object() => v8::Local::<v8::Object>::try_from(v).unwrap(),
        _ => {
            let obj = v8::Object::new(scope);
            global.set(scope, velox_key.into(), obj.into());
            obj
        }
    };

    // Create fs namespace
    let fs_obj = v8::Object::new(scope);

    // Reading functions
    set_function(scope, fs_obj, "readFileSync", read_file_sync);
    set_function(scope, fs_obj, "readFile", read_file);
    set_function(scope, fs_obj, "readTextFileSync", read_text_file_sync);
    set_function(scope, fs_obj, "readTextFile", read_text_file);

    // Writing functions
    set_function(scope, fs_obj, "writeFileSync", write_file_sync);
    set_function(scope, fs_obj, "writeFile", write_file);
    set_function(scope, fs_obj, "writeTextFileSync", write_text_file_sync);
    set_function(scope, fs_obj, "writeTextFile", write_text_file);
    set_function(scope, fs_obj, "appendFile", append_file);

    // Directory functions
    set_function(scope, fs_obj, "readDirSync", read_dir_sync);
    set_function(scope, fs_obj, "readDir", read_dir);
    set_function(scope, fs_obj, "mkdirSync", mkdir_sync);
    set_function(scope, fs_obj, "mkdir", mkdir);

    // File operations
    set_function(scope, fs_obj, "removeSync", remove_sync);
    set_function(scope, fs_obj, "remove", remove);
    set_function(scope, fs_obj, "rename", rename_file);
    set_function(scope, fs_obj, "copy", copy_file);

    // Info functions
    set_function(scope, fs_obj, "statSync", stat_sync);
    set_function(scope, fs_obj, "stat", stat);
    set_function(scope, fs_obj, "existsSync", exists_sync);
    set_function(scope, fs_obj, "exists", exists);

    // Link functions
    set_function(scope, fs_obj, "symlink", symlink);
    set_function(scope, fs_obj, "readLink", read_link);

    let fs_key = v8::String::new(scope, "fs").unwrap();
    velox.set(scope, fs_key.into(), fs_obj.into());
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

fn throw_error(scope: &mut v8::HandleScope, msg: &str) {
    let err = v8::String::new(scope, msg).unwrap();
    scope.throw_exception(err.into());
}

fn create_uint8_array<'s>(
    scope: &mut v8::HandleScope<'s>,
    bytes: &[u8],
) -> v8::Local<'s, v8::Uint8Array> {
    let len = bytes.len();
    let array_buffer = v8::ArrayBuffer::new(scope, len);

    if len > 0 {
        let backing_store = array_buffer.get_backing_store();
        let data_ptr = backing_store.data();
        if !data_ptr.is_null() {
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), data_ptr as *mut u8, len);
            }
        }
    }

    v8::Uint8Array::new(scope, array_buffer, 0, len).unwrap()
}

// ============ SYNC READING ============

fn read_file_sync(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    match fs::read(&path) {
        Ok(bytes) => {
            let uint8_array = create_uint8_array(scope, &bytes);
            rv.set(uint8_array.into());
        }
        Err(e) => throw_error(scope, &format!("Failed to read file '{}': {}", path, e)),
    }
}

fn read_text_file_sync(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    match fs::read_to_string(&path) {
        Ok(content) => {
            let result = v8::String::new(scope, &content).unwrap();
            rv.set(result.into());
        }
        Err(e) => throw_error(scope, &format!("Failed to read file '{}': {}", path, e)),
    }
}

// ============ ASYNC READING ============

fn read_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || match fs::read(&path) {
            Ok(bytes) => Box::new(
                move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    let uint8_array = create_uint8_array(scope, &bytes);
                    resolver.resolve(scope, uint8_array.into());
                },
            ),
            Err(e) => {
                let msg = format!("Failed to read file '{}': {}", path, e);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let err = v8::String::new(scope, &msg).unwrap();
                        resolver.reject(scope, err.into());
                    },
                )
            }
        });
    });
}

fn read_text_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || match fs::read_to_string(&path) {
            Ok(content) => Box::new(
                move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    let result = v8::String::new(scope, &content).unwrap();
                    resolver.resolve(scope, result.into());
                },
            ),
            Err(e) => {
                let msg = format!("Failed to read file '{}': {}", path, e);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let err = v8::String::new(scope, &msg).unwrap();
                        resolver.reject(scope, err.into());
                    },
                )
            }
        });
    });
}

// ============ SYNC WRITING ============

fn write_file_sync(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    let data = args.get(1);

    // Check write permission
    if let Err(e) = permissions::check_write(&path) {
        throw_error(scope, &e);
        return;
    }

    if !data.is_typed_array() {
        throw_error(scope, "writeFileSync: data must be a Uint8Array");
        return;
    }

    let typed_array = v8::Local::<v8::TypedArray>::try_from(data).unwrap();
    let len = typed_array.byte_length();
    let mut bytes = vec![0u8; len];
    if len > 0 {
        typed_array.copy_contents(&mut bytes);
    }

    if let Err(e) = fs::write(&path, &bytes) {
        throw_error(scope, &format!("Failed to write file '{}': {}", path, e));
    }
}

fn write_text_file_sync(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    let data = args.get(1).to_rust_string_lossy(scope);

    // Check write permission
    if let Err(e) = permissions::check_write(&path) {
        throw_error(scope, &e);
        return;
    }

    if let Err(e) = fs::write(&path, data.as_bytes()) {
        throw_error(scope, &format!("Failed to write file '{}': {}", path, e));
    }
}

// ============ ASYNC WRITING ============

fn write_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    let data = args.get(1);

    // Check write permission
    if let Err(e) = permissions::check_write(&path) {
        throw_error(scope, &e);
        return;
    }

    if !data.is_typed_array() {
        let resolver = v8::PromiseResolver::new(scope).unwrap();
        let promise = resolver.get_promise(scope);
        let err = v8::String::new(scope, "writeFile: data must be a Uint8Array").unwrap();
        resolver.reject(scope, err.into());
        rv.set(promise.into());
        return;
    }

    let typed_array = v8::Local::<v8::TypedArray>::try_from(data).unwrap();
    let len = typed_array.byte_length();
    let mut bytes = vec![0u8; len];
    if len > 0 {
        typed_array.copy_contents(&mut bytes);
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || match fs::write(&path, &bytes) {
            Ok(()) => Box::new(
                |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    let undefined = v8::undefined(scope);
                    resolver.resolve(scope, undefined.into());
                },
            ),
            Err(e) => {
                let msg = format!("Failed to write file '{}': {}", path, e);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let err = v8::String::new(scope, &msg).unwrap();
                        resolver.reject(scope, err.into());
                    },
                )
            }
        });
    });
}

fn write_text_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    let data = args.get(1).to_rust_string_lossy(scope);

    // Check write permission
    if let Err(e) = permissions::check_write(&path) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || match fs::write(&path, data.as_bytes()) {
            Ok(()) => Box::new(
                |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    let undefined = v8::undefined(scope);
                    resolver.resolve(scope, undefined.into());
                },
            ),
            Err(e) => {
                let msg = format!("Failed to write file '{}': {}", path, e);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let err = v8::String::new(scope, &msg).unwrap();
                        resolver.reject(scope, err.into());
                    },
                )
            }
        });
    });
}

fn append_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    let data = args.get(1);

    // Check write permission
    if let Err(e) = permissions::check_write(&path) {
        throw_error(scope, &e);
        return;
    }

    // Handle both string and Uint8Array
    let bytes: Vec<u8> = if data.is_string() {
        data.to_rust_string_lossy(scope).into_bytes()
    } else if data.is_typed_array() {
        let typed_array = v8::Local::<v8::TypedArray>::try_from(data).unwrap();
        let len = typed_array.byte_length();
        let mut bytes = vec![0u8; len];
        if len > 0 {
            typed_array.copy_contents(&mut bytes);
        }
        bytes
    } else {
        let resolver = v8::PromiseResolver::new(scope).unwrap();
        let promise = resolver.get_promise(scope);
        let err =
            v8::String::new(scope, "appendFile: data must be a string or Uint8Array").unwrap();
        resolver.reject(scope, err.into());
        rv.set(promise.into());
        return;
    };

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || {
            let result = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut file| file.write_all(&bytes));

            match result {
                Ok(()) => Box::new(
                    |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let undefined = v8::undefined(scope);
                        resolver.resolve(scope, undefined.into());
                    },
                ),
                Err(e) => {
                    let msg = format!("Failed to append to file '{}': {}", path, e);
                    Box::new(
                        move |scope: &mut v8::HandleScope,
                              resolver: v8::Local<v8::PromiseResolver>| {
                            let err = v8::String::new(scope, &msg).unwrap();
                            resolver.reject(scope, err.into());
                        },
                    )
                }
            }
        });
    });
}

// ============ DIRECTORY OPERATIONS ============

fn read_dir_sync(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    match fs::read_dir(&path) {
        Ok(entries) => {
            let array = v8::Array::new(scope, 0);
            let mut index = 0;

            for entry in entries.flatten() {
                let obj = v8::Object::new(scope);

                if let Ok(file_type) = entry.file_type() {
                    let name_key = v8::String::new(scope, "name").unwrap();
                    let name_val =
                        v8::String::new(scope, &entry.file_name().to_string_lossy()).unwrap();
                    obj.set(scope, name_key.into(), name_val.into());

                    let is_file_key = v8::String::new(scope, "isFile").unwrap();
                    let is_file_val = v8::Boolean::new(scope, file_type.is_file());
                    obj.set(scope, is_file_key.into(), is_file_val.into());

                    let is_dir_key = v8::String::new(scope, "isDirectory").unwrap();
                    let is_dir_val = v8::Boolean::new(scope, file_type.is_dir());
                    obj.set(scope, is_dir_key.into(), is_dir_val.into());

                    let is_symlink_key = v8::String::new(scope, "isSymlink").unwrap();
                    let is_symlink_val = v8::Boolean::new(scope, file_type.is_symlink());
                    obj.set(scope, is_symlink_key.into(), is_symlink_val.into());

                    array.set_index(scope, index, obj.into());
                    index += 1;
                }
            }
            rv.set(array.into());
        }
        Err(e) => throw_error(
            scope,
            &format!("Failed to read directory '{}': {}", path, e),
        ),
    }
}

#[derive(Clone)]
struct DirEntryData {
    name: String,
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
}

fn read_dir(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || match fs::read_dir(&path) {
            Ok(entries) => {
                let entries: Vec<DirEntryData> = entries
                    .flatten()
                    .filter_map(|e| {
                        let file_type = e.file_type().ok()?;
                        Some(DirEntryData {
                            name: e.file_name().to_string_lossy().to_string(),
                            is_file: file_type.is_file(),
                            is_directory: file_type.is_dir(),
                            is_symlink: file_type.is_symlink(),
                        })
                    })
                    .collect();

                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let array = v8::Array::new(scope, entries.len() as i32);
                        for (i, entry) in entries.iter().enumerate() {
                            let obj = v8::Object::new(scope);

                            let name_key = v8::String::new(scope, "name").unwrap();
                            let name_val = v8::String::new(scope, &entry.name).unwrap();
                            obj.set(scope, name_key.into(), name_val.into());

                            let is_file_key = v8::String::new(scope, "isFile").unwrap();
                            let is_file_val = v8::Boolean::new(scope, entry.is_file);
                            obj.set(scope, is_file_key.into(), is_file_val.into());

                            let is_dir_key = v8::String::new(scope, "isDirectory").unwrap();
                            let is_dir_val = v8::Boolean::new(scope, entry.is_directory);
                            obj.set(scope, is_dir_key.into(), is_dir_val.into());

                            let is_symlink_key = v8::String::new(scope, "isSymlink").unwrap();
                            let is_symlink_val = v8::Boolean::new(scope, entry.is_symlink);
                            obj.set(scope, is_symlink_key.into(), is_symlink_val.into());

                            array.set_index(scope, i as u32, obj.into());
                        }
                        resolver.resolve(scope, array.into());
                    },
                )
            }
            Err(e) => {
                let msg = format!("Failed to read directory '{}': {}", path, e);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let err = v8::String::new(scope, &msg).unwrap();
                        resolver.reject(scope, err.into());
                    },
                )
            }
        });
    });
}

fn get_recursive_option(scope: &mut v8::HandleScope, options: v8::Local<v8::Value>) -> bool {
    if options.is_object() {
        if let Ok(obj) = v8::Local::<v8::Object>::try_from(options) {
            let key = v8::String::new(scope, "recursive").unwrap();
            if let Some(val) = obj.get(scope, key.into()) {
                return val.boolean_value(scope);
            }
        }
    }
    false
}

fn mkdir_sync(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    let recursive = get_recursive_option(scope, args.get(1));

    // Check write permission
    if let Err(e) = permissions::check_write(&path) {
        throw_error(scope, &e);
        return;
    }

    let result = if recursive {
        fs::create_dir_all(&path)
    } else {
        fs::create_dir(&path)
    };

    if let Err(e) = result {
        throw_error(
            scope,
            &format!("Failed to create directory '{}': {}", path, e),
        );
    }
}

fn mkdir(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    let recursive = get_recursive_option(scope, args.get(1));

    // Check write permission
    if let Err(e) = permissions::check_write(&path) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || {
            let result = if recursive {
                fs::create_dir_all(&path)
            } else {
                fs::create_dir(&path)
            };

            match result {
                Ok(()) => Box::new(
                    |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let undefined = v8::undefined(scope);
                        resolver.resolve(scope, undefined.into());
                    },
                ),
                Err(e) => {
                    let msg = format!("Failed to create directory '{}': {}", path, e);
                    Box::new(
                        move |scope: &mut v8::HandleScope,
                              resolver: v8::Local<v8::PromiseResolver>| {
                            let err = v8::String::new(scope, &msg).unwrap();
                            resolver.reject(scope, err.into());
                        },
                    )
                }
            }
        });
    });
}

// ============ FILE OPERATIONS ============

fn remove_sync(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    let recursive = get_recursive_option(scope, args.get(1));

    // Check write permission
    if let Err(e) = permissions::check_write(&path) {
        throw_error(scope, &e);
        return;
    }

    let p = Path::new(&path);
    let result = if p.is_dir() {
        if recursive {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_dir(&path)
        }
    } else {
        fs::remove_file(&path)
    };

    if let Err(e) = result {
        throw_error(scope, &format!("Failed to remove '{}': {}", path, e));
    }
}

fn remove(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);
    let recursive = get_recursive_option(scope, args.get(1));

    // Check write permission
    if let Err(e) = permissions::check_write(&path) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || {
            let p = Path::new(&path);
            let result = if p.is_dir() {
                if recursive {
                    fs::remove_dir_all(&path)
                } else {
                    fs::remove_dir(&path)
                }
            } else {
                fs::remove_file(&path)
            };

            match result {
                Ok(()) => Box::new(
                    |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let undefined = v8::undefined(scope);
                        resolver.resolve(scope, undefined.into());
                    },
                ),
                Err(e) => {
                    let msg = format!("Failed to remove '{}': {}", path, e);
                    Box::new(
                        move |scope: &mut v8::HandleScope,
                              resolver: v8::Local<v8::PromiseResolver>| {
                            let err = v8::String::new(scope, &msg).unwrap();
                            resolver.reject(scope, err.into());
                        },
                    )
                }
            }
        });
    });
}

fn rename_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let from = args.get(0).to_rust_string_lossy(scope);
    let to = args.get(1).to_rust_string_lossy(scope);

    // Check read permission for source and write permission for destination
    if let Err(e) = permissions::check_read(&from) {
        throw_error(scope, &e);
        return;
    }
    if let Err(e) = permissions::check_write(&to) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || match fs::rename(&from, &to) {
            Ok(()) => Box::new(
                |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    let undefined = v8::undefined(scope);
                    resolver.resolve(scope, undefined.into());
                },
            ),
            Err(e) => {
                let msg = format!("Failed to rename '{}' to '{}': {}", from, to, e);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let err = v8::String::new(scope, &msg).unwrap();
                        resolver.reject(scope, err.into());
                    },
                )
            }
        });
    });
}

fn copy_file(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let from = args.get(0).to_rust_string_lossy(scope);
    let to = args.get(1).to_rust_string_lossy(scope);

    // Check read permission for source and write permission for destination
    if let Err(e) = permissions::check_read(&from) {
        throw_error(scope, &e);
        return;
    }
    if let Err(e) = permissions::check_write(&to) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || match fs::copy(&from, &to) {
            Ok(_) => Box::new(
                |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    let undefined = v8::undefined(scope);
                    resolver.resolve(scope, undefined.into());
                },
            ),
            Err(e) => {
                let msg = format!("Failed to copy '{}' to '{}': {}", from, to, e);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let err = v8::String::new(scope, &msg).unwrap();
                        resolver.reject(scope, err.into());
                    },
                )
            }
        });
    });
}

// ============ STAT/EXISTS ============

#[derive(Clone)]
struct FileInfoData {
    name: String,
    size: u64,
    is_file: bool,
    is_directory: bool,
    is_symlink: bool,
    mtime: Option<f64>,
    atime: Option<f64>,
    birthtime: Option<f64>,
    mode: u32,
}

impl FileInfoData {
    fn from_metadata(path: &str, metadata: &fs::Metadata) -> Self {
        let name = Path::new(path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        Self {
            name,
            size: metadata.len(),
            is_file: metadata.is_file(),
            is_directory: metadata.is_dir(),
            is_symlink: metadata.file_type().is_symlink(),
            mtime: system_time_to_ms(metadata.modified().ok()),
            atime: system_time_to_ms(metadata.accessed().ok()),
            birthtime: system_time_to_ms(metadata.created().ok()),
            mode: file_mode(metadata),
        }
    }
}

fn system_time_to_ms(time: Option<SystemTime>) -> Option<f64> {
    time.and_then(|t| {
        t.duration_since(SystemTime::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_secs_f64() * 1000.0)
    })
}

#[cfg(unix)]
fn file_mode(metadata: &fs::Metadata) -> u32 {
    use std::os::unix::fs::MetadataExt;
    metadata.mode()
}

#[cfg(windows)]
fn file_mode(metadata: &fs::Metadata) -> u32 {
    if metadata.permissions().readonly() {
        0o444
    } else {
        0o666
    }
}

fn create_file_info_obj<'s>(
    scope: &mut v8::HandleScope<'s>,
    info: &FileInfoData,
) -> v8::Local<'s, v8::Object> {
    let obj = v8::Object::new(scope);

    // name
    let name_key = v8::String::new(scope, "name").unwrap();
    let name_val = v8::String::new(scope, &info.name).unwrap();
    obj.set(scope, name_key.into(), name_val.into());

    // size
    let size_key = v8::String::new(scope, "size").unwrap();
    let size_val = v8::Number::new(scope, info.size as f64);
    obj.set(scope, size_key.into(), size_val.into());

    // isFile
    let is_file_key = v8::String::new(scope, "isFile").unwrap();
    let is_file_val = v8::Boolean::new(scope, info.is_file);
    obj.set(scope, is_file_key.into(), is_file_val.into());

    // isDirectory
    let is_dir_key = v8::String::new(scope, "isDirectory").unwrap();
    let is_dir_val = v8::Boolean::new(scope, info.is_directory);
    obj.set(scope, is_dir_key.into(), is_dir_val.into());

    // isSymlink
    let is_symlink_key = v8::String::new(scope, "isSymlink").unwrap();
    let is_symlink_val = v8::Boolean::new(scope, info.is_symlink);
    obj.set(scope, is_symlink_key.into(), is_symlink_val.into());

    // mode
    let mode_key = v8::String::new(scope, "mode").unwrap();
    let mode_val = v8::Number::new(scope, info.mode as f64);
    obj.set(scope, mode_key.into(), mode_val.into());

    // mtime
    let mtime_key = v8::String::new(scope, "mtime").unwrap();
    if let Some(ts) = info.mtime {
        let date = v8::Date::new(scope, ts).unwrap();
        obj.set(scope, mtime_key.into(), date.into());
    } else {
        let null = v8::null(scope);
        obj.set(scope, mtime_key.into(), null.into());
    }

    // atime
    let atime_key = v8::String::new(scope, "atime").unwrap();
    if let Some(ts) = info.atime {
        let date = v8::Date::new(scope, ts).unwrap();
        obj.set(scope, atime_key.into(), date.into());
    } else {
        let null = v8::null(scope);
        obj.set(scope, atime_key.into(), null.into());
    }

    // birthtime
    let birthtime_key = v8::String::new(scope, "birthtime").unwrap();
    if let Some(ts) = info.birthtime {
        let date = v8::Date::new(scope, ts).unwrap();
        obj.set(scope, birthtime_key.into(), date.into());
    } else {
        let null = v8::null(scope);
        obj.set(scope, birthtime_key.into(), null.into());
    }

    obj
}

fn stat_sync(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            let info = FileInfoData::from_metadata(&path, &metadata);
            let obj = create_file_info_obj(scope, &info);
            rv.set(obj.into());
        }
        Err(e) => throw_error(scope, &format!("Failed to stat '{}': {}", path, e)),
    }
}

fn stat(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                let info = FileInfoData::from_metadata(&path, &metadata);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let obj = create_file_info_obj(scope, &info);
                        resolver.resolve(scope, obj.into());
                    },
                )
            }
            Err(e) => {
                let msg = format!("Failed to stat '{}': {}", path, e);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let err = v8::String::new(scope, &msg).unwrap();
                        resolver.reject(scope, err.into());
                    },
                )
            }
        });
    });
}

fn exists_sync(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    let exists = Path::new(&path).exists();
    let result = v8::Boolean::new(scope, exists);
    rv.set(result.into());
}

fn exists(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || {
            let exists = Path::new(&path).exists();
            Box::new(
                move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    let result = v8::Boolean::new(scope, exists);
                    resolver.resolve(scope, result.into());
                },
            )
        });
    });
}

// ============ SYMLINKS ============

fn symlink(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let target = args.get(0).to_rust_string_lossy(scope);
    let path = args.get(1).to_rust_string_lossy(scope);

    // Check write permission for the symlink path
    if let Err(e) = permissions::check_write(&path) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || match create_symlink(&target, &path) {
            Ok(()) => Box::new(
                |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    let undefined = v8::undefined(scope);
                    resolver.resolve(scope, undefined.into());
                },
            ),
            Err(e) => {
                let msg = format!("Failed to create symlink '{}' -> '{}': {}", path, target, e);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let err = v8::String::new(scope, &msg).unwrap();
                        resolver.reject(scope, err.into());
                    },
                )
            }
        });
    });
}

#[cfg(unix)]
fn create_symlink(target: &str, path: &str) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, path)
}

#[cfg(windows)]
fn create_symlink(target: &str, path: &str) -> std::io::Result<()> {
    let target_path = Path::new(target);
    if target_path.is_dir() {
        std::os::windows::fs::symlink_dir(target, path)
    } else {
        std::os::windows::fs::symlink_file(target, path)
    }
}

fn read_link(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let path = args.get(0).to_rust_string_lossy(scope);

    // Check read permission
    if let Err(e) = permissions::check_read(&path) {
        throw_error(scope, &e);
        return;
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    rv.set(promise.into());

    EVENT_LOOP.with(|el| {
        let handle = el.borrow();
        let handle = handle.as_ref().unwrap();
        let id = handle.register_resolver(scope, resolver);

        handle.spawn(id, move || match fs::read_link(&path) {
            Ok(target) => {
                let target_str = target.to_string_lossy().to_string();
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let result = v8::String::new(scope, &target_str).unwrap();
                        resolver.resolve(scope, result.into());
                    },
                )
            }
            Err(e) => {
                let msg = format!("Failed to read link '{}': {}", path, e);
                Box::new(
                    move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                        let err = v8::String::new(scope, &msg).unwrap();
                        resolver.reject(scope, err.into());
                    },
                )
            }
        });
    });
}

use rusty_v8 as v8;

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let func = v8::Function::new(scope, structured_clone_callback).unwrap();
    let key = v8::String::new(scope, "structuredClone").unwrap();
    global.set(scope, key.into(), func.into());
}

fn structured_clone_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        let undefined = v8::undefined(scope);
        rv.set(undefined.into());
        return;
    }

    let value = args.get(0);

    if value.is_undefined() {
        rv.set(v8::undefined(scope).into());
        return;
    }

    if value.is_null() {
        rv.set(v8::null(scope).into());
        return;
    }

    if value.is_boolean() {
        rv.set(value);
        return;
    }

    if value.is_number() {
        rv.set(value);
        return;
    }

    if value.is_string() {
        rv.set(value);
        return;
    }

    if value.is_date() {
        let date = v8::Local::<v8::Date>::try_from(value).unwrap();
        let time = date.value_of();
        let cloned = v8::Date::new(scope, time).unwrap();
        rv.set(cloned.into());
        return;
    }

    if value.is_array_buffer() {
        let ab = v8::Local::<v8::ArrayBuffer>::try_from(value).unwrap();
        let len = ab.byte_length();
        let new_ab = v8::ArrayBuffer::new(scope, len);

        if len > 0 {
            let src_store = ab.get_backing_store();
            let dst_store = new_ab.get_backing_store();
            let src_ptr = src_store.data();
            let dst_ptr = dst_store.data();

            if !src_ptr.is_null() && !dst_ptr.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(src_ptr as *const u8, dst_ptr as *mut u8, len);
                }
            }
        }

        rv.set(new_ab.into());
        return;
    }

    if value.is_uint8_array() {
        let src = v8::Local::<v8::Uint8Array>::try_from(value).unwrap();
        let len = src.byte_length();
        let mut bytes = vec![0u8; len];
        if len > 0 {
            src.copy_contents(&mut bytes);
        }

        let ab = v8::ArrayBuffer::new(scope, len);
        if len > 0 {
            let store = ab.get_backing_store();
            let ptr = store.data();
            if !ptr.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr as *mut u8, len);
                }
            }
        }

        let cloned = v8::Uint8Array::new(scope, ab, 0, len).unwrap();
        rv.set(cloned.into());
        return;
    }

    // For objects and arrays, use JSON serialization as fallback
    // This handles most common cases but doesn't support circular refs, Maps, Sets, etc.
    if value.is_object() || value.is_array() {
        let global = scope.get_current_context().global(scope);
        let json_key = v8::String::new(scope, "JSON").unwrap();

        if let Some(json) = global.get(scope, json_key.into()) {
            if let Some(json_obj) = json.to_object(scope) {
                let stringify_key = v8::String::new(scope, "stringify").unwrap();
                let parse_key = v8::String::new(scope, "parse").unwrap();

                if let (Some(stringify), Some(parse)) = (
                    json_obj.get(scope, stringify_key.into()),
                    json_obj.get(scope, parse_key.into()),
                ) {
                    if let (Ok(stringify_fn), Ok(parse_fn)) = (
                        v8::Local::<v8::Function>::try_from(stringify),
                        v8::Local::<v8::Function>::try_from(parse),
                    ) {
                        let undefined = v8::undefined(scope);

                        // Try to stringify
                        if let Some(json_str) = stringify_fn.call(scope, json.into(), &[value]) {
                            // Check if stringify returned undefined (e.g., for functions)
                            if json_str.is_undefined() {
                                let msg = v8::String::new(
                                    scope,
                                    "Failed to clone: object contains non-serializable values",
                                )
                                .unwrap();
                                let exception = v8::Exception::error(scope, msg);
                                scope.throw_exception(exception);
                                return;
                            }

                            // Parse back
                            if let Some(cloned) =
                                parse_fn.call(scope, undefined.into(), &[json_str])
                            {
                                rv.set(cloned);
                                return;
                            }
                        }
                    }
                }
            }
        }

        let msg = v8::String::new(scope, "Failed to clone object").unwrap();
        let exception = v8::Exception::error(scope, msg);
        scope.throw_exception(exception);
        return;
    }

    // For unsupported types, throw an error
    let msg = v8::String::new(scope, "structuredClone: unsupported type").unwrap();
    let exception = v8::Exception::error(scope, msg);
    scope.throw_exception(exception);
}

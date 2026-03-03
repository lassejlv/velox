//! Web Standard API implementation: Headers, Request, Response
//! Compatible with Bun/Deno for Hono framework support

use rusty_v8 as v8;

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    init_headers(scope, global);
    init_request(scope, global);
    init_response(scope, global);
}

// =============================================================================
// Headers
// =============================================================================

fn init_headers(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    // Create Headers constructor function
    let headers_tmpl = v8::FunctionTemplate::new(scope, headers_constructor);
    let headers_func = headers_tmpl.get_function(scope).unwrap();

    // Add prototype methods
    let proto = v8::Object::new(scope);

    add_method(scope, proto, "get", headers_get);
    add_method(scope, proto, "set", headers_set);
    add_method(scope, proto, "has", headers_has);
    add_method(scope, proto, "delete", headers_delete);
    add_method(scope, proto, "append", headers_append);
    add_method(scope, proto, "entries", headers_entries);
    add_method(scope, proto, "keys", headers_keys);
    add_method(scope, proto, "values", headers_values);
    add_method(scope, proto, "forEach", headers_foreach);

    let proto_key = v8::String::new(scope, "prototype").unwrap();
    headers_func
        .to_object(scope)
        .unwrap()
        .set(scope, proto_key.into(), proto.into());

    let headers_key = v8::String::new(scope, "Headers").unwrap();
    global.set(scope, headers_key.into(), headers_func.into());
}

fn headers_constructor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();

    // Create internal storage for headers (using a plain object with _data)
    let data = v8::Object::new(scope);
    let data_key = v8::String::new(scope, "_data").unwrap();
    this.set(scope, data_key.into(), data.into());

    // Handle initialization from argument
    if args.length() > 0 {
        let init_arg = args.get(0);

        if init_arg.is_array() {
            // Array of [key, value] pairs
            let arr = v8::Local::<v8::Array>::try_from(init_arg).unwrap();
            let len = arr.length();
            for i in 0..len {
                if let Some(pair) = arr.get_index(scope, i) {
                    if pair.is_array() {
                        let pair_arr = v8::Local::<v8::Array>::try_from(pair).unwrap();
                        if pair_arr.length() >= 2 {
                            let key = pair_arr.get_index(scope, 0).unwrap();
                            let val = pair_arr.get_index(scope, 1).unwrap();
                            let key_str = key.to_rust_string_lossy(scope).to_lowercase();
                            let key_v8 = v8::String::new(scope, &key_str).unwrap();
                            data.set(scope, key_v8.into(), val);
                        }
                    }
                }
            }
        } else if init_arg.is_object() && !init_arg.is_null() {
            // Object with header key-value pairs
            let obj = v8::Local::<v8::Object>::try_from(init_arg).unwrap();
            if let Some(names) = obj.get_own_property_names(scope) {
                let len = names.length();
                for i in 0..len {
                    if let Some(key) = names.get_index(scope, i) {
                        let key_str = key.to_rust_string_lossy(scope).to_lowercase();
                        if let Some(val) = obj.get(scope, key) {
                            let key_v8 = v8::String::new(scope, &key_str).unwrap();
                            data.set(scope, key_v8.into(), val);
                        }
                    }
                }
            }
        }
    }

    rv.set(this.into());
}

fn get_headers_data<'s>(
    scope: &mut v8::HandleScope<'s>,
    this: v8::Local<v8::Object>,
) -> Option<v8::Local<'s, v8::Object>> {
    let data_key = v8::String::new(scope, "_data").unwrap();
    this.get(scope, data_key.into())
        .filter(|v| v.is_object())
        .map(|v| v8::Local::<v8::Object>::try_from(v).unwrap())
}

fn headers_get(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    if let Some(data) = get_headers_data(scope, this) {
        if args.length() > 0 {
            let key = args.get(0).to_rust_string_lossy(scope).to_lowercase();
            let key_v8 = v8::String::new(scope, &key).unwrap();
            if let Some(val) = data.get(scope, key_v8.into()) {
                if !val.is_undefined() {
                    rv.set(val);
                    return;
                }
            }
        }
    }
    rv.set(v8::null(scope).into());
}

fn headers_set(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let this = args.this();
    if let Some(data) = get_headers_data(scope, this) {
        if args.length() >= 2 {
            let key = args.get(0).to_rust_string_lossy(scope).to_lowercase();
            let val = args.get(1);
            let key_v8 = v8::String::new(scope, &key).unwrap();
            data.set(scope, key_v8.into(), val);
        }
    }
}

fn headers_has(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    if let Some(data) = get_headers_data(scope, this) {
        if args.length() > 0 {
            let key = args.get(0).to_rust_string_lossy(scope).to_lowercase();
            let key_v8 = v8::String::new(scope, &key).unwrap();
            if let Some(val) = data.get(scope, key_v8.into()) {
                if !val.is_undefined() {
                    rv.set(v8::Boolean::new(scope, true).into());
                    return;
                }
            }
        }
    }
    rv.set(v8::Boolean::new(scope, false).into());
}

fn headers_delete(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let this = args.this();
    if let Some(data) = get_headers_data(scope, this) {
        if args.length() > 0 {
            let key = args.get(0).to_rust_string_lossy(scope).to_lowercase();
            let key_v8 = v8::String::new(scope, &key).unwrap();
            data.delete(scope, key_v8.into());
        }
    }
}

fn headers_append(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let this = args.this();
    if let Some(data) = get_headers_data(scope, this) {
        if args.length() >= 2 {
            let key = args.get(0).to_rust_string_lossy(scope).to_lowercase();
            let new_val = args.get(1).to_rust_string_lossy(scope);
            let key_v8 = v8::String::new(scope, &key).unwrap();

            // If key exists, append with comma separator
            let combined = if let Some(existing) = data.get(scope, key_v8.into()) {
                if !existing.is_undefined() {
                    let existing_str = existing.to_rust_string_lossy(scope);
                    format!("{}, {}", existing_str, new_val)
                } else {
                    new_val
                }
            } else {
                new_val
            };

            let combined_v8 = v8::String::new(scope, &combined).unwrap();
            data.set(scope, key_v8.into(), combined_v8.into());
        }
    }
}

fn headers_entries(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    if let Some(data) = get_headers_data(scope, this) {
        let result = v8::Array::new(scope, 0);
        let mut idx = 0;

        if let Some(names) = data.get_own_property_names(scope) {
            let len = names.length();
            for i in 0..len {
                if let Some(key) = names.get_index(scope, i) {
                    if let Some(val) = data.get(scope, key) {
                        let pair = v8::Array::new(scope, 2);
                        pair.set_index(scope, 0, key);
                        pair.set_index(scope, 1, val);
                        result.set_index(scope, idx, pair.into());
                        idx += 1;
                    }
                }
            }
        }
        rv.set(result.into());
    }
}

fn headers_keys(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    if let Some(data) = get_headers_data(scope, this) {
        if let Some(names) = data.get_own_property_names(scope) {
            rv.set(names.into());
            return;
        }
    }
    rv.set(v8::Array::new(scope, 0).into());
}

fn headers_values(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    if let Some(data) = get_headers_data(scope, this) {
        let result = v8::Array::new(scope, 0);
        let mut idx = 0;

        if let Some(names) = data.get_own_property_names(scope) {
            let len = names.length();
            for i in 0..len {
                if let Some(key) = names.get_index(scope, i) {
                    if let Some(val) = data.get(scope, key) {
                        result.set_index(scope, idx, val);
                        idx += 1;
                    }
                }
            }
        }
        rv.set(result.into());
    }
}

fn headers_foreach(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let this = args.this();
    if args.length() < 1 || !args.get(0).is_function() {
        return;
    }

    let callback = v8::Local::<v8::Function>::try_from(args.get(0)).unwrap();

    if let Some(data) = get_headers_data(scope, this) {
        if let Some(names) = data.get_own_property_names(scope) {
            let len = names.length();
            for i in 0..len {
                if let Some(key) = names.get_index(scope, i) {
                    if let Some(val) = data.get(scope, key) {
                        let undefined = v8::undefined(scope);
                        callback.call(scope, undefined.into(), &[val, key, this.into()]);
                    }
                }
            }
        }
    }
}

// =============================================================================
// Request
// =============================================================================

fn init_request(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let request_tmpl = v8::FunctionTemplate::new(scope, request_constructor);
    let request_func = request_tmpl.get_function(scope).unwrap();

    let proto = v8::Object::new(scope);
    add_method(scope, proto, "text", request_text);
    add_method(scope, proto, "json", request_json);
    add_method(scope, proto, "arrayBuffer", request_arraybuffer);
    add_method(scope, proto, "bytes", request_bytes);
    add_method(scope, proto, "clone", request_clone);

    let proto_key = v8::String::new(scope, "prototype").unwrap();
    request_func
        .to_object(scope)
        .unwrap()
        .set(scope, proto_key.into(), proto.into());

    let request_key = v8::String::new(scope, "Request").unwrap();
    global.set(scope, request_key.into(), request_func.into());
}

fn request_constructor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();

    // Default values
    let mut url = String::new();
    let mut method = "GET".to_string();
    let mut body: Option<v8::Local<v8::Value>> = None;

    // Parse first argument (URL or Request)
    if args.length() > 0 {
        let first = args.get(0);
        if first.is_string() {
            url = first.to_rust_string_lossy(scope);
        } else if first.is_object() {
            // Could be a Request object - copy properties
            let obj = v8::Local::<v8::Object>::try_from(first).unwrap();
            let url_key = v8::String::new(scope, "url").unwrap();
            if let Some(url_val) = obj.get(scope, url_key.into()) {
                url = url_val.to_rust_string_lossy(scope);
            }
        }
    }

    // Parse second argument (options)
    if args.length() > 1 {
        let opts = args.get(1);
        if opts.is_object() && !opts.is_null() {
            let opts_obj = v8::Local::<v8::Object>::try_from(opts).unwrap();

            let method_key = v8::String::new(scope, "method").unwrap();
            if let Some(method_val) = opts_obj.get(scope, method_key.into()) {
                if !method_val.is_undefined() {
                    method = method_val.to_rust_string_lossy(scope).to_uppercase();
                }
            }

            let body_key = v8::String::new(scope, "body").unwrap();
            if let Some(body_val) = opts_obj.get(scope, body_key.into()) {
                if !body_val.is_null_or_undefined() {
                    body = Some(body_val);
                }
            }
        }
    }

    // Set url
    let url_key = v8::String::new(scope, "url").unwrap();
    let url_val = v8::String::new(scope, &url).unwrap();
    this.set(scope, url_key.into(), url_val.into());

    // Set method
    let method_key = v8::String::new(scope, "method").unwrap();
    let method_val = v8::String::new(scope, &method).unwrap();
    this.set(scope, method_key.into(), method_val.into());

    // Set headers (create new Headers object)
    let headers_key = v8::String::new(scope, "headers").unwrap();
    let headers_constructor_key = v8::String::new(scope, "Headers").unwrap();
    let global = scope.get_current_context().global(scope);

    if let Some(headers_ctor) = global.get(scope, headers_constructor_key.into()) {
        if let Ok(headers_func) = v8::Local::<v8::Function>::try_from(headers_ctor) {
            // Get headers from options if provided
            if args.length() > 1 {
                let opts = args.get(1);
                if opts.is_object() && !opts.is_null() {
                    let opts_obj = v8::Local::<v8::Object>::try_from(opts).unwrap();
                    if let Some(headers_init) = opts_obj.get(scope, headers_key.into()) {
                        if !headers_init.is_undefined() {
                            if let Some(headers_obj) =
                                headers_func.new_instance(scope, &[headers_init])
                            {
                                this.set(scope, headers_key.into(), headers_obj.into());
                            }
                        } else {
                            // Create empty headers
                            if let Some(headers_obj) = headers_func.new_instance(scope, &[]) {
                                this.set(scope, headers_key.into(), headers_obj.into());
                            }
                        }
                    } else if let Some(headers_obj) = headers_func.new_instance(scope, &[]) {
                        this.set(scope, headers_key.into(), headers_obj.into());
                    }
                } else if let Some(headers_obj) = headers_func.new_instance(scope, &[]) {
                    this.set(scope, headers_key.into(), headers_obj.into());
                }
            } else if let Some(headers_obj) = headers_func.new_instance(scope, &[]) {
                this.set(scope, headers_key.into(), headers_obj.into());
            }
        }
    }

    // Set body
    let body_key = v8::String::new(scope, "_body").unwrap();
    if let Some(body_val) = body {
        this.set(scope, body_key.into(), body_val);
    } else {
        let null_val = v8::null(scope);
        this.set(scope, body_key.into(), null_val.into());
    }

    // Set bodyUsed
    let body_used_key = v8::String::new(scope, "bodyUsed").unwrap();
    let false_val = v8::Boolean::new(scope, false);
    this.set(scope, body_used_key.into(), false_val.into());

    rv.set(this.into());
}

fn request_text(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);

    // Mark bodyUsed
    let body_used_key = v8::String::new(scope, "bodyUsed").unwrap();
    let true_val = v8::Boolean::new(scope, true);
    this.set(scope, body_used_key.into(), true_val.into());

    let body_key = v8::String::new(scope, "_body").unwrap();
    if let Some(body) = this.get(scope, body_key.into()) {
        if body.is_string() {
            resolver.resolve(scope, body);
        } else if body.is_uint8_array() {
            let uint8 = v8::Local::<v8::Uint8Array>::try_from(body).unwrap();
            let len = uint8.byte_length();
            let mut bytes = vec![0u8; len];
            uint8.copy_contents(&mut bytes);
            let text = String::from_utf8_lossy(&bytes);
            let text_val = v8::String::new(scope, &text).unwrap();
            resolver.resolve(scope, text_val.into());
        } else if body.is_array_buffer() {
            let ab = v8::Local::<v8::ArrayBuffer>::try_from(body).unwrap();
            let store = ab.get_backing_store();
            let len = store.byte_length();
            let mut bytes = vec![0u8; len];
            let data_ptr = store.data();
            if !data_ptr.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(data_ptr as *const u8, bytes.as_mut_ptr(), len);
                }
            }
            let text = String::from_utf8_lossy(&bytes);
            let text_val = v8::String::new(scope, &text).unwrap();
            resolver.resolve(scope, text_val.into());
        } else {
            let empty = v8::String::new(scope, "").unwrap();
            resolver.resolve(scope, empty.into());
        }
    } else {
        let empty = v8::String::new(scope, "").unwrap();
        resolver.resolve(scope, empty.into());
    }

    rv.set(promise.into());
}

fn request_json(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);

    // Mark bodyUsed
    let body_used_key = v8::String::new(scope, "bodyUsed").unwrap();
    let true_val = v8::Boolean::new(scope, true);
    this.set(scope, body_used_key.into(), true_val.into());

    let body_key = v8::String::new(scope, "_body").unwrap();
    if let Some(body) = this.get(scope, body_key.into()) {
        let text = if body.is_string() {
            body.to_rust_string_lossy(scope)
        } else if body.is_uint8_array() {
            let uint8 = v8::Local::<v8::Uint8Array>::try_from(body).unwrap();
            let len = uint8.byte_length();
            let mut bytes = vec![0u8; len];
            uint8.copy_contents(&mut bytes);
            String::from_utf8_lossy(&bytes).to_string()
        } else {
            String::new()
        };

        let text_v8 = v8::String::new(scope, &text).unwrap();
        if let Some(json_val) = v8::json::parse(scope, text_v8) {
            resolver.resolve(scope, json_val);
        } else {
            let err = v8::String::new(scope, "Failed to parse JSON").unwrap();
            resolver.reject(scope, err.into());
        }
    } else {
        let err = v8::String::new(scope, "No body to parse").unwrap();
        resolver.reject(scope, err.into());
    }

    rv.set(promise.into());
}

fn request_arraybuffer(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);

    // Mark bodyUsed
    let body_used_key = v8::String::new(scope, "bodyUsed").unwrap();
    let true_val = v8::Boolean::new(scope, true);
    this.set(scope, body_used_key.into(), true_val.into());

    let body_key = v8::String::new(scope, "_body").unwrap();
    if let Some(body) = this.get(scope, body_key.into()) {
        let bytes: Vec<u8> = if body.is_string() {
            body.to_rust_string_lossy(scope).into_bytes()
        } else if body.is_uint8_array() {
            let uint8 = v8::Local::<v8::Uint8Array>::try_from(body).unwrap();
            let len = uint8.byte_length();
            let mut data = vec![0u8; len];
            uint8.copy_contents(&mut data);
            data
        } else if body.is_array_buffer() {
            let ab = v8::Local::<v8::ArrayBuffer>::try_from(body).unwrap();
            let store = ab.get_backing_store();
            let len = store.byte_length();
            let mut data = vec![0u8; len];
            let data_ptr = store.data();
            if !data_ptr.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(data_ptr as *const u8, data.as_mut_ptr(), len);
                }
            }
            data
        } else {
            Vec::new()
        };

        let ab = v8::ArrayBuffer::new(scope, bytes.len());
        let store = ab.get_backing_store();
        let data_ptr = store.data();
        if !data_ptr.is_null() {
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), data_ptr as *mut u8, bytes.len());
            }
        }
        resolver.resolve(scope, ab.into());
    } else {
        let ab = v8::ArrayBuffer::new(scope, 0);
        resolver.resolve(scope, ab.into());
    }

    rv.set(promise.into());
}

fn request_bytes(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);

    // Mark bodyUsed
    let body_used_key = v8::String::new(scope, "bodyUsed").unwrap();
    let true_val = v8::Boolean::new(scope, true);
    this.set(scope, body_used_key.into(), true_val.into());

    let body_key = v8::String::new(scope, "_body").unwrap();
    if let Some(body) = this.get(scope, body_key.into()) {
        let bytes: Vec<u8> = if body.is_string() {
            body.to_rust_string_lossy(scope).into_bytes()
        } else if body.is_uint8_array() {
            let uint8 = v8::Local::<v8::Uint8Array>::try_from(body).unwrap();
            let len = uint8.byte_length();
            let mut data = vec![0u8; len];
            uint8.copy_contents(&mut data);
            data
        } else if body.is_array_buffer() {
            let ab = v8::Local::<v8::ArrayBuffer>::try_from(body).unwrap();
            let store = ab.get_backing_store();
            let len = store.byte_length();
            let mut data = vec![0u8; len];
            let data_ptr = store.data();
            if !data_ptr.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(data_ptr as *const u8, data.as_mut_ptr(), len);
                }
            }
            data
        } else {
            Vec::new()
        };

        let ab = v8::ArrayBuffer::new(scope, bytes.len());
        let store = ab.get_backing_store();
        let data_ptr = store.data();
        if !data_ptr.is_null() {
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), data_ptr as *mut u8, bytes.len());
            }
        }
        let uint8 = v8::Uint8Array::new(scope, ab, 0, bytes.len()).unwrap();
        resolver.resolve(scope, uint8.into());
    } else {
        let ab = v8::ArrayBuffer::new(scope, 0);
        let uint8 = v8::Uint8Array::new(scope, ab, 0, 0).unwrap();
        resolver.resolve(scope, uint8.into());
    }

    rv.set(promise.into());
}

fn request_clone(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();

    // Create new Request object using constructor
    let request_key = v8::String::new(scope, "Request").unwrap();
    let global = scope.get_current_context().global(scope);

    if let Some(ctor) = global.get(scope, request_key.into()) {
        if let Ok(ctor_func) = v8::Local::<v8::Function>::try_from(ctor) {
            // Get URL
            let url_key = v8::String::new(scope, "url").unwrap();
            let url = this
                .get(scope, url_key.into())
                .unwrap_or_else(|| v8::String::new(scope, "").unwrap().into());

            // Create options object
            let opts = v8::Object::new(scope);

            let method_key = v8::String::new(scope, "method").unwrap();
            if let Some(method) = this.get(scope, method_key.into()) {
                opts.set(scope, method_key.into(), method);
            }

            let headers_key = v8::String::new(scope, "headers").unwrap();
            if let Some(headers) = this.get(scope, headers_key.into()) {
                opts.set(scope, headers_key.into(), headers);
            }

            let body_key = v8::String::new(scope, "_body").unwrap();
            let body_opt_key = v8::String::new(scope, "body").unwrap();
            if let Some(body) = this.get(scope, body_key.into()) {
                opts.set(scope, body_opt_key.into(), body);
            }

            if let Some(new_req) = ctor_func.new_instance(scope, &[url, opts.into()]) {
                rv.set(new_req.into());
                return;
            }
        }
    }

    rv.set(v8::null(scope).into());
}

// =============================================================================
// Response
// =============================================================================

fn init_response(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let response_tmpl = v8::FunctionTemplate::new(scope, response_constructor);
    let response_func = response_tmpl.get_function(scope).unwrap();

    // Add prototype methods
    let proto = v8::Object::new(scope);
    add_method(scope, proto, "text", response_text);
    add_method(scope, proto, "json", response_json);
    add_method(scope, proto, "arrayBuffer", response_arraybuffer);
    add_method(scope, proto, "bytes", response_bytes);
    add_method(scope, proto, "clone", response_clone);

    let proto_key = v8::String::new(scope, "prototype").unwrap();
    response_func
        .to_object(scope)
        .unwrap()
        .set(scope, proto_key.into(), proto.into());

    // Add static methods
    let json_static = v8::Function::new(scope, response_json_static).unwrap();
    let json_key = v8::String::new(scope, "json").unwrap();
    response_func
        .to_object(scope)
        .unwrap()
        .set(scope, json_key.into(), json_static.into());

    let redirect_static = v8::Function::new(scope, response_redirect_static).unwrap();
    let redirect_key = v8::String::new(scope, "redirect").unwrap();
    response_func
        .to_object(scope)
        .unwrap()
        .set(scope, redirect_key.into(), redirect_static.into());

    let error_static = v8::Function::new(scope, response_error_static).unwrap();
    let error_key = v8::String::new(scope, "error").unwrap();
    response_func
        .to_object(scope)
        .unwrap()
        .set(scope, error_key.into(), error_static.into());

    let response_key = v8::String::new(scope, "Response").unwrap();
    global.set(scope, response_key.into(), response_func.into());
}

fn response_constructor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();

    // Default values
    let mut status: u16 = 200;
    let mut status_text = "OK".to_string();

    // Parse body (first argument)
    let body_key = v8::String::new(scope, "_body").unwrap();
    if args.length() > 0 {
        let body = args.get(0);
        if !body.is_null_or_undefined() {
            this.set(scope, body_key.into(), body);
        } else {
            let null_val = v8::null(scope);
            this.set(scope, body_key.into(), null_val.into());
        }
    } else {
        let null_val = v8::null(scope);
        this.set(scope, body_key.into(), null_val.into());
    }

    // Parse options (second argument)
    let headers_key = v8::String::new(scope, "headers").unwrap();
    let global = scope.get_current_context().global(scope);
    let headers_constructor_key = v8::String::new(scope, "Headers").unwrap();

    if args.length() > 1 {
        let opts = args.get(1);
        if opts.is_object() && !opts.is_null() {
            let opts_obj = v8::Local::<v8::Object>::try_from(opts).unwrap();

            // status
            let status_key = v8::String::new(scope, "status").unwrap();
            if let Some(status_val) = opts_obj.get(scope, status_key.into()) {
                if let Some(s) = status_val.uint32_value(scope) {
                    status = s as u16;
                }
            }

            // statusText
            let status_text_key = v8::String::new(scope, "statusText").unwrap();
            if let Some(st_val) = opts_obj.get(scope, status_text_key.into()) {
                if !st_val.is_undefined() {
                    status_text = st_val.to_rust_string_lossy(scope);
                }
            }

            // headers
            if let Some(headers_init) = opts_obj.get(scope, headers_key.into()) {
                if !headers_init.is_undefined() {
                    if let Some(headers_ctor) = global.get(scope, headers_constructor_key.into()) {
                        if let Ok(headers_func) = v8::Local::<v8::Function>::try_from(headers_ctor)
                        {
                            if let Some(headers_obj) =
                                headers_func.new_instance(scope, &[headers_init])
                            {
                                this.set(scope, headers_key.into(), headers_obj.into());
                            }
                        }
                    }
                }
            }
        }
    }

    // Create empty headers if not set
    let has_headers = this
        .get(scope, headers_key.into())
        .map(|v| !v.is_undefined())
        .unwrap_or(false);

    if !has_headers {
        if let Some(headers_ctor) = global.get(scope, headers_constructor_key.into()) {
            if let Ok(headers_func) = v8::Local::<v8::Function>::try_from(headers_ctor) {
                if let Some(headers_obj) = headers_func.new_instance(scope, &[]) {
                    this.set(scope, headers_key.into(), headers_obj.into());
                }
            }
        }
    }

    // Set status
    let status_key = v8::String::new(scope, "status").unwrap();
    let status_val = v8::Integer::new(scope, status as i32);
    this.set(scope, status_key.into(), status_val.into());

    // Set statusText
    let status_text_key = v8::String::new(scope, "statusText").unwrap();
    let status_text_val = v8::String::new(scope, &status_text).unwrap();
    this.set(scope, status_text_key.into(), status_text_val.into());

    // Set ok (status 200-299)
    let ok_key = v8::String::new(scope, "ok").unwrap();
    let ok_val = v8::Boolean::new(scope, status >= 200 && status <= 299);
    this.set(scope, ok_key.into(), ok_val.into());

    // Set bodyUsed
    let body_used_key = v8::String::new(scope, "bodyUsed").unwrap();
    let false_val = v8::Boolean::new(scope, false);
    this.set(scope, body_used_key.into(), false_val.into());

    rv.set(this.into());
}

// Response.json(data, init?)
fn response_json_static(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let global = scope.get_current_context().global(scope);

    // Stringify the data
    let data = args.get(0);
    let json_key = v8::String::new(scope, "JSON").unwrap();
    let stringify_key = v8::String::new(scope, "stringify").unwrap();

    let json_str = if let Some(json_obj) = global.get(scope, json_key.into()) {
        if let Ok(json_obj) = v8::Local::<v8::Object>::try_from(json_obj) {
            if let Some(stringify) = json_obj.get(scope, stringify_key.into()) {
                if let Ok(stringify_fn) = v8::Local::<v8::Function>::try_from(stringify) {
                    if let Some(result) = stringify_fn.call(scope, json_obj.into(), &[data]) {
                        result
                    } else {
                        v8::String::new(scope, "null").unwrap().into()
                    }
                } else {
                    v8::String::new(scope, "null").unwrap().into()
                }
            } else {
                v8::String::new(scope, "null").unwrap().into()
            }
        } else {
            v8::String::new(scope, "null").unwrap().into()
        }
    } else {
        v8::String::new(scope, "null").unwrap().into()
    };

    // Create Response with JSON body
    let response_key = v8::String::new(scope, "Response").unwrap();
    if let Some(response_ctor) = global.get(scope, response_key.into()) {
        if let Ok(response_func) = v8::Local::<v8::Function>::try_from(response_ctor) {
            // Create options with Content-Type header and default status 200
            let opts = v8::Object::new(scope);

            // Set default status 200, can be overridden by init
            let status_key = v8::String::new(scope, "status").unwrap();
            let default_status = v8::Integer::new(scope, 200);
            opts.set(scope, status_key.into(), default_status.into());

            // Copy status from init if provided
            if args.length() > 1 {
                let init = args.get(1);
                if init.is_object() && !init.is_null() {
                    let init_obj = v8::Local::<v8::Object>::try_from(init).unwrap();

                    if let Some(status) = init_obj.get(scope, status_key.into()) {
                        if !status.is_undefined() {
                            opts.set(scope, status_key.into(), status);
                        }
                    }
                }
            }

            // Set Content-Type header
            let headers_obj = v8::Object::new(scope);
            let ct_key = v8::String::new(scope, "content-type").unwrap();
            let ct_val = v8::String::new(scope, "application/json").unwrap();
            headers_obj.set(scope, ct_key.into(), ct_val.into());

            let headers_key = v8::String::new(scope, "headers").unwrap();
            opts.set(scope, headers_key.into(), headers_obj.into());

            if let Some(response) = response_func.new_instance(scope, &[json_str, opts.into()]) {
                rv.set(response.into());
                return;
            }
        }
    }

    rv.set(v8::null(scope).into());
}

// Response.redirect(url, status?)
fn response_redirect_static(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let url = if args.length() > 0 {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };

    let status: u16 = if args.length() > 1 {
        args.get(1).uint32_value(scope).unwrap_or(302) as u16
    } else {
        302
    };

    let global = scope.get_current_context().global(scope);
    let response_key = v8::String::new(scope, "Response").unwrap();

    if let Some(response_ctor) = global.get(scope, response_key.into()) {
        if let Ok(response_func) = v8::Local::<v8::Function>::try_from(response_ctor) {
            let opts = v8::Object::new(scope);

            let status_key = v8::String::new(scope, "status").unwrap();
            let status_val = v8::Integer::new(scope, status as i32);
            opts.set(scope, status_key.into(), status_val.into());

            // Set Location header
            let headers_obj = v8::Object::new(scope);
            let location_key = v8::String::new(scope, "location").unwrap();
            let location_val = v8::String::new(scope, &url).unwrap();
            headers_obj.set(scope, location_key.into(), location_val.into());

            let headers_key = v8::String::new(scope, "headers").unwrap();
            opts.set(scope, headers_key.into(), headers_obj.into());

            let null_body = v8::null(scope);
            if let Some(response) =
                response_func.new_instance(scope, &[null_body.into(), opts.into()])
            {
                rv.set(response.into());
                return;
            }
        }
    }

    rv.set(v8::null(scope).into());
}

// Response.error()
fn response_error_static(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let global = scope.get_current_context().global(scope);
    let response_key = v8::String::new(scope, "Response").unwrap();

    if let Some(response_ctor) = global.get(scope, response_key.into()) {
        if let Ok(response_func) = v8::Local::<v8::Function>::try_from(response_ctor) {
            let opts = v8::Object::new(scope);

            let status_key = v8::String::new(scope, "status").unwrap();
            let status_val = v8::Integer::new(scope, 0);
            opts.set(scope, status_key.into(), status_val.into());

            let null_body = v8::null(scope);
            if let Some(response) =
                response_func.new_instance(scope, &[null_body.into(), opts.into()])
            {
                // Set type to "error"
                let type_key = v8::String::new(scope, "type").unwrap();
                let type_val = v8::String::new(scope, "error").unwrap();
                response.set(scope, type_key.into(), type_val.into());

                rv.set(response.into());
                return;
            }
        }
    }

    rv.set(v8::null(scope).into());
}

fn response_text(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    // Same implementation as request_text
    request_text(scope, args, rv);
}

fn response_json(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    request_json(scope, args, rv);
}

fn response_arraybuffer(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    request_arraybuffer(scope, args, rv);
}

fn response_bytes(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    rv: v8::ReturnValue,
) {
    request_bytes(scope, args, rv);
}

fn response_clone(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();

    let response_key = v8::String::new(scope, "Response").unwrap();
    let global = scope.get_current_context().global(scope);

    if let Some(ctor) = global.get(scope, response_key.into()) {
        if let Ok(ctor_func) = v8::Local::<v8::Function>::try_from(ctor) {
            // Get body
            let body_key = v8::String::new(scope, "_body").unwrap();
            let body = this
                .get(scope, body_key.into())
                .unwrap_or_else(|| v8::null(scope).into());

            // Create options object
            let opts = v8::Object::new(scope);

            let status_key = v8::String::new(scope, "status").unwrap();
            if let Some(status) = this.get(scope, status_key.into()) {
                opts.set(scope, status_key.into(), status);
            }

            let status_text_key = v8::String::new(scope, "statusText").unwrap();
            if let Some(st) = this.get(scope, status_text_key.into()) {
                opts.set(scope, status_text_key.into(), st);
            }

            let headers_key = v8::String::new(scope, "headers").unwrap();
            if let Some(headers) = this.get(scope, headers_key.into()) {
                opts.set(scope, headers_key.into(), headers);
            }

            if let Some(new_resp) = ctor_func.new_instance(scope, &[body, opts.into()]) {
                rv.set(new_resp.into());
                return;
            }
        }
    }

    rv.set(v8::null(scope).into());
}

// =============================================================================
// Helper
// =============================================================================

fn add_method(
    scope: &mut v8::HandleScope,
    obj: v8::Local<v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let func = v8::Function::new(scope, callback).unwrap();
    let key = v8::String::new(scope, name).unwrap();
    obj.set(scope, key.into(), func.into());
}

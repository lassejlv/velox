use crate::event_loop::EventLoopHandle;
use crate::permissions;
use rusty_v8 as v8;
use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static EVENT_LOOP: RefCell<Option<EventLoopHandle>> = RefCell::new(None);
}

pub fn set_event_loop(handle: EventLoopHandle) {
    EVENT_LOOP.with(|el| {
        *el.borrow_mut() = Some(handle);
    });
}

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let fetch_fn = v8::Function::new(scope, fetch).unwrap();
    let key = v8::String::new(scope, "fetch").unwrap();
    global.set(scope, key.into(), fetch_fn.into());
}

fn fetch(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let url = if args.length() < 1 {
        throw_error(scope, "fetch requires a URL argument");
        return;
    } else {
        args.get(0).to_rust_string_lossy(scope)
    };

    // Extract host from URL for permission check
    let host = extract_host(&url);
    if let Err(e) = permissions::check_net(&host) {
        throw_error(scope, &e);
        return;
    }

    let mut method = "GET".to_string();
    let mut body: Option<String> = None;
    let mut headers: Vec<(String, String)> = vec![];

    if args.length() > 1 && args.get(1).is_object() {
        let opts = args.get(1).to_object(scope).unwrap();

        let method_key = v8::String::new(scope, "method").unwrap();
        if let Some(m) = opts.get(scope, method_key.into()) {
            if !m.is_undefined() {
                method = m.to_rust_string_lossy(scope).to_uppercase();
            }
        }

        let body_key = v8::String::new(scope, "body").unwrap();
        if let Some(b) = opts.get(scope, body_key.into()) {
            if !b.is_undefined() {
                body = Some(b.to_rust_string_lossy(scope));
            }
        }

        let headers_key = v8::String::new(scope, "headers").unwrap();
        if let Some(h) = opts.get(scope, headers_key.into()) {
            if h.is_object() {
                let h_obj = h.to_object(scope).unwrap();
                if let Some(names) = h_obj.get_own_property_names(scope) {
                    for i in 0..names.length() {
                        let key = names.get_index(scope, i).unwrap();
                        let val = h_obj.get(scope, key).unwrap();
                        headers.push((
                            key.to_rust_string_lossy(scope),
                            val.to_rust_string_lossy(scope),
                        ));
                    }
                }
            }
        }
    }

    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);

    let event_loop = EVENT_LOOP.with(|el| el.borrow().clone());

    if let Some(el) = event_loop {
        let id = el.register_resolver(scope, resolver);

        el.spawn(id, move || {
            let result = perform_request(&url, &method, body.as_deref(), &headers);

            Box::new(
                move |scope: &mut v8::HandleScope, resolver: v8::Local<v8::PromiseResolver>| {
                    match result {
                        Ok((status, body_text, resp_headers)) => {
                            let response =
                                create_response(scope, status, &body_text, &resp_headers);
                            resolver.resolve(scope, response.into());
                        }
                        Err(e) => {
                            let msg =
                                v8::String::new(scope, &format!("fetch failed: {}", e)).unwrap();
                            let err = v8::Exception::error(scope, msg);
                            resolver.reject(scope, err);
                        }
                    }
                },
            )
        });
    } else {
        throw_error(scope, "event loop not initialized");
        return;
    }

    rv.set(promise.into());
}

fn perform_request(
    url: &str,
    method: &str,
    body: Option<&str>,
    headers: &[(String, String)],
) -> Result<(u16, String, HashMap<String, String>), String> {
    let mut req = match method {
        "GET" => ureq::get(url),
        "POST" => ureq::post(url),
        "PUT" => ureq::put(url),
        "DELETE" => ureq::delete(url),
        "PATCH" => ureq::patch(url),
        "HEAD" => ureq::head(url),
        _ => return Err(format!("unsupported method: {}", method)),
    };

    for (key, val) in headers {
        req = req.set(key, val);
    }

    let response = if let Some(b) = body {
        req.send_string(b)
    } else {
        req.call()
    };

    match response {
        Ok(resp) => {
            let status = resp.status();
            let mut resp_headers = HashMap::new();
            for name in resp.headers_names() {
                if let Some(val) = resp.header(&name) {
                    resp_headers.insert(name, val.to_string());
                }
            }
            let body_text = resp.into_string().unwrap_or_default();
            Ok((status, body_text, resp_headers))
        }
        Err(ureq::Error::Status(code, resp)) => {
            let mut resp_headers = HashMap::new();
            for name in resp.headers_names() {
                if let Some(val) = resp.header(&name) {
                    resp_headers.insert(name, val.to_string());
                }
            }
            let body_text = resp.into_string().unwrap_or_default();
            Ok((code, body_text, resp_headers))
        }
        Err(e) => Err(e.to_string()),
    }
}

fn create_response<'s>(
    scope: &mut v8::HandleScope<'s>,
    status: u16,
    body: &str,
    resp_headers: &HashMap<String, String>,
) -> v8::Local<'s, v8::Object> {
    let response = v8::Object::new(scope);

    let status_key = v8::String::new(scope, "status").unwrap();
    let status_val = v8::Integer::new(scope, status as i32);
    response.set(scope, status_key.into(), status_val.into());

    let ok_key = v8::String::new(scope, "ok").unwrap();
    let ok_val = v8::Boolean::new(scope, (200..300).contains(&status));
    response.set(scope, ok_key.into(), ok_val.into());

    let headers_obj = v8::Object::new(scope);
    for (k, v) in resp_headers {
        let key = v8::String::new(scope, k).unwrap();
        let val = v8::String::new(scope, v).unwrap();
        headers_obj.set(scope, key.into(), val.into());
    }
    let headers_key = v8::String::new(scope, "headers").unwrap();
    response.set(scope, headers_key.into(), headers_obj.into());

    let body_str = v8::String::new(scope, body).unwrap();
    let body_key = v8::String::new(scope, "body").unwrap();
    response.set(scope, body_key.into(), body_str.into());

    let text_fn = v8::Function::new(scope, response_text).unwrap();
    let text_key = v8::String::new(scope, "text").unwrap();
    response.set(scope, text_key.into(), text_fn.into());

    let json_fn = v8::Function::new(scope, response_json).unwrap();
    let json_key = v8::String::new(scope, "json").unwrap();
    response.set(scope, json_key.into(), json_fn.into());

    response
}

fn response_text(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let body_key = v8::String::new(scope, "body").unwrap();
    if let Some(body) = this.get(scope, body_key.into()) {
        rv.set(body);
    }
}

fn response_json(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let body_key = v8::String::new(scope, "body").unwrap();
    if let Some(body) = this.get(scope, body_key.into()) {
        let body_str = body.to_rust_string_lossy(scope);
        let code = v8::String::new(scope, &format!("({})", body_str)).unwrap();
        let tc = &mut v8::TryCatch::new(scope);
        if let Some(script) = v8::Script::compile(tc, code, None) {
            if let Some(result) = script.run(tc) {
                rv.set(result);
                return;
            }
        }
        let msg = v8::String::new(tc, "invalid JSON").unwrap();
        let exception = v8::Exception::error(tc, msg);
        tc.throw_exception(exception);
    }
}

fn throw_error(scope: &mut v8::HandleScope, message: &str) {
    let msg = v8::String::new(scope, message).unwrap();
    let exception = v8::Exception::error(scope, msg);
    scope.throw_exception(exception);
}

/// Extract host (with optional port) from a URL for permission checking
fn extract_host(url: &str) -> String {
    // Simple URL parsing - handle http://, https://, etc.
    let url = url.trim();
    let without_scheme = if let Some(pos) = url.find("://") {
        &url[pos + 3..]
    } else {
        url
    };

    // Get the host part (before path)
    let host_part = if let Some(pos) = without_scheme.find('/') {
        &without_scheme[..pos]
    } else {
        without_scheme
    };

    // Remove user:pass@ if present
    let host_port = if let Some(pos) = host_part.find('@') {
        &host_part[pos + 1..]
    } else {
        host_part
    };

    host_port.to_string()
}

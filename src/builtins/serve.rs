use crate::permissions;
use rusty_v8 as v8;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use tiny_http::{Header, Response as HttpResponse, Server as HttpServer};

thread_local! {
    static SERVERS: RefCell<HashMap<u32, ServerState>> = RefCell::new(HashMap::new());
    static NEXT_SERVER_ID: RefCell<u32> = RefCell::new(0);
    /// Pending async handler promises with their response channels
    static PENDING_RESPONSES: RefCell<Vec<PendingAsyncResponse>> = RefCell::new(Vec::new());
}

struct ServerState {
    shutdown_tx: Sender<()>,
    request_rx: Receiver<PendingRequest>,
    handler: v8::Global<v8::Function>,
    on_error: Option<v8::Global<v8::Function>>,
    #[allow(dead_code)]
    hostname: String,
    #[allow(dead_code)]
    port: u16,
}

struct PendingRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
    response_tx: Sender<ResponseData>,
    /// Full base URL (e.g., "http://127.0.0.1:3000")
    base_url: String,
}

struct PendingAsyncResponse {
    promise: v8::Global<v8::Promise>,
    response_tx: Sender<ResponseData>,
    server_id: u32,
}

struct ResponseData {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
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

    // Velox.serve(options): Server
    let serve_func = v8::Function::new(scope, serve_callback).unwrap();
    let serve_key = v8::String::new(scope, "serve").unwrap();
    velox.set(scope, serve_key.into(), serve_func.into());
}

fn serve_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let opts_arg = args.get(0);
    if !opts_arg.is_object() {
        let err = v8::String::new(scope, "Velox.serve requires an options object").unwrap();
        scope.throw_exception(err.into());
        return;
    }

    let opts = v8::Local::<v8::Object>::try_from(opts_arg).unwrap();

    // Get port (default 8000)
    let port_key = v8::String::new(scope, "port").unwrap();
    let port: u16 = opts
        .get(scope, port_key.into())
        .and_then(|v| v.uint32_value(scope))
        .map(|v| v as u16)
        .unwrap_or(8000);

    // Get hostname (default "127.0.0.1")
    let hostname_key = v8::String::new(scope, "hostname").unwrap();
    let hostname = opts
        .get(scope, hostname_key.into())
        .filter(|v| v.is_string())
        .map(|v| v.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "127.0.0.1".to_string());

    // Get handler function (required)
    let handler_key = v8::String::new(scope, "handler").unwrap();
    let handler_val = opts.get(scope, handler_key.into());
    if handler_val.is_none() || !handler_val.unwrap().is_function() {
        let err = v8::String::new(scope, "Velox.serve requires a handler function").unwrap();
        scope.throw_exception(err.into());
        return;
    }
    let handler = v8::Local::<v8::Function>::try_from(handler_val.unwrap()).unwrap();
    let handler_global = v8::Global::new(scope, handler);

    // Get onListen callback (optional)
    let on_listen_key = v8::String::new(scope, "onListen").unwrap();
    let on_listen = opts
        .get(scope, on_listen_key.into())
        .filter(|v| v.is_function())
        .map(|v| v8::Global::new(scope, v8::Local::<v8::Function>::try_from(v).unwrap()));

    // Get onError callback (optional)
    let on_error_key = v8::String::new(scope, "onError").unwrap();
    let on_error = opts
        .get(scope, on_error_key.into())
        .filter(|v| v.is_function())
        .map(|v| v8::Global::new(scope, v8::Local::<v8::Function>::try_from(v).unwrap()));

    // Check network permission
    let addr = format!("{}:{}", hostname, port);
    if let Err(e) = permissions::check_net(&addr) {
        let err = v8::String::new(scope, &e).unwrap();
        scope.throw_exception(err.into());
        return;
    }

    // Create the HTTP server
    let server = match HttpServer::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            let err = v8::String::new(scope, &format!("Failed to start server: {}", e)).unwrap();
            scope.throw_exception(err.into());
            return;
        }
    };

    // Channel for shutdown signal
    let (shutdown_tx, shutdown_rx) = channel::<()>();

    // Channel for sending requests from server thread to main thread
    let (request_tx, request_rx) = channel::<PendingRequest>();

    // Allocate server ID
    let server_id = NEXT_SERVER_ID.with(|id| {
        let mut id = id.borrow_mut();
        let current = *id;
        *id += 1;
        current
    });

    // Spawn the server thread
    let server_arc = Arc::new(Mutex::new(Some(server)));
    let server_for_thread = server_arc.clone();
    let base_url = format!("http://{}:{}", hostname, port);

    thread::spawn(move || {
        let server_guard = server_for_thread.lock().unwrap();
        let server = match server_guard.as_ref() {
            Some(s) => s,
            None => return,
        };

        loop {
            // Check for shutdown signal
            if shutdown_rx.try_recv().is_ok() {
                break;
            }

            // Try to receive a request with timeout
            match server.recv_timeout(std::time::Duration::from_millis(100)) {
                Ok(Some(mut request)) => {
                    // Extract request data
                    let method = request.method().to_string();
                    let url = request.url().to_string();
                    let headers: Vec<(String, String)> = request
                        .headers()
                        .iter()
                        .map(|h| (h.field.to_string(), h.value.to_string()))
                        .collect();

                    let mut body = Vec::new();
                    let _ = request.as_reader().read_to_end(&mut body);

                    // Create response channel for this request
                    let (response_tx, response_rx) = channel::<ResponseData>();

                    let pending = PendingRequest {
                        method,
                        url,
                        headers,
                        body,
                        response_tx,
                        base_url: base_url.clone(),
                    };

                    // Send request to main thread
                    if request_tx.send(pending).is_err() {
                        // Main thread has dropped the receiver, exit
                        break;
                    }

                    // Wait for response from main thread
                    match response_rx.recv_timeout(std::time::Duration::from_secs(30)) {
                        Ok(resp_data) => {
                            let mut response = HttpResponse::from_data(resp_data.body)
                                .with_status_code(resp_data.status);

                            for (name, value) in resp_data.headers {
                                if let Ok(header) =
                                    Header::from_bytes(name.as_bytes(), value.as_bytes())
                                {
                                    response = response.with_header(header);
                                }
                            }

                            let _ = request.respond(response);
                        }
                        Err(_) => {
                            // Timeout - send 500 error
                            let _ = request.respond(
                                HttpResponse::from_string("Internal Server Error")
                                    .with_status_code(500),
                            );
                        }
                    }
                }
                Ok(None) => {}
                Err(_) => {}
            }
        }
    });

    // Store server state for polling
    SERVERS.with(|servers| {
        servers.borrow_mut().insert(
            server_id,
            ServerState {
                shutdown_tx,
                request_rx,
                handler: handler_global,
                on_error,
                hostname: hostname.clone(),
                port,
            },
        );
    });

    // Call onListen callback if provided
    if let Some(on_listen_global) = on_listen {
        let on_listen_fn = v8::Local::new(scope, on_listen_global);
        let addr_obj = v8::Object::new(scope);

        let port_key = v8::String::new(scope, "port").unwrap();
        let port_val = v8::Integer::new(scope, port as i32);
        addr_obj.set(scope, port_key.into(), port_val.into());

        let hostname_key = v8::String::new(scope, "hostname").unwrap();
        let hostname_val = v8::String::new(scope, &hostname).unwrap();
        addr_obj.set(scope, hostname_key.into(), hostname_val.into());

        let undefined = v8::undefined(scope);
        on_listen_fn.call(scope, undefined.into(), &[addr_obj.into()]);
    }

    // Create and return Server object
    let server_obj = v8::Object::new(scope);

    // server.addr
    let addr_obj = v8::Object::new(scope);
    let port_key = v8::String::new(scope, "port").unwrap();
    let port_val = v8::Integer::new(scope, port as i32);
    addr_obj.set(scope, port_key.into(), port_val.into());

    let hostname_key = v8::String::new(scope, "hostname").unwrap();
    let hostname_val = v8::String::new(scope, &hostname).unwrap();
    addr_obj.set(scope, hostname_key.into(), hostname_val.into());

    let addr_key = v8::String::new(scope, "addr").unwrap();
    server_obj.set(scope, addr_key.into(), addr_obj.into());

    // Store server_id on the object
    let id_key = v8::String::new(scope, "_serverId").unwrap();
    let id_val = v8::Integer::new_from_unsigned(scope, server_id);
    server_obj.set(scope, id_key.into(), id_val.into());

    // server.shutdown()
    let shutdown_fn = v8::Function::new(scope, server_shutdown).unwrap();
    let shutdown_key = v8::String::new(scope, "shutdown").unwrap();
    server_obj.set(scope, shutdown_key.into(), shutdown_fn.into());

    rv.set(server_obj.into());
}

fn server_shutdown(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let id_key = v8::String::new(scope, "_serverId").unwrap();

    if let Some(id_val) = this.get(scope, id_key.into()) {
        if let Some(server_id) = id_val.uint32_value(scope) {
            SERVERS.with(|servers| {
                if let Some(state) = servers.borrow_mut().remove(&server_id) {
                    let _ = state.shutdown_tx.send(());
                }
            });
        }
    }

    // Return a resolved promise
    let resolver = v8::PromiseResolver::new(scope).unwrap();
    let promise = resolver.get_promise(scope);
    let undefined = v8::undefined(scope);
    resolver.resolve(scope, undefined.into());
    rv.set(promise.into());
}

/// Poll all active servers for incoming requests and process them.
/// This should be called from the event loop.
pub fn poll_servers(scope: &mut v8::HandleScope) -> bool {
    let mut has_active_servers = false;

    // First, check pending async responses
    poll_pending_responses(scope);

    SERVERS.with(|servers| {
        let servers_ref = servers.borrow();
        let server_ids: Vec<u32> = servers_ref.keys().copied().collect();
        drop(servers_ref);

        for server_id in server_ids {
            has_active_servers = true;

            // Try to receive a pending request
            let pending = SERVERS.with(|servers| {
                let servers_ref = servers.borrow();
                if let Some(state) = servers_ref.get(&server_id) {
                    state.request_rx.try_recv().ok()
                } else {
                    None
                }
            });

            if let Some(req) = pending {
                // Get handler function
                let handler_opt = SERVERS.with(|servers| {
                    let servers_ref = servers.borrow();
                    servers_ref
                        .get(&server_id)
                        .map(|s| v8::Local::new(scope, s.handler.clone()))
                });

                if let Some(handler) = handler_opt {
                    // Create Request object
                    let request_obj = create_request_object(scope, &req);

                    // Call handler
                    let undefined = v8::undefined(scope);
                    let result = handler.call(scope, undefined.into(), &[request_obj.into()]);

                    // Handle result (Response or Promise<Response>)
                    if let Some(result) = result {
                        if result.is_promise() {
                            let promise = v8::Local::<v8::Promise>::try_from(result).unwrap();
                            handle_promise_response(scope, promise, req.response_tx, server_id);
                        } else {
                            // Synchronous Response
                            let resp_data = extract_response_data(scope, result);
                            let _ = req.response_tx.send(resp_data);
                        }
                    } else {
                        // Handler threw an exception - try onError callback
                        let error_response = call_on_error_callback(scope, server_id, None);
                        let _ = req.response_tx.send(error_response);
                    }
                }
            }
        }
    });

    // Check if there are pending async responses
    let has_pending = PENDING_RESPONSES.with(|pending| !pending.borrow().is_empty());

    has_active_servers || has_pending
}

/// Call the onError callback if available, otherwise return default 500 response
fn call_on_error_callback(
    scope: &mut v8::HandleScope,
    server_id: u32,
    error: Option<v8::Local<v8::Value>>,
) -> ResponseData {
    // Get onError callback
    let on_error_opt = SERVERS.with(|servers| {
        let servers_ref = servers.borrow();
        servers_ref.get(&server_id).and_then(|s| {
            s.on_error
                .as_ref()
                .map(|f| v8::Local::new(scope, f.clone()))
        })
    });

    if let Some(on_error_fn) = on_error_opt {
        // Create error object if not provided
        let error_val = error.unwrap_or_else(|| {
            let err_obj = v8::Object::new(scope);
            let msg_key = v8::String::new(scope, "message").unwrap();
            let msg_val = v8::String::new(scope, "Handler threw an exception").unwrap();
            err_obj.set(scope, msg_key.into(), msg_val.into());
            err_obj.into()
        });

        // Call onError
        let undefined = v8::undefined(scope);
        if let Some(result) = on_error_fn.call(scope, undefined.into(), &[error_val]) {
            // If onError returns a Response, use it
            if result.is_object() && !result.is_null_or_undefined() {
                return extract_response_data(scope, result);
            }
        }
    }

    // Default error response
    let error_msg = error
        .map(|e| e.to_rust_string_lossy(scope))
        .unwrap_or_else(|| "Internal Server Error".to_string());

    ResponseData {
        status: 500,
        headers: vec![("content-type".to_string(), "text/plain".to_string())],
        body: format!("Error: {}", error_msg).into_bytes(),
    }
}

/// Handle a promise response from an async handler
fn handle_promise_response(
    scope: &mut v8::HandleScope,
    promise: v8::Local<v8::Promise>,
    response_tx: Sender<ResponseData>,
    server_id: u32,
) {
    match promise.state() {
        v8::PromiseState::Fulfilled => {
            let response_val = promise.result(scope);
            let resp_data = extract_response_data(scope, response_val);
            let _ = response_tx.send(resp_data);
        }
        v8::PromiseState::Rejected => {
            let error_val = promise.result(scope);
            let resp_data = call_on_error_callback(scope, server_id, Some(error_val));
            let _ = response_tx.send(resp_data);
        }
        v8::PromiseState::Pending => {
            // Store for later polling
            let promise_global = v8::Global::new(scope, promise);
            PENDING_RESPONSES.with(|pending| {
                pending.borrow_mut().push(PendingAsyncResponse {
                    promise: promise_global,
                    response_tx,
                    server_id,
                });
            });
        }
    }
}

/// Poll pending async responses and send them when resolved
fn poll_pending_responses(scope: &mut v8::HandleScope) {
    // Collect resolved/rejected promises first to avoid borrow issues
    let mut completed: Vec<(usize, v8::PromiseState, Option<v8::Global<v8::Value>>)> = Vec::new();

    PENDING_RESPONSES.with(|pending| {
        let pending_ref = pending.borrow();
        for (i, pending_resp) in pending_ref.iter().enumerate() {
            let promise_local = v8::Local::new(scope, &pending_resp.promise);
            let state = promise_local.state();
            match state {
                v8::PromiseState::Fulfilled | v8::PromiseState::Rejected => {
                    let result = promise_local.result(scope);
                    let result_global = v8::Global::new(scope, result);
                    completed.push((i, state, Some(result_global)));
                }
                v8::PromiseState::Pending => {}
            }
        }
    });

    // Process completed promises in reverse order to maintain correct indices when removing
    completed.sort_by(|a, b| b.0.cmp(&a.0));

    for (idx, state, result_global) in completed {
        let (response_tx, server_id) = PENDING_RESPONSES.with(|pending| {
            let mut pending_ref = pending.borrow_mut();
            let item = pending_ref.swap_remove(idx);
            (item.response_tx, item.server_id)
        });

        let result_local = result_global.map(|g| v8::Local::new(scope, g));

        let resp_data = match state {
            v8::PromiseState::Fulfilled => extract_response_data(scope, result_local.unwrap()),
            v8::PromiseState::Rejected => call_on_error_callback(scope, server_id, result_local),
            v8::PromiseState::Pending => unreachable!(),
        };

        let _ = response_tx.send(resp_data);
    }
}

/// Check if there are any active servers
pub fn has_active_servers() -> bool {
    SERVERS.with(|servers| !servers.borrow().is_empty())
}

/// Shutdown all active servers gracefully (called on SIGINT/SIGTERM)
pub fn shutdown_all_servers() {
    SERVERS.with(|servers| {
        let mut servers_ref = servers.borrow_mut();
        for (_id, state) in servers_ref.drain() {
            // Send shutdown signal to each server thread
            let _ = state.shutdown_tx.send(());
        }
    });

    // Clear pending async responses
    PENDING_RESPONSES.with(|pending| {
        pending.borrow_mut().clear();
    });
}

fn create_request_object<'s>(
    scope: &mut v8::HandleScope<'s>,
    req: &PendingRequest,
) -> v8::Local<'s, v8::Object> {
    let global = scope.get_current_context().global(scope);

    // Construct full URL from base_url and request path
    let full_url = format!("{}{}", req.base_url, req.url);

    // Try to use the Request constructor if available
    let request_key = v8::String::new(scope, "Request").unwrap();
    if let Some(request_ctor) = global.get(scope, request_key.into()) {
        if let Ok(request_func) = v8::Local::<v8::Function>::try_from(request_ctor) {
            // Create URL string (full URL for proper parsing)
            let url_val = v8::String::new(scope, &full_url).unwrap();

            // Create options object
            let opts = v8::Object::new(scope);

            // Set method
            let method_key = v8::String::new(scope, "method").unwrap();
            let method_val = v8::String::new(scope, &req.method).unwrap();
            opts.set(scope, method_key.into(), method_val.into());

            // Set headers
            let headers_obj = v8::Object::new(scope);
            for (name, value) in &req.headers {
                let header_key = v8::String::new(scope, &name.to_lowercase()).unwrap();
                let header_val = v8::String::new(scope, value).unwrap();
                headers_obj.set(scope, header_key.into(), header_val.into());
            }
            let headers_key = v8::String::new(scope, "headers").unwrap();
            opts.set(scope, headers_key.into(), headers_obj.into());

            // Set body (if present)
            if !req.body.is_empty() {
                let array_buffer = v8::ArrayBuffer::new(scope, req.body.len());
                let backing_store = array_buffer.get_backing_store();
                let data_ptr = backing_store.data();
                if !data_ptr.is_null() {
                    unsafe {
                        let ptr = data_ptr as *mut u8;
                        for (i, byte) in req.body.iter().enumerate() {
                            *ptr.add(i) = *byte;
                        }
                    }
                }
                let uint8_array =
                    v8::Uint8Array::new(scope, array_buffer, 0, req.body.len()).unwrap();
                let body_key = v8::String::new(scope, "body").unwrap();
                opts.set(scope, body_key.into(), uint8_array.into());
            }

            // Create Request instance
            if let Some(request_obj) =
                request_func.new_instance(scope, &[url_val.into(), opts.into()])
            {
                return request_obj;
            }
        }
    }

    // Fallback: create a plain object (for backwards compatibility)
    create_request_object_fallback(scope, req)
}

fn create_request_object_fallback<'s>(
    scope: &mut v8::HandleScope<'s>,
    req: &PendingRequest,
) -> v8::Local<'s, v8::Object> {
    let request_obj = v8::Object::new(scope);

    // Construct full URL from base_url and request path
    let full_url = format!("{}{}", req.base_url, req.url);

    // request.method
    let method_key = v8::String::new(scope, "method").unwrap();
    let method_val = v8::String::new(scope, &req.method).unwrap();
    request_obj.set(scope, method_key.into(), method_val.into());

    // request.url (full URL)
    let url_key = v8::String::new(scope, "url").unwrap();
    let url_val = v8::String::new(scope, &full_url).unwrap();
    request_obj.set(scope, url_key.into(), url_val.into());

    // request.headers (as object)
    let headers_obj = v8::Object::new(scope);
    for (name, value) in &req.headers {
        let header_key = v8::String::new(scope, &name.to_lowercase()).unwrap();
        let header_val = v8::String::new(scope, value).unwrap();
        headers_obj.set(scope, header_key.into(), header_val.into());
    }
    let headers_key = v8::String::new(scope, "headers").unwrap();
    request_obj.set(scope, headers_key.into(), headers_obj.into());

    // request.body (as Uint8Array)
    if !req.body.is_empty() {
        let array_buffer = v8::ArrayBuffer::new(scope, req.body.len());
        let backing_store = array_buffer.get_backing_store();
        let data_ptr = backing_store.data();
        if !data_ptr.is_null() {
            unsafe {
                let ptr = data_ptr as *mut u8;
                for (i, byte) in req.body.iter().enumerate() {
                    *ptr.add(i) = *byte;
                }
            }
        }
        let uint8_array = v8::Uint8Array::new(scope, array_buffer, 0, req.body.len()).unwrap();
        let body_key = v8::String::new(scope, "body").unwrap();
        request_obj.set(scope, body_key.into(), uint8_array.into());
    } else {
        let body_key = v8::String::new(scope, "body").unwrap();
        let null_val = v8::null(scope);
        request_obj.set(scope, body_key.into(), null_val.into());
    }

    request_obj
}

fn extract_response_data(
    scope: &mut v8::HandleScope,
    response: v8::Local<v8::Value>,
) -> ResponseData {
    if !response.is_object() {
        return ResponseData {
            status: 200,
            headers: vec![("content-type".to_string(), "text/plain".to_string())],
            body: response.to_rust_string_lossy(scope).into_bytes(),
        };
    }

    let response_obj = v8::Local::<v8::Object>::try_from(response).unwrap();

    // Get status (default 200)
    let status_key = v8::String::new(scope, "status").unwrap();
    let status = response_obj
        .get(scope, status_key.into())
        .and_then(|v| v.uint32_value(scope))
        .map(|v| v as u16)
        .unwrap_or(200);

    // Get headers - handle both Headers class (with _data) and plain objects
    let mut headers = Vec::new();
    let headers_key = v8::String::new(scope, "headers").unwrap();
    if let Some(headers_val) = response_obj.get(scope, headers_key.into()) {
        if headers_val.is_object() && !headers_val.is_null_or_undefined() {
            let headers_obj = v8::Local::<v8::Object>::try_from(headers_val).unwrap();

            // Check if this is a Headers class instance (has _data property)
            let data_key = v8::String::new(scope, "_data").unwrap();
            let headers_data = if let Some(data_val) = headers_obj.get(scope, data_key.into()) {
                if data_val.is_object() && !data_val.is_null_or_undefined() {
                    v8::Local::<v8::Object>::try_from(data_val).ok()
                } else {
                    None
                }
            } else {
                None
            };

            // Use _data if present, otherwise use the headers object directly
            let obj_to_iterate = headers_data.unwrap_or(headers_obj);

            if let Some(names) = obj_to_iterate.get_own_property_names(scope) {
                let len = names.length();
                for i in 0..len {
                    if let Some(key) = names.get_index(scope, i) {
                        let key_str = key.to_rust_string_lossy(scope);
                        // Skip internal properties
                        if key_str.starts_with('_') {
                            continue;
                        }
                        if let Some(val) = obj_to_iterate.get(scope, key) {
                            let val_str = val.to_rust_string_lossy(scope);
                            headers.push((key_str, val_str));
                        }
                    }
                }
            }
        }
    }

    // Get body - check both _body (Response class) and body (plain object)
    let body_key_internal = v8::String::new(scope, "_body").unwrap();
    let body_key = v8::String::new(scope, "body").unwrap();

    // Try _body first (Response class), then fall back to body (plain object)
    let body_val_opt = response_obj
        .get(scope, body_key_internal.into())
        .filter(|v| !v.is_undefined())
        .or_else(|| response_obj.get(scope, body_key.into()));

    let body = if let Some(body_val) = body_val_opt {
        if body_val.is_string() {
            body_val.to_rust_string_lossy(scope).into_bytes()
        } else if body_val.is_uint8_array() {
            let uint8_array = v8::Local::<v8::Uint8Array>::try_from(body_val).unwrap();
            let len = uint8_array.byte_length();
            let mut bytes = vec![0u8; len];
            uint8_array.copy_contents(&mut bytes);
            bytes
        } else if body_val.is_array_buffer() {
            let array_buffer = v8::Local::<v8::ArrayBuffer>::try_from(body_val).unwrap();
            let backing_store = array_buffer.get_backing_store();
            let len = backing_store.byte_length();
            let mut bytes = vec![0u8; len];
            let data_ptr = backing_store.data();
            if !data_ptr.is_null() {
                unsafe {
                    std::ptr::copy_nonoverlapping(data_ptr as *const u8, bytes.as_mut_ptr(), len);
                }
            }
            bytes
        } else if !body_val.is_null_or_undefined() {
            body_val.to_rust_string_lossy(scope).into_bytes()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    ResponseData {
        status,
        headers,
        body,
    }
}

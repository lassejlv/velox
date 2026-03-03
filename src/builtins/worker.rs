//! Worker threads implementation for Velox
//!
//! Provides Web Worker-like API for running JavaScript in parallel threads.
//! Each worker has its own V8 isolate and communicates via message passing.

use crate::builtins;
use crate::event_loop::EventLoop;
use crate::shutdown;
use crate::transpiler;
use rusty_v8 as v8;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
use std::thread::{self, JoinHandle};

/// Messages sent from main thread to worker
#[derive(Debug)]
pub enum MainToWorker {
    /// Post a message to the worker
    Message(String),
    /// Terminate the worker
    Terminate,
}

/// Messages sent from worker to main thread
#[derive(Debug)]
pub enum WorkerToMain {
    /// Worker posted a message
    Message(String),
    /// Worker encountered an error
    Error(String),
    /// Worker has finished executing
    Done,
}

thread_local! {
    /// Active workers in the main thread
    static WORKERS: RefCell<HashMap<u32, WorkerHandle>> = RefCell::new(HashMap::new());
    static NEXT_WORKER_ID: RefCell<u32> = RefCell::new(0);

    /// For workers: channel to send messages back to main
    static WORKER_TX: RefCell<Option<Sender<WorkerToMain>>> = RefCell::new(None);

    /// For workers: channel to receive messages from main
    static WORKER_RX: RefCell<Option<Receiver<MainToWorker>>> = RefCell::new(None);
}

struct WorkerHandle {
    tx: Sender<MainToWorker>,
    rx: Receiver<WorkerToMain>,
    #[allow(dead_code)]
    thread: JoinHandle<()>,
    on_message: Option<v8::Global<v8::Function>>,
    on_error: Option<v8::Global<v8::Function>>,
}

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    // Create Worker constructor
    let worker_template = v8::FunctionTemplate::new(scope, worker_constructor);
    let worker_func = worker_template.get_function(scope).unwrap();

    let worker_key = v8::String::new(scope, "Worker").unwrap();
    global.set(scope, worker_key.into(), worker_func.into());

    // Check if we're in a worker context and set up self.postMessage/onmessage
    WORKER_TX.with(|tx| {
        if tx.borrow().is_some() {
            setup_worker_globals(scope, global);
        }
    });
}

fn setup_worker_globals(
    scope: &mut v8::ContextScope<v8::HandleScope>,
    global: v8::Local<v8::Object>,
) {
    // self.postMessage
    let post_message_fn = v8::Function::new(scope, worker_post_message).unwrap();
    let post_key = v8::String::new(scope, "postMessage").unwrap();
    global.set(scope, post_key.into(), post_message_fn.into());

    // self reference
    let self_key = v8::String::new(scope, "self").unwrap();
    global.set(scope, self_key.into(), global.into());
}

fn worker_constructor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    // Get the script URL/path
    let url_arg = args.get(0);
    if !url_arg.is_string() {
        let err = v8::String::new(scope, "Worker requires a script URL").unwrap();
        scope.throw_exception(err.into());
        return;
    }

    let script_url = url_arg.to_rust_string_lossy(scope);

    // Resolve the script path
    let script_path = if script_url.starts_with("./") || script_url.starts_with("../") {
        // Relative path - resolve from current working directory
        let cwd = std::env::current_dir().unwrap_or_default();
        cwd.join(&script_url).to_string_lossy().to_string()
    } else if script_url.starts_with('/') {
        // Absolute path
        script_url.clone()
    } else if script_url.starts_with("file://") {
        // File URL
        script_url
            .strip_prefix("file://")
            .unwrap_or(&script_url)
            .to_string()
    } else {
        // Treat as relative path
        let cwd = std::env::current_dir().unwrap_or_default();
        cwd.join(&script_url).to_string_lossy().to_string()
    };

    // Read the worker script
    let source = match std::fs::read_to_string(&script_path) {
        Ok(s) => s,
        Err(e) => {
            let err =
                v8::String::new(scope, &format!("Failed to load worker script: {}", e)).unwrap();
            scope.throw_exception(err.into());
            return;
        }
    };

    // Transpile if TypeScript
    let js_source = if transpiler::is_typescript(&script_path) {
        match transpiler::transpile_typescript(&source, &script_path) {
            Ok(code) => code,
            Err(e) => {
                let err =
                    v8::String::new(scope, &format!("Failed to transpile worker: {}", e)).unwrap();
                scope.throw_exception(err.into());
                return;
            }
        }
    } else {
        source.clone()
    };

    // Create channels for communication
    let (main_tx, worker_rx) = channel::<MainToWorker>();
    let (worker_tx, main_rx) = channel::<WorkerToMain>();

    // Clone values needed for the worker thread
    let script_path_clone = script_path.clone();

    // Spawn worker thread
    let thread = thread::spawn(move || {
        run_worker(script_path_clone, js_source, worker_tx, worker_rx);
    });

    // Allocate worker ID
    let worker_id = NEXT_WORKER_ID.with(|id| {
        let mut id = id.borrow_mut();
        let current = *id;
        *id += 1;
        current
    });

    // Store worker handle
    WORKERS.with(|workers| {
        workers.borrow_mut().insert(
            worker_id,
            WorkerHandle {
                tx: main_tx,
                rx: main_rx,
                thread,
                on_message: None,
                on_error: None,
            },
        );
    });

    // Create Worker object
    let worker_obj = v8::Object::new(scope);

    // Store worker ID
    let id_key = v8::String::new(scope, "_workerId").unwrap();
    let id_val = v8::Integer::new_from_unsigned(scope, worker_id);
    worker_obj.set(scope, id_key.into(), id_val.into());

    // worker.postMessage(data)
    let post_fn = v8::Function::new(scope, worker_obj_post_message).unwrap();
    let post_key = v8::String::new(scope, "postMessage").unwrap();
    worker_obj.set(scope, post_key.into(), post_fn.into());

    // worker.terminate()
    let term_fn = v8::Function::new(scope, worker_terminate).unwrap();
    let term_key = v8::String::new(scope, "terminate").unwrap();
    worker_obj.set(scope, term_key.into(), term_fn.into());

    // Define onmessage setter/getter
    setup_worker_object_handlers(scope, worker_obj, worker_id);

    rv.set(worker_obj.into());
}

fn setup_worker_object_handlers(
    scope: &mut v8::HandleScope,
    worker_obj: v8::Local<v8::Object>,
    worker_id: u32,
) {
    // We'll use defineProperty to create onmessage and onerror with setters
    let global = scope.get_current_context().global(scope);
    let object_key = v8::String::new(scope, "Object").unwrap();

    if let Some(object_ctor) = global.get(scope, object_key.into()) {
        if let Ok(object_obj) = v8::Local::<v8::Object>::try_from(object_ctor) {
            let define_key = v8::String::new(scope, "defineProperty").unwrap();
            if let Some(define_prop) = object_obj.get(scope, define_key.into()) {
                if let Ok(define_fn) = v8::Local::<v8::Function>::try_from(define_prop) {
                    // Define onmessage property
                    let onmessage_key = v8::String::new(scope, "onmessage").unwrap();
                    let onmessage_desc = v8::Object::new(scope);

                    let set_fn = v8::Function::builder(worker_set_onmessage)
                        .data(v8::Integer::new_from_unsigned(scope, worker_id).into())
                        .build(scope)
                        .unwrap();
                    let get_fn = v8::Function::builder(worker_get_onmessage)
                        .data(v8::Integer::new_from_unsigned(scope, worker_id).into())
                        .build(scope)
                        .unwrap();

                    let set_key = v8::String::new(scope, "set").unwrap();
                    let get_key = v8::String::new(scope, "get").unwrap();
                    onmessage_desc.set(scope, set_key.into(), set_fn.into());
                    onmessage_desc.set(scope, get_key.into(), get_fn.into());

                    define_fn.call(
                        scope,
                        object_ctor,
                        &[
                            worker_obj.into(),
                            onmessage_key.into(),
                            onmessage_desc.into(),
                        ],
                    );

                    // Define onerror property
                    let onerror_key = v8::String::new(scope, "onerror").unwrap();
                    let onerror_desc = v8::Object::new(scope);

                    let set_fn = v8::Function::builder(worker_set_onerror)
                        .data(v8::Integer::new_from_unsigned(scope, worker_id).into())
                        .build(scope)
                        .unwrap();
                    let get_fn = v8::Function::builder(worker_get_onerror)
                        .data(v8::Integer::new_from_unsigned(scope, worker_id).into())
                        .build(scope)
                        .unwrap();

                    let set_key = v8::String::new(scope, "set").unwrap();
                    let get_key = v8::String::new(scope, "get").unwrap();
                    onerror_desc.set(scope, set_key.into(), set_fn.into());
                    onerror_desc.set(scope, get_key.into(), get_fn.into());

                    define_fn.call(
                        scope,
                        object_ctor,
                        &[worker_obj.into(), onerror_key.into(), onerror_desc.into()],
                    );
                }
            }
        }
    }
}

fn worker_set_onmessage(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let worker_id = args.data().and_then(|d| d.uint32_value(scope)).unwrap_or(0);
    let value = args.get(0);

    WORKERS.with(|workers| {
        if let Some(worker) = workers.borrow_mut().get_mut(&worker_id) {
            if value.is_function() {
                let func = v8::Local::<v8::Function>::try_from(value).unwrap();
                worker.on_message = Some(v8::Global::new(scope, func));
            } else {
                worker.on_message = None;
            }
        }
    });
}

fn worker_get_onmessage(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let worker_id = args.data().and_then(|d| d.uint32_value(scope)).unwrap_or(0);

    let result = WORKERS.with(|workers| {
        workers
            .borrow()
            .get(&worker_id)
            .and_then(|w| w.on_message.as_ref().map(|f| v8::Local::new(scope, f)))
    });

    if let Some(func) = result {
        rv.set(func.into());
    } else {
        rv.set(v8::null(scope).into());
    }
}

fn worker_set_onerror(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let worker_id = args.data().and_then(|d| d.uint32_value(scope)).unwrap_or(0);
    let value = args.get(0);

    WORKERS.with(|workers| {
        if let Some(worker) = workers.borrow_mut().get_mut(&worker_id) {
            if value.is_function() {
                let func = v8::Local::<v8::Function>::try_from(value).unwrap();
                worker.on_error = Some(v8::Global::new(scope, func));
            } else {
                worker.on_error = None;
            }
        }
    });
}

fn worker_get_onerror(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let worker_id = args.data().and_then(|d| d.uint32_value(scope)).unwrap_or(0);

    let result = WORKERS.with(|workers| {
        workers
            .borrow()
            .get(&worker_id)
            .and_then(|w| w.on_error.as_ref().map(|f| v8::Local::new(scope, f)))
    });

    if let Some(func) = result {
        rv.set(func.into());
    } else {
        rv.set(v8::null(scope).into());
    }
}

fn worker_obj_post_message(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let this = args.this();
    let id_key = v8::String::new(scope, "_workerId").unwrap();

    let worker_id = match this.get(scope, id_key.into()) {
        Some(v) => v.uint32_value(scope).unwrap_or(0),
        None => return,
    };

    // Serialize the message using JSON
    let data = args.get(0);
    let message = json_stringify(scope, data);

    WORKERS.with(|workers| {
        if let Some(worker) = workers.borrow().get(&worker_id) {
            let _ = worker.tx.send(MainToWorker::Message(message));
        }
    });
}

fn worker_terminate(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let this = args.this();
    let id_key = v8::String::new(scope, "_workerId").unwrap();

    let worker_id = match this.get(scope, id_key.into()) {
        Some(v) => v.uint32_value(scope).unwrap_or(0),
        None => return,
    };

    WORKERS.with(|workers| {
        if let Some(worker) = workers.borrow_mut().remove(&worker_id) {
            let _ = worker.tx.send(MainToWorker::Terminate);
        }
    });
}

fn worker_post_message(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    // This is called from within a worker to post message back to main
    let data = args.get(0);
    let message = json_stringify(scope, data);

    WORKER_TX.with(|tx| {
        if let Some(sender) = tx.borrow().as_ref() {
            let _ = sender.send(WorkerToMain::Message(message));
        }
    });
}

fn json_stringify(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> String {
    let global = scope.get_current_context().global(scope);
    let json_key = v8::String::new(scope, "JSON").unwrap();

    if let Some(json) = global.get(scope, json_key.into()) {
        if let Some(json_obj) = json.to_object(scope) {
            let stringify_key = v8::String::new(scope, "stringify").unwrap();
            if let Some(stringify) = json_obj.get(scope, stringify_key.into()) {
                if let Ok(func) = v8::Local::<v8::Function>::try_from(stringify) {
                    if let Some(result) = func.call(scope, json, &[value]) {
                        if !result.is_undefined() {
                            return result.to_rust_string_lossy(scope);
                        }
                    }
                }
            }
        }
    }

    // Fallback
    value.to_rust_string_lossy(scope)
}

fn json_parse<'s>(scope: &mut v8::HandleScope<'s>, json: &str) -> v8::Local<'s, v8::Value> {
    let global = scope.get_current_context().global(scope);
    let json_key = v8::String::new(scope, "JSON").unwrap();

    if let Some(json_obj) = global.get(scope, json_key.into()) {
        if let Some(json_obj) = json_obj.to_object(scope) {
            let parse_key = v8::String::new(scope, "parse").unwrap();
            if let Some(parse) = json_obj.get(scope, parse_key.into()) {
                if let Ok(func) = v8::Local::<v8::Function>::try_from(parse) {
                    let json_str = v8::String::new(scope, json).unwrap();
                    if let Some(result) = func.call(scope, json_obj.into(), &[json_str.into()]) {
                        return result;
                    }
                }
            }
        }
    }

    v8::undefined(scope).into()
}

/// Run worker in its own thread with its own V8 isolate
fn run_worker(
    script_path: String,
    source: String,
    tx: Sender<WorkerToMain>,
    rx: Receiver<MainToWorker>,
) {
    // V8 should already be initialized by the main thread

    let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
    let handle_scope = &mut v8::HandleScope::new(isolate);
    let context = v8::Context::new(handle_scope);
    let scope = &mut v8::ContextScope::new(handle_scope, context);

    // Set up worker channels in thread-local storage
    WORKER_TX.with(|worker_tx| {
        *worker_tx.borrow_mut() = Some(tx.clone());
    });
    WORKER_RX.with(|worker_rx| {
        *worker_rx.borrow_mut() = Some(rx);
    });

    // Create event loop for this worker
    let event_loop = EventLoop::new();
    builtins::fetch::set_event_loop(event_loop.handle());
    builtins::timers::set_event_loop(event_loop.handle());
    builtins::fs::set_event_loop(event_loop.handle());
    builtins::exec::set_event_loop(event_loop.handle());

    // Set up builtins (including worker-specific globals)
    builtins::setup(scope, context);

    // Set up worker globals (self, postMessage)
    let global = context.global(scope);
    setup_worker_globals(scope, global);

    // Set up onmessage handler registration
    setup_worker_onmessage(scope, global);

    // Execute worker script
    let code = match v8::String::new(scope, &source) {
        Some(c) => c,
        None => {
            let _ = tx.send(WorkerToMain::Error(
                "Failed to create source string".to_string(),
            ));
            return;
        }
    };

    let name = v8::String::new(scope, &script_path).unwrap();
    let origin = v8::ScriptOrigin::new(
        scope,
        name.into(),
        0,
        0,
        false,
        0,
        name.into(),
        false,
        false,
        false,
    );

    let tc_scope = &mut v8::TryCatch::new(scope);

    let script = match v8::Script::compile(tc_scope, code, Some(&origin)) {
        Some(s) => s,
        None => {
            let error = format_worker_exception(tc_scope);
            let _ = tx.send(WorkerToMain::Error(error));
            return;
        }
    };

    match script.run(tc_scope) {
        Some(_) => {}
        None => {
            let error = format_worker_exception(tc_scope);
            let _ = tx.send(WorkerToMain::Error(error));
            return;
        }
    }

    // Run worker event loop (handles messages and timers)
    run_worker_event_loop(tc_scope, &event_loop, &tx);

    let _ = tx.send(WorkerToMain::Done);
}

fn setup_worker_onmessage(
    scope: &mut v8::ContextScope<v8::HandleScope>,
    global: v8::Local<v8::Object>,
) {
    // Create a place to store the onmessage handler
    // We use a wrapper object stored on global._onmessageHandler
    let handler_key = v8::String::new(scope, "_onmessageHandler").unwrap();
    let handler_obj = v8::Object::new(scope);
    global.set(scope, handler_key.into(), handler_obj.into());

    // Define onmessage setter on global/self
    let object_key = v8::String::new(scope, "Object").unwrap();
    let global_obj = scope.get_current_context().global(scope);

    if let Some(object_ctor) = global_obj.get(scope, object_key.into()) {
        if let Ok(object_obj) = v8::Local::<v8::Object>::try_from(object_ctor) {
            let define_key = v8::String::new(scope, "defineProperty").unwrap();
            if let Some(define_prop) = object_obj.get(scope, define_key.into()) {
                if let Ok(define_fn) = v8::Local::<v8::Function>::try_from(define_prop) {
                    let onmessage_key = v8::String::new(scope, "onmessage").unwrap();
                    let desc = v8::Object::new(scope);

                    let set_fn = v8::Function::new(scope, worker_self_set_onmessage).unwrap();
                    let get_fn = v8::Function::new(scope, worker_self_get_onmessage).unwrap();

                    let set_key = v8::String::new(scope, "set").unwrap();
                    let get_key = v8::String::new(scope, "get").unwrap();
                    desc.set(scope, set_key.into(), set_fn.into());
                    desc.set(scope, get_key.into(), get_fn.into());

                    define_fn.call(
                        scope,
                        object_ctor,
                        &[global.into(), onmessage_key.into(), desc.into()],
                    );
                }
            }
        }
    }
}

fn worker_self_set_onmessage(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let global = scope.get_current_context().global(scope);
    let handler_key = v8::String::new(scope, "_onmessageHandler").unwrap();

    if let Some(handler_obj) = global.get(scope, handler_key.into()) {
        if let Ok(obj) = v8::Local::<v8::Object>::try_from(handler_obj) {
            let fn_key = v8::String::new(scope, "fn").unwrap();
            obj.set(scope, fn_key.into(), args.get(0));
        }
    }
}

fn worker_self_get_onmessage(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let global = scope.get_current_context().global(scope);
    let handler_key = v8::String::new(scope, "_onmessageHandler").unwrap();

    if let Some(handler_obj) = global.get(scope, handler_key.into()) {
        if let Ok(obj) = v8::Local::<v8::Object>::try_from(handler_obj) {
            let fn_key = v8::String::new(scope, "fn").unwrap();
            if let Some(func) = obj.get(scope, fn_key.into()) {
                rv.set(func);
                return;
            }
        }
    }

    rv.set(v8::null(scope).into());
}

fn run_worker_event_loop(
    scope: &mut v8::TryCatch<v8::HandleScope>,
    _event_loop: &EventLoop,
    tx: &Sender<WorkerToMain>,
) {
    loop {
        // Check for shutdown
        if shutdown::is_shutdown_requested() {
            break;
        }

        // Check for messages from main thread
        let message = WORKER_RX.with(|rx| rx.borrow().as_ref().and_then(|r| r.try_recv().ok()));

        match message {
            Some(MainToWorker::Message(json)) => {
                // Call onmessage handler
                let global = scope.get_current_context().global(scope);
                let handler_key = v8::String::new(scope, "_onmessageHandler").unwrap();

                if let Some(handler_obj) = global.get(scope, handler_key.into()) {
                    if let Ok(obj) = v8::Local::<v8::Object>::try_from(handler_obj) {
                        let fn_key = v8::String::new(scope, "fn").unwrap();
                        if let Some(func_val) = obj.get(scope, fn_key.into()) {
                            if func_val.is_function() {
                                let func = v8::Local::<v8::Function>::try_from(func_val).unwrap();

                                // Create MessageEvent-like object
                                let event = v8::Object::new(scope);
                                let data = json_parse(scope, &json);
                                let data_key = v8::String::new(scope, "data").unwrap();
                                event.set(scope, data_key.into(), data);

                                let undefined = v8::undefined(scope);
                                if func
                                    .call(scope, undefined.into(), &[event.into()])
                                    .is_none()
                                {
                                    if scope.has_caught() {
                                        let error = format_worker_exception(scope);
                                        let _ = tx.send(WorkerToMain::Error(error));
                                        scope.reset();
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Some(MainToWorker::Terminate) => {
                break;
            }
            None => {}
        }

        // Run one iteration of the event loop
        // We need to manually poll since we're in a custom loop
        // For now, just sleep briefly and continue
        std::thread::sleep(std::time::Duration::from_millis(1));

        // TODO: Integrate with event_loop properly
        // For now workers don't have full async support
    }
}

fn format_worker_exception(tc_scope: &mut v8::TryCatch<v8::HandleScope>) -> String {
    tc_scope
        .exception()
        .and_then(|e| e.to_string(tc_scope))
        .map(|m| m.to_rust_string_lossy(tc_scope))
        .unwrap_or_else(|| "Unknown error".to_string())
}

/// Poll all workers for messages (called from event loop)
pub fn poll_workers(scope: &mut v8::HandleScope) {
    // Collect messages first to avoid borrow issues
    let mut messages: Vec<(u32, WorkerToMain)> = Vec::new();
    let mut finished_workers: Vec<u32> = Vec::new();

    WORKERS.with(|workers| {
        for (id, worker) in workers.borrow().iter() {
            loop {
                match worker.rx.try_recv() {
                    Ok(msg) => {
                        if matches!(msg, WorkerToMain::Done) {
                            finished_workers.push(*id);
                        }
                        messages.push((*id, msg));
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        finished_workers.push(*id);
                        break;
                    }
                }
            }
        }
    });

    // Process messages
    for (worker_id, msg) in messages {
        match msg {
            WorkerToMain::Message(json) => {
                // Call onmessage handler
                let handler = WORKERS.with(|workers| {
                    workers
                        .borrow()
                        .get(&worker_id)
                        .and_then(|w| w.on_message.as_ref().map(|f| v8::Local::new(scope, f)))
                });

                if let Some(func) = handler {
                    let event = v8::Object::new(scope);
                    let data = json_parse(scope, &json);
                    let data_key = v8::String::new(scope, "data").unwrap();
                    event.set(scope, data_key.into(), data);

                    let undefined = v8::undefined(scope);
                    func.call(scope, undefined.into(), &[event.into()]);
                }
            }
            WorkerToMain::Error(error) => {
                // Call onerror handler
                let handler = WORKERS.with(|workers| {
                    workers
                        .borrow()
                        .get(&worker_id)
                        .and_then(|w| w.on_error.as_ref().map(|f| v8::Local::new(scope, f)))
                });

                if let Some(func) = handler {
                    let event = v8::Object::new(scope);
                    let msg_key = v8::String::new(scope, "message").unwrap();
                    let msg_val = v8::String::new(scope, &error).unwrap();
                    event.set(scope, msg_key.into(), msg_val.into());

                    let undefined = v8::undefined(scope);
                    func.call(scope, undefined.into(), &[event.into()]);
                } else {
                    eprintln!("Worker error: {}", error);
                }
            }
            WorkerToMain::Done => {
                // Worker finished
            }
        }
    }

    // Remove finished workers
    WORKERS.with(|workers| {
        for id in finished_workers {
            workers.borrow_mut().remove(&id);
        }
    });
}

/// Check if there are any active workers
pub fn has_active_workers() -> bool {
    WORKERS.with(|workers| !workers.borrow().is_empty())
}

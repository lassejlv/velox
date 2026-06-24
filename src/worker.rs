//! `node:worker_threads` — real OS-thread workers, each with its own JSContext
//! and event loop (the loop's state is thread-local, so a worker is just a fresh
//! `Runtime` on a spawned thread). Messages cross as JSON strings over `mpsc`
//! channels; each side wakes the other's `mio` loop with a `Waker`.
//!
//! Routing:
//! - main → worker: `__velox_worker_post(id, json)` pushes onto the worker's
//!   inbound channel and wakes its loop (waker stored in a shared slot once the
//!   worker's loop is up).
//! - worker → main: `__velox_parent_post(json)` pushes `(id, Message)` onto the
//!   single main-inbound channel and wakes the main loop.
//!
//! Worker exit/error are delivered to main the same way (`Exit`/`Error`).

use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex};

use crate::jsc::{JSContextRef, JSObjectRef, JSValue, JSValueRef};
use mio::Waker;

use crate::event_loop::{arg_slice, begin_io, end_io, register, waker};
use crate::node::js_string;
use crate::runtime::js_value_to_string;

/// A message delivered from a worker up to the main thread.
enum MainMsg {
    Message(u64, String),
    Error(u64, String),
    Exit(u64, i32),
}

/// Main-thread handle to a spawned worker.
struct WorkerHandle {
    to_worker: Sender<String>,
    /// Filled by the worker once its loop (and waker) exist.
    waker_slot: Arc<Mutex<Option<Arc<Waker>>>>,
    /// Set when the worker should stop draining/processing (terminate).
    alive: Arc<Mutex<bool>>,
}

/// What a worker thread keeps to talk to its parent and receive work.
struct ParentLink {
    worker_id: u64,
    to_main: Sender<MainMsg>,
    main_waker: Arc<Waker>,
    inbound: Receiver<String>,
    alive: Arc<Mutex<bool>>,
}

thread_local! {
    // --- main thread ---
    static WORKERS: RefCell<HashMap<u64, WorkerHandle>> = RefCell::new(HashMap::new());
    static MAIN_INBOUND: (Sender<MainMsg>, Receiver<MainMsg>) = mpsc::channel();
    static NEXT_WORKER_ID: RefCell<u64> = const { RefCell::new(1) };

    // --- worker thread ---
    static PARENT: RefCell<Option<ParentLink>> = const { RefCell::new(None) };
}

/// Register the native worker hooks on a context (main *and* worker contexts).
pub fn install(ctx: JSContextRef) {
    unsafe {
        register(ctx, c"__velox_spawn_worker", spawn_worker);
        register(ctx, c"__velox_worker_post", worker_post);
        register(ctx, c"__velox_worker_terminate", worker_terminate);
        register(ctx, c"__velox_parent_post", parent_post);
        register(ctx, c"__velox_worker_keepalive", worker_keepalive);
    }
}

/// `__velox_worker_keepalive(on)` — worker-side: keep the loop alive while
/// `parentPort` has message listeners (`begin_io`), release it otherwise.
unsafe extern "C-unwind" fn worker_keepalive(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let on = args
        .first()
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(false);
    if on {
        begin_io();
    } else {
        end_io();
    }
    unsafe { JSValue::new_undefined(ctx) }
}

/// Drain pending cross-thread messages on a loop wake — dispatches to JS.
/// Called on both main and worker threads; each acts on its own thread-local
/// state (`MAIN_INBOUND`/`WORKERS` on main, `PARENT` on a worker).
pub fn on_wake(ctx: JSContextRef) {
    // Worker side: honor a terminate request, else deliver inbound messages.
    let (inbound, terminated): (Vec<String>, bool) = PARENT.with(|p| {
        let p = p.borrow();
        match p.as_ref() {
            Some(link) => {
                let dead = !*link.alive.lock().unwrap();
                (link.inbound.try_iter().collect(), dead)
            }
            None => (Vec::new(), false),
        }
    });
    if terminated {
        crate::event_loop::request_stop();
        return;
    }
    for json in inbound {
        unsafe { call_dispatch(ctx, "__velox_parent_dispatch", &[("message", &json)]) };
    }

    // Main side: deliver worker → main messages / errors / exits.
    let msgs: Vec<MainMsg> = MAIN_INBOUND.with(|(_, rx)| rx.try_iter().collect());
    for msg in msgs {
        match msg {
            MainMsg::Message(id, json) => unsafe { worker_dispatch(ctx, id, "message", &json) },
            MainMsg::Error(id, json) => unsafe { worker_dispatch(ctx, id, "error", &json) },
            MainMsg::Exit(id, code) => {
                unsafe { worker_dispatch(ctx, id, "exit", &code.to_string()) };
                // The worker is done — drop its handle and release the loop ref.
                WORKERS.with(|w| w.borrow_mut().remove(&id));
                end_io();
            }
        }
    }
}

/// `__velox_spawn_worker(source, isFile, workerDataJson)` → worker id.
/// `source` is a file path (bundled here) when `isFile`, else raw JS code.
unsafe extern "C-unwind" fn spawn_worker(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let source = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let is_file = args
        .get(1)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(true);
    let worker_data = args
        .get(2)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_else(|| "undefined".to_string());

    // Bundle the worker entry on this (main) thread; a worker thread can't take
    // the bundler's path-relative cwd assumptions, and errors surface cleanly.
    let bundled = if is_file {
        match crate::module::bundle(std::path::Path::new(&source)) {
            Ok(js) => js,
            Err(e) => {
                // Report as an error event-ish: spawn nothing, return 0.
                crate::ui::report_module_error(&e.to_string());
                return unsafe { JSValue::new_number(ctx, 0.0) };
            }
        }
    } else {
        source
    };

    let worker_id = NEXT_WORKER_ID.with(|n| {
        let mut n = n.borrow_mut();
        let id = *n;
        *n += 1;
        id
    });

    let (to_worker, inbound) = mpsc::channel::<String>();
    let waker_slot = Arc::new(Mutex::new(None));
    let alive = Arc::new(Mutex::new(true));
    let to_main = MAIN_INBOUND.with(|(tx, _)| tx.clone());
    let main_waker = waker();

    WORKERS.with(|w| {
        w.borrow_mut().insert(
            worker_id,
            WorkerHandle {
                to_worker,
                waker_slot: Arc::clone(&waker_slot),
                alive: Arc::clone(&alive),
            },
        )
    });
    // Keep the main loop alive while the worker runs.
    begin_io();

    let thread_alive = Arc::clone(&alive);
    std::thread::spawn(move || {
        run_worker(
            worker_id,
            bundled,
            worker_data,
            inbound,
            to_main,
            main_waker,
            waker_slot,
            thread_alive,
        );
    });

    unsafe { JSValue::new_number(ctx, worker_id as f64) }
}

/// The body of a worker OS thread: build a `Runtime`, wire `parentPort`, run.
#[allow(clippy::too_many_arguments)]
fn run_worker(
    worker_id: u64,
    bundled: String,
    worker_data: String,
    inbound: Receiver<String>,
    to_main: Sender<MainMsg>,
    main_waker: Arc<Waker>,
    waker_slot: Arc<Mutex<Option<Arc<Waker>>>>,
    alive: Arc<Mutex<bool>>,
) {
    let runtime = crate::runtime::Runtime::new();

    // Publish this worker's waker so the main thread can interrupt our poll().
    *waker_slot.lock().unwrap() = Some(waker());

    // Stash the parent link for `parent_post`/`on_wake` on this thread.
    PARENT.with(|p| {
        *p.borrow_mut() = Some(ParentLink {
            worker_id,
            to_main: to_main.clone(),
            main_waker: Arc::clone(&main_waker),
            inbound,
            alive: Arc::clone(&alive),
        })
    });

    // Mark the worker context so the shim installs `parentPort`/`workerData`.
    let setup = format!(
        "globalThis.__velox_is_worker = true; globalThis.__velox_worker_data_json = {};",
        serde_json::to_string(&worker_data).unwrap_or_else(|_| "\"undefined\"".into())
    );
    let _ = runtime.eval(&setup);

    // The worker stays alive only while its `parentPort` has message listeners
    // (the shim toggles this via `__velox_worker_keepalive`) or it has its own
    // pending timers/I/O — so a compute-and-exit worker finishes on its own.
    let threw = match runtime.eval(&bundled) {
        Ok(_) => {
            // Drain any messages that arrived before our waker was published
            // (main may `postMessage` the instant `new Worker` returns), so the
            // first blocking poll() doesn't miss them.
            on_wake(runtime.raw_context());
            runtime.run_event_loop()
        }
        Err(e) => {
            let _ = to_main.send(MainMsg::Error(
                worker_id,
                serde_json::to_string(&e).unwrap_or_else(|_| "\"worker error\"".into()),
            ));
            let _ = main_waker.wake();
            true
        }
    };
    let _ = threw;

    let code = runtime.exit_code();
    let _ = to_main.send(MainMsg::Exit(worker_id, code));
    let _ = main_waker.wake();
}

/// `__velox_worker_post(id, json)` — main thread queues a message to a worker.
unsafe extern "C-unwind" fn worker_post(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, std::ptr::null_mut()) })
        .unwrap_or(0.0) as u64;
    let json = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    WORKERS.with(|w| {
        if let Some(h) = w.borrow().get(&id) {
            let _ = h.to_worker.send(json);
            if let Some(waker) = h.waker_slot.lock().unwrap().as_ref() {
                let _ = waker.wake();
            }
        }
    });
    unsafe { JSValue::new_undefined(ctx) }
}

/// `__velox_worker_terminate(id)` — request a worker stop.
unsafe extern "C-unwind" fn worker_terminate(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, std::ptr::null_mut()) })
        .unwrap_or(0.0) as u64;
    WORKERS.with(|w| {
        if let Some(h) = w.borrow().get(&id) {
            *h.alive.lock().unwrap() = false;
            if let Some(waker) = h.waker_slot.lock().unwrap().as_ref() {
                let _ = waker.wake();
            }
        }
    });
    unsafe { JSValue::new_undefined(ctx) }
}

/// `__velox_parent_post(json)` — worker thread sends a message to its parent.
unsafe extern "C-unwind" fn parent_post(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let json = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    PARENT.with(|p| {
        if let Some(link) = p.borrow().as_ref() {
            let _ = link.to_main.send(MainMsg::Message(link.worker_id, json));
            let _ = link.main_waker.wake();
        }
    });
    unsafe { JSValue::new_undefined(ctx) }
}

/// Call a global dispatch function `name(eventType, json)` in the given context.
unsafe fn call_dispatch(ctx: JSContextRef, name: &str, events: &[(&str, &str)]) {
    for (event, json) in events {
        unsafe { invoke_global2(ctx, name, event, json) };
    }
}

/// Main-side: `__velox_worker_dispatch(id, type, json)`.
unsafe fn worker_dispatch(ctx: JSContextRef, id: u64, event: &str, json: &str) {
    unsafe { invoke_global3(ctx, "__velox_worker_dispatch", &id.to_string(), event, json) };
}

/// Invoke `globalThis[name](a, b)` with two string args.
unsafe fn invoke_global2(ctx: JSContextRef, name: &str, a: &str, b: &str) {
    let args = [unsafe { js_string(ctx, a) }, unsafe { js_string(ctx, b) }];
    unsafe { invoke(ctx, name, &args) };
}

/// Invoke `globalThis[name](a, b, c)`. `a` is passed as a number when numeric.
unsafe fn invoke_global3(ctx: JSContextRef, name: &str, a: &str, b: &str, c: &str) {
    let arg_a = match a.parse::<f64>() {
        Ok(n) => unsafe { JSValue::new_number(ctx, n) },
        Err(_) => unsafe { js_string(ctx, a) },
    };
    let args = [arg_a, unsafe { js_string(ctx, b) }, unsafe {
        js_string(ctx, c)
    }];
    unsafe { invoke(ctx, name, &args) };
}

/// Look up `globalThis[name]` and call it with `args` (ignoring its result).
unsafe fn invoke(ctx: JSContextRef, name: &str, args: &[JSValueRef]) {
    use crate::jsc::{
        JSContext, JSObjectCallAsFunction, JSObjectGetProperty, JSStringCreateWithUTF8CString,
        JSStringRelease,
    };
    unsafe {
        let global = JSContext::global_object(ctx);
        let cname = std::ffi::CString::new(name).unwrap();
        let jsname = JSStringCreateWithUTF8CString(cname.as_ptr());
        let func = JSObjectGetProperty(ctx, global, jsname, std::ptr::null_mut());
        JSStringRelease(jsname);
        let func_obj = JSValue::to_object(ctx, func, std::ptr::null_mut());
        if func_obj.is_null() {
            return;
        }
        let mut exception: JSValueRef = std::ptr::null();
        JSObjectCallAsFunction(
            ctx,
            func_obj,
            std::ptr::null_mut(),
            args.len(),
            args.as_ptr() as *mut JSValueRef,
            &mut exception,
        );
    }
}

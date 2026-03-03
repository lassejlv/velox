use crate::event_loop::EventLoopHandle;
use rusty_v8 as v8;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

type CallbackMap = HashMap<u64, v8::Global<v8::Function>>;
type IntervalMap = HashMap<u64, u64>; // timer_id -> delay_ms

thread_local! {
    static TIMER_CALLBACKS: RefCell<CallbackMap> = RefCell::new(HashMap::new());
    static INTERVAL_DELAYS: RefCell<IntervalMap> = RefCell::new(HashMap::new());
    static EVENT_LOOP_HANDLE: RefCell<Option<EventLoopHandle>> = RefCell::new(None);
}

static NEXT_TIMER_ID: AtomicU64 = AtomicU64::new(1);

pub fn set_event_loop(handle: EventLoopHandle) {
    EVENT_LOOP_HANDLE.with(|h| {
        *h.borrow_mut() = Some(handle);
    });
}

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let set_timeout = v8::Function::new(scope, set_timeout_callback).unwrap();
    let key = v8::String::new(scope, "setTimeout").unwrap();
    global.set(scope, key.into(), set_timeout.into());

    let clear_timeout = v8::Function::new(scope, clear_timeout_callback).unwrap();
    let key = v8::String::new(scope, "clearTimeout").unwrap();
    global.set(scope, key.into(), clear_timeout.into());

    let set_interval = v8::Function::new(scope, set_interval_callback).unwrap();
    let key = v8::String::new(scope, "setInterval").unwrap();
    global.set(scope, key.into(), set_interval.into());

    let clear_interval = v8::Function::new(scope, clear_interval_callback).unwrap();
    let key = v8::String::new(scope, "clearInterval").unwrap();
    global.set(scope, key.into(), clear_interval.into());
}

fn set_timeout_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        let undefined = v8::undefined(scope);
        rv.set(undefined.into());
        return;
    }

    let callback = args.get(0);
    if !callback.is_function() {
        let undefined = v8::undefined(scope);
        rv.set(undefined.into());
        return;
    }

    let callback = v8::Local::<v8::Function>::try_from(callback).unwrap();
    let delay_ms = if args.length() > 1 {
        args.get(1)
            .number_value(scope)
            .map(|n| n.max(0.0) as u64)
            .unwrap_or(0)
    } else {
        0
    };

    let timer_id = NEXT_TIMER_ID.fetch_add(1, Ordering::SeqCst);

    let callback_global = v8::Global::new(scope, callback);
    TIMER_CALLBACKS.with(|callbacks| {
        callbacks.borrow_mut().insert(timer_id, callback_global);
    });

    EVENT_LOOP_HANDLE.with(|handle| {
        if let Some(handle) = handle.borrow().as_ref() {
            handle.spawn_timer(timer_id, Duration::from_millis(delay_ms));
        }
    });

    let id_value = v8::Number::new(scope, timer_id as f64);
    rv.set(id_value.into());
}

fn clear_timeout_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        return;
    }

    let timer_id = args.get(0).number_value(scope).map(|n| n as u64);
    if let Some(id) = timer_id {
        TIMER_CALLBACKS.with(|callbacks| {
            callbacks.borrow_mut().remove(&id);
        });
    }
}

fn set_interval_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        let undefined = v8::undefined(scope);
        rv.set(undefined.into());
        return;
    }

    let callback = args.get(0);
    if !callback.is_function() {
        let undefined = v8::undefined(scope);
        rv.set(undefined.into());
        return;
    }

    let callback = v8::Local::<v8::Function>::try_from(callback).unwrap();
    let delay_ms = if args.length() > 1 {
        args.get(1)
            .number_value(scope)
            .map(|n| n.max(0.0) as u64)
            .unwrap_or(0)
    } else {
        0
    };

    let timer_id = NEXT_TIMER_ID.fetch_add(1, Ordering::SeqCst);

    let callback_global = v8::Global::new(scope, callback);
    TIMER_CALLBACKS.with(|callbacks| {
        callbacks.borrow_mut().insert(timer_id, callback_global);
    });

    INTERVAL_DELAYS.with(|intervals| {
        intervals.borrow_mut().insert(timer_id, delay_ms);
    });

    EVENT_LOOP_HANDLE.with(|handle| {
        if let Some(handle) = handle.borrow().as_ref() {
            handle.spawn_timer(timer_id, Duration::from_millis(delay_ms));
        }
    });

    let id_value = v8::Number::new(scope, timer_id as f64);
    rv.set(id_value.into());
}

fn clear_interval_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        return;
    }

    let timer_id = args.get(0).number_value(scope).map(|n| n as u64);
    if let Some(id) = timer_id {
        TIMER_CALLBACKS.with(|callbacks| {
            callbacks.borrow_mut().remove(&id);
        });
        INTERVAL_DELAYS.with(|intervals| {
            intervals.borrow_mut().remove(&id);
        });
    }
}

pub fn execute_timer(scope: &mut v8::HandleScope, timer_id: u64) {
    let is_interval = INTERVAL_DELAYS.with(|intervals| intervals.borrow().contains_key(&timer_id));

    let callback = if is_interval {
        TIMER_CALLBACKS.with(|callbacks| callbacks.borrow().get(&timer_id).cloned())
    } else {
        TIMER_CALLBACKS.with(|callbacks| callbacks.borrow_mut().remove(&timer_id))
    };

    if let Some(callback_global) = callback {
        let callback = v8::Local::new(scope, callback_global);
        let undefined = v8::undefined(scope);
        let tc_scope = &mut v8::TryCatch::new(scope);
        if callback.call(tc_scope, undefined.into(), &[]).is_none() {
            if let Some(exception) = tc_scope.exception() {
                let msg = exception.to_rust_string_lossy(tc_scope);
                eprintln!("Timer callback error: {}", msg);
            }
        }

        if is_interval {
            let delay_ms =
                INTERVAL_DELAYS.with(|intervals| intervals.borrow().get(&timer_id).copied());

            if let Some(delay) = delay_ms {
                EVENT_LOOP_HANDLE.with(|handle| {
                    if let Some(handle) = handle.borrow().as_ref() {
                        handle.spawn_timer(timer_id, Duration::from_millis(delay));
                    }
                });
            }
        }
    }
}

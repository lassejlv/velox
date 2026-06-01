//! A small, fast event loop: timers plus a `mio` (kqueue/epoll) I/O reactor.
//!
//! Two kinds of work are interleaved in a single blocking wait:
//!
//! * **Timers** (`setTimeout`/`setInterval`) live in a binary min-heap keyed by
//!   due time.
//! * **Sockets** are registered with a `mio::Poll`. On macOS that's kqueue; the
//!   driver blocks in `poll(timeout)` until a socket is ready *or* the next
//!   timer is due, waking on whichever comes first — never busy-waiting.
//!
//! `fetch` drives its connections entirely on this thread as a non-blocking
//! state machine (see `fetch.rs`), so many requests are multiplexed over one
//! kqueue with zero worker threads and no cross-thread JS handoff.
//!
//! JavaScriptCore drains its Promise microtask queue after each callback
//! returns to the embedder, so `async`/`await` composes on top of both timers
//! and I/O without manual pumping.

use std::cell::{Cell, RefCell};
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};
use std::ffi::CStr;
use std::ptr;
use std::time::{Duration, Instant};

use std::sync::Arc;

use mio::{Events, Poll, Registry, Token, Waker};
use objc2_javascript_core::{
    JSContext, JSContextRef, JSObjectCallAsFunction, JSObjectMakeFunctionWithCallback, JSObjectRef,
    JSObjectSetProperty, JSStringCreateWithUTF8CString, JSStringRelease, JSValue, JSValueRef,
};

use crate::runtime::js_value_to_string;

/// Signature of a native function exposed to JavaScript via the JSC C API.
pub(crate) type NativeFn = unsafe extern "C-unwind" fn(
    JSContextRef,
    JSObjectRef,
    JSObjectRef,
    usize,
    *mut JSValueRef,
    *mut JSValueRef,
) -> JSValueRef;

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

/// A scheduled timer. `callback` and `args` are GC-protected for as long as
/// this lives, since they outlive the script evaluation that created them.
struct Timer {
    due: Instant,
    /// Insertion order, used as a FIFO tiebreaker for equal due times.
    seq: u64,
    /// Public id returned to JS and accepted by `clearTimeout`/`clearInterval`.
    id: u64,
    /// `Some(period)` for `setInterval`, `None` for `setTimeout`.
    interval: Option<Duration>,
    callback: JSObjectRef,
    /// Extra arguments forwarded to the callback on each fire.
    args: Vec<JSValueRef>,
    ctx: JSContextRef,
}

impl Timer {
    /// Release the GC protection on this timer's callback and forwarded args.
    fn release(&self) {
        unsafe {
            JSValue::unprotect(self.ctx, self.callback as JSValueRef);
            for arg in &self.args {
                JSValue::unprotect(self.ctx, *arg);
            }
        }
    }
}

// Min-heap behavior on a max-heap `BinaryHeap`: the *earliest* due time (and
// then the smallest seq) must compare as the *greatest* so it pops first.
impl Ord for Timer {
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .due
            .cmp(&self.due)
            .then_with(|| other.seq.cmp(&self.seq))
    }
}
impl PartialOrd for Timer {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl PartialEq for Timer {
    fn eq(&self, other: &Self) -> bool {
        self.due == other.due && self.seq == other.seq
    }
}
impl Eq for Timer {}

#[derive(Default)]
struct TimerQueue {
    heap: BinaryHeap<Timer>,
    cancelled: HashSet<u64>,
    /// Timers marked `.unref()` — pending but not keeping the loop alive.
    unref_ids: HashSet<u64>,
    next_id: u64,
    next_seq: u64,
}

/// What the driver should do about timers next.
enum TimerAction {
    /// No timers remain.
    Idle,
    /// Nothing is due yet; the earliest fires after this long.
    Wait(Duration),
    /// This timer is due now; fire it.
    Ready(Timer),
}

impl TimerQueue {
    fn add(
        &mut self,
        ctx: JSContextRef,
        callback: JSObjectRef,
        args: Vec<JSValueRef>,
        delay: Duration,
        interval: Option<Duration>,
    ) -> u64 {
        self.next_id += 1;
        self.next_seq += 1;
        self.heap.push(Timer {
            due: Instant::now() + delay,
            seq: self.next_seq,
            id: self.next_id,
            interval,
            callback,
            args,
            ctx,
        });
        self.next_id
    }

    fn cancel(&mut self, id: u64) {
        self.cancelled.insert(id);
    }

    /// Mark a timer ref'd/unref'd. Unref'd timers fire if the loop is otherwise
    /// alive, but never keep it running on their own (matching Node).
    fn set_unref(&mut self, id: u64, unref: bool) {
        if unref {
            self.unref_ids.insert(id);
        } else {
            self.unref_ids.remove(&id);
        }
    }

    /// Drop bookkeeping for a timer that has left the heap.
    fn forget(&mut self, id: u64) {
        self.cancelled.remove(&id);
        self.unref_ids.remove(&id);
    }

    /// Is any pending timer still keeping the loop alive (not cancelled, not
    /// unref'd)? Timer counts are small, so a linear scan is fine.
    fn has_ref_work(&self) -> bool {
        self.heap
            .iter()
            .any(|t| !self.cancelled.contains(&t.id) && !self.unref_ids.contains(&t.id))
    }

    /// Re-arm an interval timer for its next tick.
    fn rearm(&mut self, mut timer: Timer, now: Instant) {
        let Some(period) = timer.interval else {
            return;
        };
        self.next_seq += 1;
        timer.seq = self.next_seq;
        timer.due = now + period;
        self.heap.push(timer);
    }

    /// Decide the next timer action, discarding any cancelled timers.
    fn next_action(&mut self, now: Instant) -> TimerAction {
        loop {
            let Some(top) = self.heap.peek() else {
                return TimerAction::Idle;
            };
            if self.cancelled.contains(&top.id) {
                let timer = self.heap.pop().unwrap();
                self.forget(timer.id);
                timer.release();
                continue;
            }
            if top.due > now {
                return TimerAction::Wait(top.due - now);
            }
            return TimerAction::Ready(self.heap.pop().unwrap());
        }
    }
}

thread_local! {
    static QUEUE: RefCell<TimerQueue> = RefCell::new(TimerQueue::default());

    /// The kqueue/epoll instance every I/O source registers with.
    static POLL: RefCell<Poll> = RefCell::new(Poll::new().expect("create mio Poll"));

    /// Wakes the loop from another thread (used by async DNS lookups).
    static WAKER: Arc<Waker> = POLL.with(|p| {
        Arc::new(Waker::new(p.borrow().registry(), DNS_WAKE_TOKEN).expect("create mio Waker"))
    });

    /// Count of async operations (e.g. in-flight fetches) keeping the loop alive.
    static IN_FLIGHT: Cell<usize> = const { Cell::new(0) };

    /// Set when an async failure (e.g. a rejected top-level `await`) is surfaced
    /// through `__velox_uncaught`, so the process can exit non-zero.
    static UNCAUGHT: Cell<bool> = const { Cell::new(false) };

    /// Set to force the loop to stop (used by `worker.terminate()` on the
    /// worker's own thread).
    static STOP_REQUESTED: Cell<bool> = const { Cell::new(false) };
}

/// Force the current thread's event loop to stop at the next iteration.
pub(crate) fn request_stop() {
    STOP_REQUESTED.with(|s| s.set(true));
}

/// Token delivered when a background thread calls the loop's `Waker`.
pub(crate) const DNS_WAKE_TOKEN: Token = Token(usize::MAX);

thread_local! {
    /// Monotonic source of unique `mio` tokens, shared across all I/O sources
    /// (fetch connections, server listeners, server connections) so they never
    /// collide. `usize::MAX` is reserved for the DNS waker.
    static NEXT_TOKEN: Cell<usize> = const { Cell::new(0) };
}

/// Allocate a process-unique `mio` token.
pub(crate) fn next_token() -> Token {
    NEXT_TOKEN.with(|c| {
        let t = c.get();
        c.set(t.wrapping_add(1));
        Token(t)
    })
}

/// A clone of the loop's waker, for background threads to nudge it awake.
pub(crate) fn waker() -> Arc<Waker> {
    WAKER.with(Arc::clone)
}

/// A `Registry` (clone) for I/O sources to register/deregister themselves.
pub(crate) fn registry() -> Registry {
    POLL.with(|p| {
        p.borrow()
            .registry()
            .try_clone()
            .expect("clone mio registry")
    })
}

/// Record that an asynchronous operation has started.
pub(crate) fn begin_io() {
    IN_FLIGHT.with(|c| c.set(c.get() + 1));
}

/// Record that an asynchronous operation has finished.
pub(crate) fn end_io() {
    IN_FLIGHT.with(|c| c.set(c.get().saturating_sub(1)));
}

// ---------------------------------------------------------------------------
// Installation + driver
// ---------------------------------------------------------------------------

/// Register `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, and
/// the `__velox_uncaught` rejection hook.
pub fn install(ctx: JSContextRef) {
    unsafe {
        register(ctx, c"setTimeout", set_timeout);
        register(ctx, c"setInterval", set_interval);
        register(ctx, c"clearTimeout", clear_timer);
        register(ctx, c"clearInterval", clear_timer);
        register(ctx, c"__velox_timer_unref", timer_unref);
        register(ctx, c"__velox_uncaught", uncaught);
    }
}

/// Drive the loop until no timers and no I/O remain. Returns `true` if any
/// callback threw an uncaught (sync or async) exception.
pub fn run(ctx: JSContextRef) -> bool {
    let mut had_error = false;
    let mut events = Events::with_capacity(64);

    loop {
        if STOP_REQUESTED.with(|s| s.replace(false)) {
            break;
        }
        let in_flight = IN_FLIGHT.with(|c| c.get());
        let has_ref = QUEUE.with(|q| q.borrow().has_ref_work());
        // Nothing keeps us alive — exit even if unref'd timers are still pending.
        if !has_ref && in_flight == 0 {
            break;
        }

        let action = QUEUE.with(|q| q.borrow_mut().next_action(Instant::now()));
        let timeout = match action {
            TimerAction::Ready(timer) => {
                if fire(ctx, &timer) {
                    had_error = true;
                }
                if timer.interval.is_some() {
                    QUEUE.with(|q| q.borrow_mut().rearm(timer, Instant::now()));
                } else {
                    let id = timer.id;
                    timer.release();
                    QUEUE.with(|q| q.borrow_mut().forget(id));
                }
                continue;
            }
            TimerAction::Wait(delay) => Some(delay),
            TimerAction::Idle => None, // in_flight > 0 here: block until I/O is ready
        };

        POLL.with(|p| {
            if let Err(error) = p.borrow_mut().poll(&mut events, timeout) {
                // A signal can interrupt the wait; just loop and retry.
                debug_assert!(error.kind() == std::io::ErrorKind::Interrupted, "{error}");
            }
        });

        for event in events.iter() {
            if event.token() == DNS_WAKE_TOKEN {
                crate::fetch::on_dns_ready(ctx);
                crate::server::on_dns_ready(ctx);
                crate::sys::on_wake(ctx);
                crate::worker::on_wake(ctx);
            } else {
                // Tokens are globally unique, so each event belongs to exactly
                // one driver; the others treat it as a no-op.
                crate::fetch::on_ready(ctx, event);
                crate::server::on_ready(ctx, event);
                crate::udp::on_ready(ctx, event);
            }
        }
    }

    had_error | UNCAUGHT.with(|u| u.replace(false))
}

/// Invoke a timer's callback with its forwarded arguments. Returns `true` if it
/// threw.
fn fire(ctx: JSContextRef, timer: &Timer) -> bool {
    let mut exception: JSValueRef = ptr::null();
    let argc = timer.args.len();
    let argv = if argc == 0 {
        ptr::null_mut()
    } else {
        timer.args.as_ptr() as *mut JSValueRef
    };
    unsafe {
        JSObjectCallAsFunction(
            ctx,
            timer.callback,
            ptr::null_mut(), // `this` = global
            argc,
            argv,
            &mut exception,
        );
    }
    if exception.is_null() {
        return false;
    }
    let message = unsafe { js_value_to_string(ctx, exception) };
    crate::ui::report_runtime_error(&message);
    true
}

/// Register a single native function under `name` on the global object.
pub(crate) unsafe fn register(ctx: JSContextRef, name: &CStr, callback: NativeFn) {
    unsafe {
        let global = JSContext::global_object(ctx);
        let name_str = JSStringCreateWithUTF8CString(name.as_ptr());
        let function = JSObjectMakeFunctionWithCallback(ctx, name_str, Some(callback));
        JSObjectSetProperty(
            ctx,
            global,
            name_str,
            function as JSValueRef,
            0,
            ptr::null_mut(),
        );
        JSStringRelease(name_str);
    }
}

/// `__velox_uncaught(message)` — report an async failure and flag a non-zero
/// exit. Used by the bundle to surface rejected top-level `await`.
unsafe extern "C-unwind" fn uncaught(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let message = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    // The message carries a JS-built stack (bundle positions) — map it to source.
    crate::ui::report_runtime_error(&crate::sourcemap::rewrite_stack(&message));
    UNCAUGHT.with(|u| u.set(true));
    unsafe { JSValue::new_undefined(ctx) }
}

// ---------------------------------------------------------------------------
// Native timer functions
// ---------------------------------------------------------------------------

unsafe extern "C-unwind" fn set_timeout(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    unsafe { schedule(ctx, argc, argv, false) }
}

unsafe extern "C-unwind" fn set_interval(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    unsafe { schedule(ctx, argc, argv, true) }
}

/// Shared body of `setTimeout`/`setInterval`: protect the callback and any
/// forwarded args, compute the delay, enqueue, and return the numeric id.
unsafe fn schedule(
    ctx: JSContextRef,
    argc: usize,
    argv: *mut JSValueRef,
    repeat: bool,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let Some(&callback_value) = args.first() else {
        return unsafe { JSValue::new_number(ctx, 0.0) };
    };

    let callback = unsafe { JSValue::to_object(ctx, callback_value, ptr::null_mut()) };
    if callback.is_null() {
        return unsafe { JSValue::new_number(ctx, 0.0) };
    }

    let delay_ms = args
        .get(1)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0);
    let seconds = if delay_ms.is_finite() {
        delay_ms.max(0.0) / 1000.0
    } else {
        0.0
    };
    let delay = Duration::from_secs_f64(seconds);
    let interval = repeat.then_some(delay);

    // Trailing arguments are forwarded to the callback (`setTimeout(fn, ms, a, b)`).
    let forwarded: Vec<JSValueRef> = args.get(2..).unwrap_or(&[]).to_vec();

    unsafe {
        JSValue::protect(ctx, callback as JSValueRef);
        for arg in &forwarded {
            JSValue::protect(ctx, *arg);
        }
    }

    let id = QUEUE.with(|q| {
        q.borrow_mut()
            .add(ctx, callback, forwarded, delay, interval)
    });
    unsafe { JSValue::new_number(ctx, id as f64) }
}

/// `clearTimeout` / `clearInterval` — both accept a numeric id.
unsafe extern "C-unwind" fn clear_timer(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    if let Some(&value) = args.first() {
        let id = unsafe { JSValue::to_number(ctx, value, ptr::null_mut()) };
        if id.is_finite() && id >= 0.0 {
            QUEUE.with(|q| q.borrow_mut().cancel(id as u64));
        }
    }
    unsafe { JSValue::new_undefined(ctx) }
}

/// `__velox_timer_unref(id, unref)` — mark a timer as (not) keeping the loop alive.
unsafe extern "C-unwind" fn timer_unref(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(-1.0);
    let unref = args
        .get(1)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(true);
    if id.is_finite() && id >= 0.0 {
        QUEUE.with(|q| q.borrow_mut().set_unref(id as u64, unref));
    }
    unsafe { JSValue::new_undefined(ctx) }
}

/// View native-callback arguments as a slice.
pub(crate) fn arg_slice<'a>(argc: usize, argv: *mut JSValueRef) -> &'a [JSValueRef] {
    if argv.is_null() || argc == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(argv as *const JSValueRef, argc) }
    }
}

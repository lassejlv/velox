//! Cross-thread `SharedArrayBuffer` backing. JSC ships `Atomics` but no
//! `SharedArrayBuffer`, and its worker contexts live in separate context groups,
//! so a JSC-allocated buffer can't be shared. We sidestep that by owning the
//! bytes ourselves: a process-global registry of heap regions, each exposed to a
//! context as an ArrayBuffer via `JSObjectMakeArrayBufferWithBytesNoCopy` over
//! the *same* pointer. A worker receives a SAB by id (over the message channel)
//! and maps the same region — so writes and `Atomics` ops on one thread are
//! visible on the other (real shared memory). Lifetime is reference-counted
//! across every live ArrayBuffer + in-flight transfer.

use std::alloc::{Layout, alloc_zeroed, dealloc};
use std::collections::HashMap;
use std::ffi::c_void;
use std::ptr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use objc2_javascript_core::{
    JSContextRef, JSObjectMakeArrayBufferWithBytesNoCopy, JSObjectRef, JSValue, JSValueRef,
};

use crate::event_loop::{arg_slice, register};

/// A heap region shared across threads as a `SharedArrayBuffer`'s backing store.
struct Region {
    ptr: *mut u8,
    len: usize,
    /// Live references: one per ArrayBuffer view + one per in-flight transfer.
    refs: usize,
}
// The pointer addresses process-heap memory that is valid on every thread; the
// `Mutex` serializes all registry access.
unsafe impl Send for Region {}

fn registry() -> &'static Mutex<HashMap<u64, Region>> {
    static R: OnceLock<Mutex<HashMap<u64, Region>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

/// 16-byte alignment so any typed-array view (incl. Float64/BigInt64) is aligned.
fn layout_for(len: usize) -> Layout {
    Layout::from_size_align(len.max(1), 16).expect("valid layout")
}

/// Register the shared-memory natives (installed on main *and* worker contexts).
pub fn install(ctx: JSContextRef) {
    unsafe {
        register(ctx, c"__velox_shared_alloc", shared_alloc);
        register(ctx, c"__velox_shared_buffer", shared_buffer);
        register(ctx, c"__velox_shared_retain", shared_retain);
        register(ctx, c"__velox_shared_release", shared_release);
    }
}

fn arg_u64(ctx: JSContextRef, args: &[JSValueRef], i: usize) -> u64 {
    args.get(i)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0) as u64
}

/// `__velox_shared_alloc(byteLength)` → region id (the backing is zero-filled).
unsafe extern "C-unwind" fn shared_alloc(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let len = arg_u64(ctx, args, 0) as usize;
    let ptr = unsafe { alloc_zeroed(layout_for(len)) };
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);
    registry()
        .lock()
        .unwrap()
        .insert(id, Region { ptr, len, refs: 0 });
    unsafe { JSValue::new_number(ctx, id as f64) }
}

/// `__velox_shared_buffer(id)` → an ArrayBuffer over the region (refcount += 1).
unsafe extern "C-unwind" fn shared_buffer(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_u64(ctx, args, 0);
    let (ptr, len) = {
        let mut reg = registry().lock().unwrap();
        match reg.get_mut(&id) {
            Some(r) => {
                r.refs += 1;
                (r.ptr, r.len)
            }
            None => return unsafe { JSValue::new_undefined(ctx) },
        }
    };
    let buf = unsafe {
        JSObjectMakeArrayBufferWithBytesNoCopy(
            ctx,
            ptr as *mut c_void,
            len,
            Some(dealloc_cb),
            id as *mut c_void,
            ptr::null_mut(),
        )
    };
    buf as JSValueRef
}

/// `__velox_shared_retain(id)` — hold the region across an in-flight transfer.
unsafe extern "C-unwind" fn shared_retain(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_u64(ctx, args, 0);
    if let Some(r) = registry().lock().unwrap().get_mut(&id) {
        r.refs += 1;
    }
    unsafe { JSValue::new_undefined(ctx) }
}

/// `__velox_shared_release(id)` — drop a transfer hold (free if it was the last).
unsafe extern "C-unwind" fn shared_release(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    drop_ref(arg_u64(ctx, args, 0));
    unsafe { JSValue::new_undefined(ctx) }
}

/// Deallocator JSC invokes when an ArrayBuffer view is collected. `dctx` is the
/// region id; releasing here mirrors the `refs += 1` in `shared_buffer`.
unsafe extern "C-unwind" fn dealloc_cb(_bytes: *mut c_void, dctx: *mut c_void) {
    drop_ref(dctx as u64);
}

/// Decrement a region's refcount, freeing the backing when it reaches zero.
fn drop_ref(id: u64) {
    let mut reg = registry().lock().unwrap();
    if let Some(r) = reg.get_mut(&id) {
        r.refs = r.refs.saturating_sub(1);
        if r.refs == 0 {
            let region = reg.remove(&id).unwrap();
            unsafe { dealloc(region.ptr, layout_for(region.len)) };
        }
    }
}

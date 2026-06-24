//! `node:vm` with **real context isolation**: each `runInNewContext` evaluates
//! in a fresh `JSGlobalContext` created in the *same* `JSContextGroup` (so values
//! marshal between them freely), with the sandbox object's properties installed
//! as the new context's globals. Because the sandbox *is* the evaluated code's
//! global object, top-level `var`/function declarations and implicit-global
//! assignments both write back to the sandbox — matching Node — while host
//! globals (`process`, `require`, …) are genuinely unreachable.

use std::cell::RefCell;
use std::os::raw::c_char;
use std::ptr;

use crate::jsc::{
    JSContext, JSContextRef, JSEvaluateScript, JSGlobalContextCreateInGroup, JSGlobalContextRef,
    JSGlobalContextRelease, JSObjectCopyPropertyNames, JSObjectGetProperty, JSObjectRef,
    JSObjectSetProperty, JSPropertyNameArrayGetCount, JSPropertyNameArrayGetNameAtIndex,
    JSPropertyNameArrayRelease, JSStringCreateWithUTF8CString, JSStringRef, JSStringRelease,
    JSValue, JSValueRef,
};

use crate::event_loop::{arg_slice, register};
use crate::runtime::js_value_to_string;

thread_local! {
    /// The previous vm context + its protected result, released on the next call
    /// (by then JS has consumed the result; if it kept a reference, the shared
    /// group heap keeps the value alive regardless of our unprotect).
    static PREV: RefCell<Option<(JSGlobalContextRef, JSValueRef)>> = const { RefCell::new(None) };
}

/// Register the native vm hook.
pub fn install(ctx: JSContextRef) {
    unsafe { register(ctx, c"__velox_vm_run", vm_run) };
}

/// `__velox_vm_run(code, sandbox)` → completion value. Evaluates `code` in a
/// fresh global context whose globals are `sandbox`'s properties; copies new /
/// mutated globals back into `sandbox` afterward.
unsafe extern "C-unwind" fn vm_run(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let code = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let sandbox = match args.get(1) {
        Some(v) => unsafe { JSValue::to_object(ctx, *v, ptr::null_mut()) },
        None => ptr::null_mut(),
    };

    // Release the previous vm context now that its result has been consumed.
    release_prev(ctx);

    let group = unsafe { JSContext::group(ctx) };
    let new_ctx = unsafe { JSGlobalContextCreateInGroup(group, ptr::null_mut()) };
    if new_ctx.is_null() {
        return unsafe { JSValue::new_undefined(ctx) };
    }
    let new_ctx_ref = new_ctx as JSContextRef;
    let new_global = unsafe { JSContext::global_object(new_ctx_ref) };

    // Install the sandbox's own enumerable properties as the new context's
    // globals. Values from `ctx` are valid in `new_ctx` (same group).
    if !sandbox.is_null() {
        copy_props(ctx, sandbox, new_ctx_ref, new_global);
    }

    // Evaluate the code in the isolated context.
    let script = unsafe { JSStringCreateWithUTF8CString(c_string(&code).as_ptr()) };
    let mut vm_exception: JSValueRef = ptr::null();
    let result = unsafe {
        JSEvaluateScript(
            new_ctx_ref,
            script,
            ptr::null_mut(),
            ptr::null_mut(),
            0,
            &mut vm_exception,
        )
    };
    unsafe { JSStringRelease(script) };

    // Copy back the (mutated + newly-declared) enumerable globals to the sandbox.
    if !sandbox.is_null() {
        copy_props(new_ctx_ref, new_global, ctx, sandbox);
    }

    if !vm_exception.is_null() {
        // Surface the thrown value to the caller's context (same group).
        unsafe { JSValue::protect(ctx, vm_exception) };
        unsafe { *exception = vm_exception };
        // Stash the context so the (protected) exception stays valid until the
        // next call.
        PREV.with(|p| *p.borrow_mut() = Some((new_ctx, vm_exception)));
        return unsafe { JSValue::new_undefined(ctx) };
    }

    let result = if result.is_null() {
        unsafe { JSValue::new_undefined(ctx) }
    } else {
        result
    };
    // Root the result against the caller's context, then defer releasing this
    // vm context to the next call.
    unsafe { JSValue::protect(ctx, result) };
    PREV.with(|p| *p.borrow_mut() = Some((new_ctx, result)));
    result
}

/// Release the deferred previous vm context and unprotect its result.
fn release_prev(ctx: JSContextRef) {
    if let Some((prev_ctx, prev_val)) = PREV.with(|p| p.borrow_mut().take()) {
        unsafe {
            JSValue::unprotect(ctx, prev_val);
            JSGlobalContextRelease(prev_ctx);
        }
    }
}

/// Copy every own enumerable property of `from_obj` (in `from_ctx`) onto
/// `to_obj` (in `to_ctx`). Used both to seed the sandbox into the new global and
/// to write results back. Built-ins (`Object`, `Array`, …) are non-enumerable on
/// the global, so they're naturally skipped.
fn copy_props(
    from_ctx: JSContextRef,
    from_obj: JSObjectRef,
    to_ctx: JSContextRef,
    to_obj: JSObjectRef,
) {
    unsafe {
        let names = JSObjectCopyPropertyNames(from_ctx, from_obj);
        let count = JSPropertyNameArrayGetCount(names);
        for i in 0..count {
            let name: JSStringRef = JSPropertyNameArrayGetNameAtIndex(names, i);
            let value = JSObjectGetProperty(from_ctx, from_obj, name, ptr::null_mut());
            JSObjectSetProperty(to_ctx, to_obj, name, value, 0, ptr::null_mut());
        }
        JSPropertyNameArrayRelease(names);
    }
}

/// Convert a Rust `&str` into a NUL-terminated buffer for the C string API.
fn c_string(s: &str) -> Vec<c_char> {
    let mut v: Vec<c_char> = s.bytes().map(|b| b as c_char).collect();
    v.push(0);
    v
}

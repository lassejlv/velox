//! Non-macOS backend: hand-written `extern "C"` bindings to JavaScriptCore's C
//! API, satisfied at link time by WebKitGTK's `libjavascriptcoregtk-4.1`
//! (linked via `build.rs` + pkg-config).
//!
//! The signatures mirror `objc2-javascript-core`'s generated C-API exactly
//! (the canonical WebKit C ABI), and the `JSValue`/`JSContext` namespace structs
//! re-create the crate's associated-function spelling so every `crate::jsc`
//! call site is source-identical across platforms.

#![allow(non_snake_case, non_upper_case_globals)]

use std::os::raw::{c_char, c_double, c_int, c_uint, c_void};

// --- Opaque handle types ---------------------------------------------------

#[repr(C)]
pub struct OpaqueJSContext {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OpaqueJSContextGroup {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OpaqueJSValue {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OpaqueJSString {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OpaqueJSClass {
    _private: [u8; 0],
}
#[repr(C)]
pub struct OpaqueJSPropertyNameArray {
    _private: [u8; 0],
}

pub type JSContextRef = *const OpaqueJSContext;
pub type JSGlobalContextRef = *mut OpaqueJSContext;
pub type JSContextGroupRef = *const OpaqueJSContextGroup;
pub type JSValueRef = *const OpaqueJSValue;
pub type JSObjectRef = *mut OpaqueJSValue;
pub type JSStringRef = *mut OpaqueJSString;
pub type JSClassRef = *mut OpaqueJSClass;
pub type JSPropertyNameArrayRef = *mut OpaqueJSPropertyNameArray;

/// UTF-16 code unit, as used by the JSString character APIs.
pub type JSChar = u16;
pub type JSPropertyAttributes = c_uint;

// --- Property attribute flags ----------------------------------------------

pub const kJSPropertyAttributeNone: c_uint = 0;
pub const kJSPropertyAttributeDontEnum: c_uint = 1 << 2;

// --- Typed-array element kind ----------------------------------------------

#[repr(transparent)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct JSTypedArrayType(pub c_uint);

impl JSTypedArrayType {
    pub const Int8Array: Self = Self(0);
    pub const Int16Array: Self = Self(1);
    pub const Int32Array: Self = Self(2);
    pub const Uint8Array: Self = Self(3);
    pub const Uint8ClampedArray: Self = Self(4);
    pub const Uint16Array: Self = Self(5);
    pub const Uint32Array: Self = Self(6);
    pub const Float32Array: Self = Self(7);
    pub const Float64Array: Self = Self(8);
    pub const ArrayBuffer: Self = Self(9);
    pub const None: Self = Self(10);
}

// --- Callback function pointer types ---------------------------------------

pub type JSObjectCallAsFunctionCallback = Option<
    unsafe extern "C-unwind" fn(
        JSContextRef,
        JSObjectRef,
        JSObjectRef,
        usize,
        *mut JSValueRef,
        *mut JSValueRef,
    ) -> JSValueRef,
>;

pub type JSTypedArrayBytesDeallocator =
    Option<unsafe extern "C-unwind" fn(*mut c_void, *mut c_void)>;

// --- Raw C-API functions (resolved against libjavascriptcoregtk) -----------

unsafe extern "C-unwind" {
    // Context lifecycle + evaluation.
    pub fn JSGlobalContextCreateInGroup(
        group: JSContextGroupRef,
        global_object_class: JSClassRef,
    ) -> JSGlobalContextRef;
    pub fn JSGlobalContextRelease(ctx: JSGlobalContextRef);
    pub fn JSGarbageCollect(ctx: JSContextRef);
    pub fn JSEvaluateScript(
        ctx: JSContextRef,
        script: JSStringRef,
        this_object: JSObjectRef,
        source_url: JSStringRef,
        starting_line_number: c_int,
        exception: *mut JSValueRef,
    ) -> JSValueRef;

    // Context globals / groups (wrapped by the JSContext namespace below).
    pub fn JSContextGetGlobalObject(ctx: JSContextRef) -> JSObjectRef;
    pub fn JSContextGetGroup(ctx: JSContextRef) -> JSContextGroupRef;

    // Value predicates / conversions / construction (wrapped by JSValue below).
    pub fn JSValueIsUndefined(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueMakeUndefined(ctx: JSContextRef) -> JSValueRef;
    pub fn JSValueMakeBoolean(ctx: JSContextRef, boolean: bool) -> JSValueRef;
    pub fn JSValueMakeNumber(ctx: JSContextRef, number: c_double) -> JSValueRef;
    pub fn JSValueMakeString(ctx: JSContextRef, string: JSStringRef) -> JSValueRef;
    pub fn JSValueToBoolean(ctx: JSContextRef, value: JSValueRef) -> bool;
    pub fn JSValueToNumber(
        ctx: JSContextRef,
        value: JSValueRef,
        exception: *mut JSValueRef,
    ) -> c_double;
    pub fn JSValueToStringCopy(
        ctx: JSContextRef,
        value: JSValueRef,
        exception: *mut JSValueRef,
    ) -> JSStringRef;
    pub fn JSValueToObject(
        ctx: JSContextRef,
        value: JSValueRef,
        exception: *mut JSValueRef,
    ) -> JSObjectRef;
    pub fn JSValueGetTypedArrayType(
        ctx: JSContextRef,
        value: JSValueRef,
        exception: *mut JSValueRef,
    ) -> JSTypedArrayType;
    pub fn JSValueProtect(ctx: JSContextRef, value: JSValueRef);
    pub fn JSValueUnprotect(ctx: JSContextRef, value: JSValueRef);

    // Objects / properties / calls.
    pub fn JSObjectMakeFunctionWithCallback(
        ctx: JSContextRef,
        name: JSStringRef,
        call_as_function: JSObjectCallAsFunctionCallback,
    ) -> JSObjectRef;
    pub fn JSObjectGetProperty(
        ctx: JSContextRef,
        object: JSObjectRef,
        property_name: JSStringRef,
        exception: *mut JSValueRef,
    ) -> JSValueRef;
    pub fn JSObjectSetProperty(
        ctx: JSContextRef,
        object: JSObjectRef,
        property_name: JSStringRef,
        value: JSValueRef,
        attributes: JSPropertyAttributes,
        exception: *mut JSValueRef,
    );
    pub fn JSObjectCallAsFunction(
        ctx: JSContextRef,
        object: JSObjectRef,
        this_object: JSObjectRef,
        argument_count: usize,
        arguments: *mut JSValueRef,
        exception: *mut JSValueRef,
    ) -> JSValueRef;
    pub fn JSObjectCopyPropertyNames(
        ctx: JSContextRef,
        object: JSObjectRef,
    ) -> JSPropertyNameArrayRef;

    // Typed arrays / array buffers.
    pub fn JSObjectMakeArrayBufferWithBytesNoCopy(
        ctx: JSContextRef,
        bytes: *mut c_void,
        byte_length: usize,
        bytes_deallocator: JSTypedArrayBytesDeallocator,
        deallocator_context: *mut c_void,
        exception: *mut JSValueRef,
    ) -> JSObjectRef;
    pub fn JSObjectMakeTypedArray(
        ctx: JSContextRef,
        array_type: JSTypedArrayType,
        length: usize,
        exception: *mut JSValueRef,
    ) -> JSObjectRef;
    pub fn JSObjectGetTypedArrayBytesPtr(
        ctx: JSContextRef,
        object: JSObjectRef,
        exception: *mut JSValueRef,
    ) -> *mut c_void;
    pub fn JSObjectGetTypedArrayLength(
        ctx: JSContextRef,
        object: JSObjectRef,
        exception: *mut JSValueRef,
    ) -> usize;
    pub fn JSObjectGetTypedArrayByteOffset(
        ctx: JSContextRef,
        object: JSObjectRef,
        exception: *mut JSValueRef,
    ) -> usize;

    // Property-name enumeration.
    pub fn JSPropertyNameArrayGetCount(array: JSPropertyNameArrayRef) -> usize;
    pub fn JSPropertyNameArrayGetNameAtIndex(
        array: JSPropertyNameArrayRef,
        index: usize,
    ) -> JSStringRef;
    pub fn JSPropertyNameArrayRelease(array: JSPropertyNameArrayRef);

    // Strings.
    pub fn JSStringCreateWithUTF8CString(string: *const c_char) -> JSStringRef;
    pub fn JSStringCreateWithCharacters(chars: *const JSChar, num_chars: usize) -> JSStringRef;
    pub fn JSStringGetCharactersPtr(string: JSStringRef) -> *const JSChar;
    pub fn JSStringGetLength(string: JSStringRef) -> usize;
    pub fn JSStringGetMaximumUTF8CStringSize(string: JSStringRef) -> usize;
    pub fn JSStringGetUTF8CString(
        string: JSStringRef,
        buffer: *mut c_char,
        buffer_size: usize,
    ) -> usize;
    pub fn JSStringRelease(string: JSStringRef);
}

// --- Namespace structs: mirror the crate's C-API associated functions -------

/// C-API value operations, namespaced like `objc2-javascript-core`'s `JSValue`.
pub struct JSValue;

impl JSValue {
    #[inline]
    pub unsafe fn new_undefined(ctx: JSContextRef) -> JSValueRef {
        unsafe { JSValueMakeUndefined(ctx) }
    }
    #[inline]
    pub unsafe fn new_boolean(ctx: JSContextRef, boolean: bool) -> JSValueRef {
        unsafe { JSValueMakeBoolean(ctx, boolean) }
    }
    #[inline]
    pub unsafe fn new_number(ctx: JSContextRef, number: c_double) -> JSValueRef {
        unsafe { JSValueMakeNumber(ctx, number) }
    }
    #[inline]
    pub unsafe fn new_string(ctx: JSContextRef, string: JSStringRef) -> JSValueRef {
        unsafe { JSValueMakeString(ctx, string) }
    }
    #[inline]
    pub unsafe fn is_undefined(ctx: JSContextRef, value: JSValueRef) -> bool {
        unsafe { JSValueIsUndefined(ctx, value) }
    }
    #[inline]
    pub unsafe fn to_boolean(ctx: JSContextRef, value: JSValueRef) -> bool {
        unsafe { JSValueToBoolean(ctx, value) }
    }
    #[inline]
    pub unsafe fn to_number(
        ctx: JSContextRef,
        value: JSValueRef,
        exception: *mut JSValueRef,
    ) -> c_double {
        unsafe { JSValueToNumber(ctx, value, exception) }
    }
    #[inline]
    pub unsafe fn to_string_copy(
        ctx: JSContextRef,
        value: JSValueRef,
        exception: *mut JSValueRef,
    ) -> JSStringRef {
        unsafe { JSValueToStringCopy(ctx, value, exception) }
    }
    #[inline]
    pub unsafe fn to_object(
        ctx: JSContextRef,
        value: JSValueRef,
        exception: *mut JSValueRef,
    ) -> JSObjectRef {
        unsafe { JSValueToObject(ctx, value, exception) }
    }
    #[inline]
    pub unsafe fn typed_array_type(
        ctx: JSContextRef,
        value: JSValueRef,
        exception: *mut JSValueRef,
    ) -> JSTypedArrayType {
        unsafe { JSValueGetTypedArrayType(ctx, value, exception) }
    }
    #[inline]
    pub unsafe fn protect(ctx: JSContextRef, value: JSValueRef) {
        unsafe { JSValueProtect(ctx, value) }
    }
    #[inline]
    pub unsafe fn unprotect(ctx: JSContextRef, value: JSValueRef) {
        unsafe { JSValueUnprotect(ctx, value) }
    }
}

/// C-API context operations, namespaced like `objc2-javascript-core`'s `JSContext`.
pub struct JSContext;

impl JSContext {
    #[inline]
    pub unsafe fn global_object(ctx: JSContextRef) -> JSObjectRef {
        unsafe { JSContextGetGlobalObject(ctx) }
    }
    #[inline]
    pub unsafe fn group(ctx: JSContextRef) -> JSContextGroupRef {
        unsafe { JSContextGetGroup(ctx) }
    }
}

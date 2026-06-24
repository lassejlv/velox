//! macOS backend: re-export the JavaScriptCore C-API surface velox uses from
//! `objc2-javascript-core` (which links Apple's `JavaScriptCore.framework`).
//!
//! This is the complete union of symbols imported across the crate. The
//! `JSContext`/`JSValue` names here are used only for their C-API *associated
//! functions* (`JSValue::new_undefined(ctx)`, `JSContext::global_object(ctx)`,
//! …) — the same calls the Linux backend mirrors by hand.
//!
//! A few names (e.g. `JSContextGroupRef`, `JSPropertyNameArrayRef`) are exposed
//! for facade symmetry with the Linux backend even when macOS call sites only
//! use them inline, hence allow(unused_imports).
#![allow(unused_imports)]

pub use objc2_javascript_core::{
    // Namespace structs (C-API associated functions live here).
    JSContext,
    // Opaque handle types.
    JSContextGroupRef,
    JSContextRef,
    // Context lifecycle + evaluation.
    JSEvaluateScript,
    JSGarbageCollect,
    JSGlobalContextCreateInGroup,
    JSGlobalContextRef,
    JSGlobalContextRelease,
    // Objects / properties / calls.
    JSObjectCallAsFunction,
    JSObjectCopyPropertyNames,
    JSObjectGetProperty,
    // Typed arrays / array buffers.
    JSObjectGetTypedArrayByteOffset,
    JSObjectGetTypedArrayBytesPtr,
    JSObjectGetTypedArrayLength,
    JSObjectMakeArrayBufferWithBytesNoCopy,
    JSObjectMakeFunctionWithCallback,
    JSObjectMakeTypedArray,
    JSObjectRef,
    JSObjectSetProperty,
    // Property name enumeration.
    JSPropertyNameArrayGetCount,
    JSPropertyNameArrayGetNameAtIndex,
    JSPropertyNameArrayRef,
    JSPropertyNameArrayRelease,
    // Strings.
    JSStringCreateWithCharacters,
    JSStringCreateWithUTF8CString,
    JSStringGetCharactersPtr,
    JSStringGetLength,
    JSStringGetMaximumUTF8CStringSize,
    JSStringGetUTF8CString,
    JSStringRef,
    JSStringRelease,
    // Typed-array element kind.
    JSTypedArrayType,
    JSValue,
    JSValueRef,
    // Property attribute flags.
    kJSPropertyAttributeDontEnum,
};

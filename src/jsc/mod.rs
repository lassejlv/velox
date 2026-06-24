//! Platform-neutral JavaScriptCore **C-API** facade.
//!
//! velox talks to JavaScriptCore exclusively through its C API (`JSContextRef`,
//! `JSValueRef`, `JSEvaluateScript`, …), which is byte-for-byte identical on
//! every platform JSC ships on. The *binding* of that API differs:
//!
//! - **macOS**: re-export the relevant symbols from the `objc2-javascript-core`
//!   crate, which links Apple's `JavaScriptCore.framework`.
//! - **Linux (and other non-macOS)**: our own hand-written `extern "C"`
//!   declarations over WebKitGTK's `libjavascriptcoregtk-4.1` (linked by
//!   `build.rs` via pkg-config).
//!
//! Both backends expose the *same* names, so the rest of velox imports only
//! from `crate::jsc` and never names the platform directly. The Objective-C
//! *object* API (`JSContext`/`JSValue` classes, `NSString`/`NSURL`) — which is
//! Apple-only and absent from WebKitGTK — is deliberately not part of this
//! facade; `runtime.rs` uses the C API instead.

#[cfg(target_os = "macos")]
mod mac;
#[cfg(target_os = "macos")]
pub use mac::*;

#[cfg(not(target_os = "macos"))]
mod linux;
#[cfg(not(target_os = "macos"))]
pub use linux::*;

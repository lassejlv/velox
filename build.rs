//! Build script.
//!
//! On macOS, JavaScriptCore is linked via the `objc2-javascript-core` crate
//! (Apple framework), so there is nothing to do here.
//!
//! On other platforms (Linux, …), velox links the JavaScriptCore **C API**
//! provided by WebKitGTK's `libjavascriptcoregtk`. We locate it with
//! pkg-config — preferring the 4.1 API series, falling back to 4.0 — and emit
//! the `cargo:rustc-link-*` directives that satisfy the `extern "C"` symbols in
//! `src/jsc/linux.rs`.
//!
//! On Debian/Ubuntu install the dev package first:
//!     sudo apt-get install -y libjavascriptcoregtk-4.1-dev pkg-config
//! (or `libjavascriptcoregtk-4.0-dev` on older distros).

fn main() {
    #[cfg(not(target_os = "macos"))]
    {
        let probe = pkg_config::Config::new()
            .atleast_version("2.0")
            .probe("javascriptcoregtk-4.1")
            .or_else(|_| pkg_config::Config::new().probe("javascriptcoregtk-4.0"));

        match probe {
            Ok(_) => {
                // pkg-config already emitted cargo:rustc-link-search / -link-lib.
            }
            Err(e) => {
                // Fall back to a bare link directive so the build can still
                // succeed if the library is present but pkg-config metadata is
                // not (e.g. a custom WebKitGTK install on the linker path).
                println!(
                    "cargo:warning=pkg-config could not find javascriptcoregtk-4.1/4.0 ({e}); \
                     falling back to -ljavascriptcoregtk-4.1. Install \
                     libjavascriptcoregtk-4.1-dev (or -4.0-dev) if linking fails."
                );
                println!("cargo:rustc-link-lib=javascriptcoregtk-4.1");
            }
        }
    }
}

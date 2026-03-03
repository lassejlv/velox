//! Graceful shutdown handling for Velox runtime
//!
//! Provides a global shutdown flag that can be checked by the event loop,
//! HTTP server, and other long-running operations.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

/// Global flag indicating shutdown has been requested
static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);

/// Ensures signal handler is only registered once
static INIT: Once = Once::new();

/// Initialize the signal handler for graceful shutdown.
/// This should be called once at startup.
pub fn init() {
    INIT.call_once(|| {
        if let Err(e) = ctrlc::set_handler(move || {
            // First Ctrl+C: request graceful shutdown
            if !SHUTDOWN_REQUESTED.swap(true, Ordering::SeqCst) {
                eprintln!("\nShutting down gracefully... (press Ctrl+C again to force quit)");
            } else {
                // Second Ctrl+C: force exit
                eprintln!("\nForce quitting...");
                std::process::exit(130); // 128 + SIGINT(2)
            }
        }) {
            eprintln!("Warning: Failed to set up signal handler: {}", e);
        }
    });
}

/// Check if shutdown has been requested
#[inline]
pub fn is_shutdown_requested() -> bool {
    SHUTDOWN_REQUESTED.load(Ordering::SeqCst)
}

/// Request shutdown programmatically (e.g., from Velox.exit())
pub fn request_shutdown() {
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
}

/// Reset shutdown flag (useful for tests or REPL restart)
#[cfg(test)]
#[allow(dead_code)]
pub fn reset() {
    SHUTDOWN_REQUESTED.store(false, Ordering::SeqCst);
}

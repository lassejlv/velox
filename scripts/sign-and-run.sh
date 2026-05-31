#!/bin/sh
# Cargo `runner`: ad-hoc code-sign the binary with the JIT entitlement (so
# JavaScriptCore can allocate executable memory on Apple Silicon — ~9x faster
# CPU), then exec it. Used automatically by `cargo run`/`cargo test`.
bin="$1"; shift
codesign --force --entitlements "$(dirname "$0")/../velox.entitlements" --sign - "$bin" >/dev/null 2>&1
exec "$bin" "$@"

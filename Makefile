# velox build helpers. On Apple Silicon the binary must be code-signed with the
# JIT entitlement (velox.entitlements) so JavaScriptCore's JIT is enabled —
# otherwise it falls back to the interpreter (~9x slower CPU). `cargo run`/`test`
# sign automatically via scripts/sign-and-run.sh; these targets sign the
# standalone binary for distribution/install.

ENTITLEMENTS := velox.entitlements
SIGN := codesign --force --entitlements $(ENTITLEMENTS) --sign -
PREFIX ?= $(HOME)/.cargo/bin

.PHONY: release install fmt clippy test bench

# Optimized, JIT-enabled (signed) release binary at target/release/velox.
release:
	cargo build --release
	$(SIGN) target/release/velox
	@echo "✓ target/release/velox built + signed (JIT enabled)"

# Install the signed binary to $(PREFIX) (default ~/.cargo/bin). Note: a plain
# `cargo install` would strip the signature and disable the JIT, so we copy +
# sign in place instead.
install: release
	@mkdir -p $(PREFIX)
	install -m 755 target/release/velox $(PREFIX)/velox
	$(SIGN) $(PREFIX)/velox
	@echo "✓ installed velox to $(PREFIX)/velox (JIT enabled)"

fmt:
	cargo fmt

clippy:
	cargo clippy

test:
	cargo test

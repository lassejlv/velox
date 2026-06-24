# velox build helpers. On Apple Silicon macOS the binary must be code-signed with
# the JIT entitlement (velox.entitlements) so JavaScriptCore's JIT is enabled —
# otherwise it falls back to the interpreter (~9x slower CPU). `cargo run`/`test`
# sign automatically via scripts/sign-and-run.sh; these targets sign the
# standalone binary for distribution/install.
#
# On Linux (WebKitGTK's JavaScriptCore) the JIT works with no code-signing, so
# the sign step is skipped automatically — `make release`/`install` just build
# and copy. Requires libjavascriptcoregtk-4.1-dev + pkg-config (see build.rs).

UNAME := $(shell uname)
ENTITLEMENTS := velox.entitlements
PREFIX ?= $(HOME)/.cargo/bin

# `codesign` only exists / is needed on macOS; elsewhere SIGN is a no-op (`true`).
ifeq ($(UNAME),Darwin)
SIGN := codesign --force --entitlements $(ENTITLEMENTS) --sign -
else
SIGN := true
endif

.PHONY: release install fmt clippy test bench

# Optimized release binary at target/release/velox (JIT-enabled; signed on macOS).
release:
	cargo build --release
	$(SIGN) target/release/velox
	@echo "✓ target/release/velox built (JIT enabled)"

# Install the binary to $(PREFIX) (default ~/.cargo/bin). Note: on macOS a plain
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

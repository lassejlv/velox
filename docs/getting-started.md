# Getting started

[Docs home](README.md) · **Getting started** · [Next: Usage →](usage.md)

## Requirements

- **macOS** (system JavaScriptCore)
- **Rust** toolchain for building from source

## Install

```sh
# Recommended: optimized + JIT-signed binary
make install

# Build only (target/release/velox)
make release

# Development (auto-signed on each run)
cargo run -- examples/hello.ts
```

Prebuilt install (when a GitHub release exists):

```sh
curl -fsSL https://raw.githubusercontent.com/<owner>/velox/main/install.sh | sh
```

## First run

```sh
velox examples/hello.ts
# or during development:
cargo run -- examples/hello.ts
```

Try the REPL:

```sh
velox
# .help  .clear  .exit  (or Ctrl-D)
```

## JIT and code signing

On Apple Silicon, JavaScriptCore's JIT only works when the binary is code-signed with the `com.apple.security.cs.allow-jit` entitlement (`velox.entitlements`).

| How you run | JIT |
|-------------|-----|
| `make install` / `make release` | ✅ signed |
| `cargo run` / `cargo test` | ✅ signed via `scripts/sign-and-run.sh` |
| Plain `cargo install` | ❌ signature stripped → interpreter (~9× slower CPU) |

Always build through `make` for production binaries.

## Performance

Signed, JIT-enabled benchmarks on Apple Silicon (indicative):

| | velox | Node |
|---|---|---|
| Cold start | ~7 ms | ~17 ms |
| HTTP (1 route) | ~34k req/s | comparable |
| CPU `fib(32)×5` | ~40 ms | ~63 ms |

Throughput comes from a single kqueue reactor (no per-connection threads).

---

[← Docs home](README.md) · [Next: Usage →](usage.md)

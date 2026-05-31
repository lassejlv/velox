# Contributing

[← Limitations](limitations.md) · [Docs home](README.md) · **Contributing**

## Build

```sh
cargo build
cargo run -- examples/hello.ts
make release          # optimized + signed
make install          # install to ~/.cargo/bin
make fmt / make clippy / make test
```

## Testing

### Rust unit tests

```sh
cargo test
```

Module resolution and bundler rewriting (`src/module.rs`).

### Full suite (CI)

```sh
./scripts/test-all.sh
```

Runs:

1. `cargo test`
2. All seven `node-compat-*` suites + `url-conformance.ts`
3. Smoke examples: hello, async, timers, crypto-stream, velox-global, commonjs-demo, node-modules-demo, worker-threads, shared-memory, websocket, rsa-keygen, fs-demo

### Node.js upstream tests (optional)

```sh
./scripts/node-test.sh                 # curated subset (CI)
./scripts/node-test.sh --match buffer  # filter by name
./scripts/node-test.sh test-path-join  # single test
```

Fetches files from Node's `test/parallel` on demand. Many tests require Node internals and are reported as unrunnable — not failures.

### Manual compat run

```sh
cargo run -- examples/node-compat-core.ts
```

## Adding a Node builtin

1. Write `src/builtins/<name>.js` (CommonJS; may `require('node:other')`).
2. Add native `__velox_*` hooks in the relevant `*.rs` if host access is needed.
3. Register in `BUILTINS` in [`src/node.rs`](../src/node.rs).

Full checklist: [`CLAUDE.md`](../CLAUDE.md).

## Safety rules (Rust ↔ JS)

- GC-protect timer/I/O callbacks; unprotect exactly once when done.
- Don't hold `RefCell` borrows across JS re-entry in reactor handlers.
- Native callbacks use `extern "C-unwind"`; guard raw pointers with `arg_slice`.

## Project docs

| Doc | Purpose |
|-----|---------|
| [Architecture](architecture.md) | Pipeline overview |
| [CLAUDE.md](../CLAUDE.md) | Deep contributor / agent reference |
| [Examples](examples.md) | What to run after changes |

---

[← Limitations](limitations.md) · [Docs home](README.md) · [Project README](../README.md)

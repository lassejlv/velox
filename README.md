# velox

A small TypeScript/JavaScript runtime for macOS — Rust + [JavaScriptCore](https://developer.apple.com/documentation/javascriptcore) + [oxc](https://oxc.rs).

Run `.ts`/`.tsx`/`.js`/`.jsx` with imports, top-level `await`, `fetch`, timers, and partial Node.js compatibility.

**Requirements:** macOS only.

## Install

```sh
make install          # build, sign (JIT), install to ~/.cargo/bin
make release          # signed binary at target/release/velox
cargo run -- examples/hello.ts   # dev (auto-signed via cargo runner)
```

Use `make`, not plain `cargo install` — Apple Silicon needs a JIT entitlement signature or CPU work runs ~9× slower. See [Getting started → JIT signing](docs/getting-started.md#jit-and-code-signing).

## Quick start

```sh
velox init my-app                   # scaffold a new project
velox app.ts                        # run a file
velox -e 'console.log("hi")'        # inline eval
velox                               # REPL

cargo run -- examples/http-server.ts
curl localhost:3000
```

`velox init [dir]` lays down `src/main.ts`, `package.json`, `tsconfig.json`, a
copy of `velox.d.ts`, and `.gitignore`, then installs `@types/node` (so
`node:*` imports type-check). Pass `--no-install` to skip npm.

## Documentation

| | |
|---|---|
| [Docs home](docs/README.md) | Table of contents |
| [Getting started](docs/getting-started.md) | Install, first run, performance |
| [Usage](docs/usage.md) | CLI, REPL, flags |
| [Examples](docs/examples.md) | Example scripts catalog |
| [Architecture](docs/architecture.md) | How velox works |
| [Node compatibility](docs/node-compatibility.md) | APIs, npm, `Velox` global |
| [Limitations](docs/limitations.md) | Known gaps |
| [Contributing](docs/contributing.md) | Build, test, add builtins |

TypeScript types for the built-in `Velox` API: [`velox.d.ts`](velox.d.ts).

## Test

```sh
cargo test
./scripts/test-all.sh
```

Details: [Contributing → Testing](docs/contributing.md#testing).

# velox

A small TypeScript/JavaScript runtime — Rust + [JavaScriptCore](https://developer.apple.com/documentation/javascriptcore) + [oxc](https://oxc.rs).

Run `.ts`/`.tsx`/`.js`/`.jsx` with imports, top-level `await`, `fetch`, timers, and partial Node.js compatibility.

**Platforms:** macOS (Apple's JavaScriptCore framework) and Linux (WebKitGTK's `libjavascriptcoregtk`). The JavaScriptCore C API is identical across both; the platform-specific linking lives behind `src/jsc/`.

## Install

### macOS

```sh
make install          # build, sign (JIT), install to ~/.cargo/bin
make release          # signed binary at target/release/velox
cargo run -- examples/hello.ts   # dev (auto-signed via cargo runner)
```

Use `make`, not plain `cargo install` — Apple Silicon needs a JIT entitlement signature or CPU work runs ~9× slower. See [Getting started → JIT signing](docs/getting-started.md#jit-and-code-signing).

### Linux

Install JavaScriptCore (WebKitGTK) + pkg-config first, then build normally — no
code-signing is needed (WebKitGTK's JIT works unsigned):

```sh
sudo apt-get install -y libjavascriptcoregtk-4.1-dev pkg-config   # or -4.0-dev on older distros
make install          # build + install to ~/.cargo/bin (sign step auto-skipped)
cargo run -- examples/hello.ts
```

A reproducible Linux build/smoke check lives in `Dockerfile.linux`
(`docker build -f Dockerfile.linux -t velox-linux .`).

## Quick start

```sh
velox init my-app                   # scaffold a new project
velox app.ts                        # run a file
velox -e 'console.log("hi")'        # inline eval
velox                               # REPL

cargo run -- examples/http-server.ts
curl localhost:3000
```

A script whose `export default` is a server object (`{ port?, fetch }`) or a web
app with a `.fetch` (Hono, Elysia, …) is **served automatically** — Bun-style,
no `Velox.serve(...)` needed (see [`examples/serve-default.ts`](examples/serve-default.ts)):

```ts
import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.text("hi"));
export default app;            // velox app.ts → http://localhost:3000
```

`velox init [dir]` lays down `src/main.ts`, `package.json`, `tsconfig.json`, a
copy of `velox.d.ts`, and `.gitignore`, then installs `@types/node` with velox's
own package manager (so `node:*` imports type-check). Pass `--no-install` to
skip it.

## Packages

velox has a built-in package manager that speaks the npm registry directly — no
npm required — and installs into `node_modules` so bundled `import`/`require`
finds them:

```sh
velox add express              # add + install (pins ^version)
velox add -D vitest            # save to devDependencies
velox add lodash@4.17.21       # a specific version or range
velox install                  # install (from velox.lock if present)
velox remove express           # uninstall
```

It resolves the full dependency graph (semver ranges, dist-tags) with parallel
metadata + downloads, verifies each tarball's `sha512`/`sha1` integrity, and
writes a YAML `velox.lock`. Tarballs and metadata are kept in a **global cache**
(`~/.velox/cache`, or `$VELOX_CACHE`) shared across projects, so repeat installs
are near-instant and offline-friendly. There's also `velox update`, `outdated`,
npm/pnpm **workspaces**, and `velox x <pkg>` (npx-style). Set `$VELOX_REGISTRY`
for a private registry.

## Compile

```sh
velox build app.ts        # → ./app — a single self-contained, JIT-enabled binary
./app                     # no velox / Node / node_modules needed
```

## Performance

The same **Express 4** app served by each runtime, `wrk -t8 -c200 -d15s`,
`GET /json`, on Apple Silicon (10 cores):

| Runtime | Req/sec | Latency avg | Latency p99 | Idle RSS | Peak RSS |
|---------|--------:|--------:|--------:|---------:|---------:|
| Bun 1.4 | **106,800** | **1.9 ms** | 3.3 ms | 44 MB | 142 MB |
| **velox 0.1** | 89,700 | 2.2 ms | **3.2 ms** | **39 MB** | **109 MB** |
| Node 24 | 72,200 | 3.2 ms | 3.7 ms | 62 MB | 145 MB |
| Deno 2.8 | 56,800 | 3.7 ms | ~9 ms | 69 MB | 201 MB |

Bun (also JavaScriptCore, with a native HTTP server) leads on throughput; velox
is a strong second — **~25% faster than Node**, ~58% faster than Deno — and uses
the **least memory of all four**. Reproduce or try other workloads with
[`benchmarks/express`](benchmarks/express). (Numbers vary by hardware/OS;
requires a signed release build for JIT.)

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

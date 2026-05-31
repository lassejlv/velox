# Examples

[← Usage](usage.md) · [Docs home](README.md) · **Examples** · [Next: Architecture →](architecture.md)

All examples live in [`examples/`](../examples/). Run with:

```sh
cargo run -- examples/<name>.ts
# or, if installed:
velox examples/<name>.ts
```

## Start here

| Example | What it shows |
|---------|----------------|
| [`hello.ts`](../examples/hello.ts) | TypeScript basics, `console` |
| [`timers.ts`](../examples/timers.ts) | `setTimeout` / `setInterval`, event loop |
| [`async.ts`](../examples/async.ts) | Top-level `await`, `fetch` |
| [`modules/main.ts`](../examples/modules/main.ts) | Relative ES modules |
| [`http-server.ts`](../examples/http-server.ts) | HTTP server — `curl localhost:3000` |
| [`node-modules-demo.ts`](../examples/node-modules-demo.ts) | npm ESM packages |
| [`commonjs-demo.ts`](../examples/commonjs-demo.ts) | CommonJS packages, CJS↔ESM |
| [`velox-global.ts`](../examples/velox-global.ts) | `Velox.serve`, file helpers, no imports |

## More demos

| Example | What it shows |
|---------|----------------|
| [`http-client.ts`](../examples/http-client.ts) | HTTP client |
| [`https-client.ts`](../examples/https-client.ts) | HTTPS + TLS |
| [`https-server.ts`](../examples/https-server.ts) | HTTPS server |
| [`crypto-stream.ts`](../examples/crypto-stream.ts) | crypto, zlib, streams |
| [`websocket.ts`](../examples/websocket.ts) | WebSocket server + client |
| [`udp.ts`](../examples/udp.ts) | UDP / `node:dgram` |
| [`worker-threads.ts`](../examples/worker-threads.ts) | Multi-threaded workers |
| [`shared-memory.ts`](../examples/shared-memory.ts) | `SharedArrayBuffer`, `Atomics` |
| [`rsa-keygen.ts`](../examples/rsa-keygen.ts) | RSA keygen, RS256 sign/verify |
| [`fs-demo.ts`](../examples/fs-demo.ts) | File system API |
| [`url-conformance.ts`](../examples/url-conformance.ts) | WHATWG URL tests (48 cases) |

## Node compatibility suites

Regression probes (~221 checks). Each exits non-zero on failure:

| Suite | Coverage |
|-------|----------|
| [`node-compat-core.ts`](../examples/node-compat-core.ts) | path, os, fs, Buffer, crypto, streams |
| [`node-compat-io.ts`](../examples/node-compat-io.ts) | modules, zlib, net, http, child_process |
| [`node-compat-modern.ts`](../examples/node-compat-modern.ts) | Promise, AbortSignal, web crypto, timers |
| [`node-compat-extra.ts`](../examples/node-compat-extra.ts) | console, fs fds, Buffer numerics, keys |
| [`node-compat-web.ts`](../examples/node-compat-web.ts) | URL, fetch, Headers, Request/Response |
| [`node-compat-platform.ts`](../examples/node-compat-platform.ts) | EventTarget, perf_hooks, vm, streams |
| [`node-compat-stdlib.ts`](../examples/node-compat-stdlib.ts) | fork/IPC, async fs, dgram, WebSocket |

Run all gated examples: [`scripts/test-all.sh`](../scripts/test-all.sh) — see [Contributing → Testing](contributing.md#testing).

---

[← Usage](usage.md) · [Next: Architecture →](architecture.md)

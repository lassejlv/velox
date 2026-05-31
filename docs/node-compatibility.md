# Node compatibility

[← Architecture](architecture.md) · [Docs home](README.md) · **Node compatibility** · [Next: Limitations →](limitations.md)

velox is **not** Node.js — but it ships enough of the surface to run many real npm packages and scripts.

## The `Velox` global

Import-free API installed as `globalThis.Velox`:

```ts
// Web-style server
Velox.serve({
  port: 3000,
  fetch(req) {
    return Response.json({ path: new URL(req.url).pathname });
  },
});

// File helpers
Velox.writeTextSync("out.txt", "hello");
console.log(Velox.readTextSync("out.txt"));

// Lazy node: builtins
Velox.crypto.randomUUID();
Velox.path.join("/a", "b");
```

Also: `Velox.env`, `Velox.args`, `Velox.cwd()`, `Velox.exit()`, `Velox.fetch()`, and `Velox(port, handler)` shorthand.

Types: [`velox.d.ts`](../velox.d.ts). Example: [`examples/velox-global.ts`](../examples/velox-global.ts).

## Globals

Available without importing:

| Category | APIs |
|----------|------|
| Process | `process`, `Buffer`, `global` |
| Web | `fetch`, `Request`, `Response`, `Headers`, `Blob`, `FormData`, `URL`, `URLSearchParams` |
| Async | `Promise`, top-level `await`, `queueMicrotask`, `setImmediate` |
| Timers | `setTimeout` / `setInterval` with `ref()` / `unref()` handles |
| Crypto | `crypto` (Web Crypto subset + `node:crypto` shim) |
| Other | `structuredClone`, `AbortController`, `performance`, `atob`/`btoa`, `WebSocket`, `SharedArrayBuffer`, `Atomics` |

## `node:` builtins

Loaded via `import`, `require('node:fs')`, or `Velox.fs` lazy getters:

`fs`, `path`, `http`, `https`, `net`, `tls`, `dgram`, `crypto`, `stream`, `zlib`, `dns`, `child_process`, `worker_threads`, `url`, `util`, `os`, `events`, `buffer`, `assert`, `querystring`, `string_decoder`, `timers`, `process`, `vm`, `async_hooks`, `perf_hooks`, `diagnostics_channel`, `module`, `readline`, `tty`, `ws`

Subpaths: `fs/promises`, `dns/promises`, `timers/promises`, `stream/promises`

`node:http2` is a **stub** (loads frameworks that import it; server factories throw if called).

## npm packages

The bundler resolves:

- Relative imports and `node_modules` (scoped packages, subpaths)
- CommonJS `require()` call graphs (transitive)
- Simple `package.json` `exports` / `main` / `index` resolution
- `.json` modules, `.cjs` / `.mjs`

Known to run: Express, Fastify, Hono, lodash, zod, chalk, commander, dotenv, pino, and others.

Probe suites: [Examples → Node compatibility](examples.md#node-compatibility-suites).

## Frameworks & I/O

- **HTTP/HTTPS** servers and clients (keep-alive, streaming TLS via rustls)
- **WebSockets** (RFC 6455) — `ws` shim + `Velox.serve({ websocket })`
- **UDP** — `node:dgram`
- **Workers** — real OS threads, `SharedArrayBuffer` across threads
- **child_process** — spawn/exec/fork with IPC channel

Details and gaps: [Limitations](limitations.md).

---

[← Architecture](architecture.md) · [Next: Limitations →](limitations.md)

# Architecture

[← Examples](examples.md) · [Docs home](README.md) · **Architecture** · [Next: Node compatibility →](node-compatibility.md)

## Pipeline

When you run `velox app.ts`:

```
app.ts  →  transpile  →  bundle  →  eval preludes  →  eval bundle  →  event loop
```

1. **Transpile** ([`src/transpile.rs`](../src/transpile.rs)) — oxc parses TS/JSX, strips types, lowers JSX.
2. **Bundle** ([`src/module.rs`](../src/module.rs)) — resolves imports and literal `require()` graphs, rewrites ESM → CommonJS registry, emits one script.
3. **Execute** ([`src/runtime.rs`](../src/runtime.rs)) — evaluates preludes + bundle in a `JSContext`; native hooks via the JSC C API.
4. **Event loop** ([`src/event_loop.rs`](../src/event_loop.rs)) — timer heap + `mio` kqueue poll until idle.

## Source layout

| Area | Files | Role |
|------|-------|------|
| Entry | `main.rs`, `repl.rs`, `ui.rs` | CLI, REPL, errors |
| Compile | `transpile.rs`, `module.rs` | TS → JS, bundler |
| Runtime | `runtime.rs`, `inspect.rs` | JSC context, `console` |
| I/O | `event_loop.rs`, `fetch.rs`, `server.rs`, `udp.rs`, `sys.rs` | Timers, HTTP(S), TCP, UDP, fs async, DNS, child_process |
| Node | `node.rs`, `builtins/*.js` | Native hooks + JS shims |
| Extra | `crypto.rs`, `worker.rs`, `shared.rs`, `vm.rs` | Crypto, workers, SAB, sandboxes |

## Native ↔ JS convention

1. Register a native function in Rust (`__velox_*` via JSC C API).
2. Call it from a JS shim in [`src/builtins/`](../src/builtins/) or a startup prelude.
3. Binary data crosses as **latin1 strings** (`js_string_latin1` / `js_value_to_latin1`).

The [`Velox` global](../src/builtins/velox.js) is evaluated **last** — it depends on `fetch`, `Buffer`, `Request`/`Response`, and the builtin loader.

## Event loop

One kqueue reactor handles:

- Timers (`setTimeout` / `setInterval`) in a binary min-heap
- Socket I/O for `fetch`, `http`/`net`/`tls`, UDP
- Worker-thread wakeups (DNS, async fs, child_process) via `mio::Waker`

Timer and I/O callbacks are GC-protected; the loop exits when nothing ref'd remains in flight.

## Bundler notes

JavaScriptCore rejects raw ESM syntax, so the bundler emits a CommonJS-style module registry with **async** wrappers (enabling top-level `await`).

See [Limitations → Modules](limitations.md#modules) for cycle and dynamic-`require` edge cases.

## Deeper reference

Contributor-oriented detail: [`CLAUDE.md`](../CLAUDE.md) (pipeline, invariants, adding builtins).

---

[← Examples](examples.md) · [Next: Node compatibility →](node-compatibility.md)

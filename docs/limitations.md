# Limitations

[← Node compatibility](node-compatibility.md) · [Docs home](README.md) · **Limitations** · [Next: Contributing →](contributing.md)

Honest gaps — check here before assuming full Node or browser parity.

## Platform

- **macOS only** — uses system JavaScriptCore and kqueue.
- **JIT requires signing** — unsigned binaries use the JSC interpreter (~9× slower CPU). See [Getting started → JIT](getting-started.md#jit-and-code-signing).

## Modules

- Only simple `package.json` `exports` shapes.
- Dynamic `require(expr)` with a non-literal argument is **not bundled** (runtime builtin fallback).
- Import **cycles** through named bindings may see `undefined` (namespace imports are safer).
- Top-level `await` in a non-entry module isn't awaited by its importers.

## fetch

- No redirect following, keep-alive, or full browser semantics yet.
- One worker thread per DNS lookup (socket I/O is async on kqueue).

## Node shims (partial)

| Area | Notes |
|------|-------|
| **crypto** | Ed25519, ECDSA P-256, RSA sign/verify, ECDH, keygen; ring won't sign RSA &lt; 2048 bits |
| **fs** | Async ops off-thread; FDs are synthetic (read-modify-write on path); `watch` polls |
| **http2** | Stub only — don't call server factories |
| **worker_threads** | Messages are JSON; `SharedArrayBuffer` **does** share real memory across threads |
| **async_hooks** | `AsyncLocalStorage` does **not** propagate across bare `await` — use `AsyncResource.bind` / `snapshot()` |
| **vm** | Real separate `JSContext`; host globals unreachable in sandbox |
| **Atomics.wait** | Exists but doesn't block cross-thread |

## REPL

- Each line is a separate script — **no top-level `await`**.
- `let` / `const` don't persist between lines; use `var` or `globalThis`.

## What's next

See [Architecture](architecture.md) for where to extend the runtime, and [Contributing](contributing.md) for how to validate changes.

---

[← Node compatibility](node-compatibility.md) · [Next: Contributing →](contributing.md)

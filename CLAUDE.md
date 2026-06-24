# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

velox is a TypeScript/JavaScript runtime in Rust, cross-platform (macOS +
Linux). oxc transpiles & bundles TS/JSX → JS, then JavaScriptCore's **C API**
executes it. The C API is identical on every platform; only the linking differs
and is hidden behind `src/jsc/`: on macOS it re-exports `objc2-javascript-core`
(Apple's JavaScriptCore.framework); on Linux it uses hand-written `extern "C"`
bindings (`src/jsc/linux.rs`) linked against WebKitGTK's `libjavascriptcoregtk`
by `build.rs` (pkg-config). The rest of the codebase imports only from
`crate::jsc`, never naming the platform. A `mio` event loop (kqueue on macOS,
epoll on Linux — `mio` selects automatically) drives timers and async I/O. It
ships a partial Node.js standard library so real npm packages run.

## Commands

```sh
cargo run -- examples/hello.ts     # run a file (.ts/.tsx/.js/.jsx)
cargo run                          # REPL (supports top-level await)
cargo run -- examples/http-server.ts   # then: curl localhost:3000
cargo run -- test                  # built-in test runner (--coverage, -w, -u, -t)
cargo run -- bench                 # built-in benchmark runner
cargo build / cargo clippy / cargo fmt / cargo test
```

`examples/*.ts` are the smoke tests; `cargo test` runs the `module.rs` unit
tests (resolution/rewriting). Verify changes by running the examples.

The runtime also has a built-in **test runner** (`velox test` — describe/it/
expect, vi mocks/spies, inline + file snapshots, `--coverage` with branch
coverage + threshold gate + lcov, `-t` name filter, `-w` watch; framework in
`builtins/test.js`), a **benchmark runner** (`velox bench`; `builtins/bench.js`),
and **source-mapped stack traces** (`src/sourcemap.rs` maps bundle frames back to
original source for uncaught errors + `console.log(error)`).

## Pipeline

`bundle → eval preludes → eval bundle → run_event_loop` (wired in
`main.rs::run_file`, mirrored per-line in `repl.rs`).

1. **`transpile.rs`** — oxc parse → `SemanticBuilder` (with `with_enum_eval(true)`)
   → `Transformer` (strips TS, lowers JSX) → `Codegen`. Source language inferred
   from extension; unknown/REPL default to TS. **Legacy ("experimental")
   decorators + `emitDecoratorMetadata` are on by default** (the form the npm
   ecosystem targets: NestJS/TypeORM/class-validator/tsyringe/type-graphql). oxc
   lowers them to `import`s of `@oxc-project/runtime/helpers/<name>`; velox
   doesn't ship that package, so those ~116 helper modules are vendored in
   `builtins/oxc_helpers/` and registered (via `src/oxc_helpers.rs`'s
   `OXC_HELPERS`) as builtins keyed by their full specifier — the bundler's
   exact-name match routes the import there, and only emitted helpers are
   injected (lean bundles). `Reflect.metadata` comes from a user `import
   "reflect-metadata"`.

2. **`module.rs`** — the bundler. Resolves the entry's `import` **and**
   `require('<literal>')` graph transitively (relative, `node_modules`, and
   `node:` builtins; a `Visit` pass follows require calls so CommonJS packages
   bundle too). File resolution (relative paths, `node_modules`, `exports`/
   `imports` conditions, scoped names, `.cjs`/`.mjs`/`.json`/`.ts`/`.tsx` + the
   `.js`→`.ts` alias) is delegated to **`oxc_resolver`** — velox's own builtin
   check runs first (so `node:*`/bare builtins route to the `BUILTINS` shims),
   then a two-pass resolve prefers the `require`/CJS build of dual packages with
   an `import` fallback for pure-ESM. The entry path is made absolute (vs cwd) so
   oxc has an absolute base. Then it transpiles each module and rewrites
   `import`/`export` into a
   CommonJS-style registry (JSC's evaluator rejects ESM syntax). Module wrappers
   are `async`, which enables **top-level `await`**; since a no-`await` body runs
   fully before its wrapper promise settles, synchronous `require()` sees
   populated exports. `import.meta`/`__dirname`/`__filename`/`require.resolve` are
   injected per-module (`module_preamble`); `.json` modules become
   `module.exports = <contents>`. Only the transitively-needed builtin shims are
   injected (lean bundles).

3. **`runtime.rs`** — owns the `JSContext`. Installs native hooks (C API) and
   evaluates the JS preludes in order: console/inspector, fetch, node globals
   (`process`), `Buffer`, `URL`, web globals, Fetch API, `crypto`. Exceptions
   park on the context; `eval` checks `context.exception()`.

4. **`event_loop.rs`** — `mio::Poll` (kqueue). Interleaves a binary-heap timer
   queue with socket readiness in one `poll(next-timer-due)` wait — never busy-
   waits. A shared `next_token()` hands unique tokens to every I/O driver; each
   event is dispatched to the owning driver. A `mio::Waker` (token `usize::MAX`)
   lets worker threads (DNS, child_process) wake the loop. GC-protect callbacks
   (`JSValueProtect`) since they outlive the initial eval.

5. **I/O drivers** (all on the one kqueue, no per-connection threads):
   - `fetch.rs` — `fetch()` as a non-blocking client state machine; TLS via
     rustls `complete_io`; chunked decode; async DNS on a worker thread + waker.
   - `server.rs` — `net`/`http`/`https`: listener+accept, and outbound connects
     (plain + **streaming TLS**). Bridges socket bytes to JS via
     `__velox_on_connection/_data/_end/_close/_error/_connect`. Payloads cross
     as binary-safe **latin1 strings**.
   - `crypto.rs` — hashes/HMAC (RustCrypto) + secure random (getrandom).
   - `sys.rs` — `zlib` (flate2), `dns` lookup, `child_process` (sync + async
     exec via worker thread + waker).
   - `node.rs` — `fs` natives + `process`/`Buffer`/`URL` globals + the builtin
     shim registry (`BUILTINS`) and global preludes.

6. **`builtins/*.js`** — Node stdlib shims (CommonJS module bodies, injected by
   `module.rs`) and global preludes (IIFEs eval'd at startup). They call native
   `__velox_*` hooks. `*_module.js`/`fs_promises.js`/`timers.js` are thin
   re-exports; subpath builtins like `fs/promises`, `timers/promises` are keyed
   by their full name in `BUILTINS`.

## Native surface convention

Two layers: register a native hook through the JSC **C API** (`register(ctx,
c"__velox_x", f)` in the relevant `*.rs`), then call/wrap it from a JS shim or
prelude. Binary data crosses as latin1 strings (`js_string_latin1` /
`js_value_to_latin1` in `node.rs`, both `pub(crate)`). Errors are thrown by
building a JS `Error` via the global `__velox_fs_error(code, msg)` and setting
the callback's exception out-param.

The `Velox` global (`builtins/velox.js`, `VELOX_PRELUDE`, evaluated **last** in
`Runtime::new` since it leans on fetch/Buffer/Request/Response) is a curated,
import-free surface: `Velox.fs`/`path`/`url`/… are getters that lazily
`require('node:…')`, and `Velox.serve` wraps `http.createServer` (web-style
`{ fetch(req) → Response }` or Node-style `(req,res)`; `Velox` itself is callable
as the same). It installs a global CommonJS `require` for builtins, backed by the
`__velox_load_builtin(name)` native (returns a shim's source from `BUILTINS`; the
prelude evals it once via `new Function` and caches). The bundle's scoped
`require` (`module.rs` `BUNDLE_PRELUDE`) falls back to that global loader for
`node:*` ids it never bundled, so CJS-style `require('node:fs')` works without an
`import`.

## Memory-safety invariants

- Timer/connection callbacks outlive the initial eval → GC-protect on schedule,
  unprotect exactly once when fired/cancelled/closed.
- Native callbacks are `extern "C-unwind"`; deref raw arg pointers via
  `arg_slice` (guards null/zero-count).
- Reactor handlers must NOT hold a `RefCell` borrow (CONNS/FETCHES/QUEUE) while
  calling back into JS — JS may re-enter (e.g. `socket.write`). Read/take data
  out under the borrow, drop it, then call JS.

## Adding a Node builtin

1. Write `src/builtins/<name>.js` (CommonJS body; may `require('node:other')`).
2. If it needs host access, add native `__velox_*` fns in the relevant `*.rs`
   and register them.
3. Add `("<name>", include_str!("builtins/<name>.js"))` to `BUILTINS` in
   `node.rs`. Subpaths (`x/y`) are matched by full name first, then base.

## Node-compat regression

`examples/node-compat-{core,io,modern,extra}.ts` are PASS/FAIL probe suites
(~178 checks) covering path/os/fs/Buffer/crypto/streams, modules/zlib/net/http/
child_process, Promise/AbortSignal/web-crypto/timers, console/fs-fds/key-objects/
parseArgs, plus the newer web/Node surface (navigator, Text/Compression streams,
streaming TextDecoder, stream/consumers, fs.glob, crypto.hash, util.styleText).
Run them after touching any builtin shim or native — they catch regressions the
`examples/*.ts` smoke tests miss. Add a `check(...)` line when adding an API.

## Known limitations

`crypto` covers hash/HMAC/random/pbkdf2/scrypt/hkdf/AES ciphers + **Ed25519**
+ ECDSA P-256 + RSA sign/verify (via ring) + **ECDH** P-256 (via the `p256`
crate) + **X25519** key agreement (`generateKeyPairSync('x25519')` +
`crypto.diffieHellman({privateKey, publicKey})`, via `x25519-dalek`; verified
against the RFC 7748 vector) + `createPublicKey`/`createPrivateKey` KeyObjects
(`detectKeyType` reads the RFC 8410 curve OID). Key generation:
`generateKeyPairSync('ed25519'|'x25519'|'ec'|'rsa')` — RSA keygen via the `rsa`
crate (`__velox_gen_rsa`), though ring won't *sign* with RSA <2048 bits. Covers
JWT RS256/ES256/EdDSA. `crypto.hash` is the Node-21 one-shot digest.
async `fs` ops run off-thread (`__velox_fs_op_async` in `sys.rs`): reads/writes,
stat/lstat/readdir/realpath, **and** mutations (mkdir/rmdir/rm/unlink/rename/
copyFile). File descriptors (`openSync`/`readSync`/`writeSync`) are synthetic JS
handles backed by read-modify-write on the path, and `fs.watch`/`watchFile` poll.
`child_process.fork` spawns a velox subprocess on the module with a real IPC
channel (parent listens on localhost TCP, child connects via `fork_ipc.js`;
`child.send`/`process.on('message')` carry newline-delimited JSON). `process` is
a real EventEmitter (`on`/`once`/`emit`/`removeListener`); `process.exit` emits
`'exit'`. Timers return Node-style `Timeout` handles
(`ref`/`unref`/`refresh`); `unref` is honored by the loop's liveness check.
Each bundled module gets its own `__filename`/`__dirname`/`import.meta` and a
dirname-aware `require.resolve` (injected by `module.rs`'s `module_preamble`).
`console` does printf specifiers + `dir`/`table`/`group`/`assert`/`count`/`time`.
Both ESM and CommonJS `node_modules` packages run: the bundler follows
`require('<literal>')` call graphs (via an oxc `Visit` pass in `module.rs`) the
same way it follows `import`, resolves `.cjs`/`.mjs`/`.json`/dir-index, and a
`.json` module becomes `module.exports = <contents>`. Dynamic `require(expr)`
isn't bundled (runtime builtin-loader fallback).
`worker_threads` (`worker.rs` + `builtins/worker_threads.js`) spawns a real OS
thread per `Worker`, each a fresh `Runtime` with its own thread-local event loop;
messages cross as JSON over `mpsc` channels, each side waking the other's `mio`
loop via a `Waker`. A worker stays alive only while `parentPort` has message
listeners (`__velox_worker_keepalive` toggles `begin_io`/`end_io`); `terminate`
sets a flag drained on the worker's next wake → `event_loop::request_stop`.
`vm` runs each `runInNewContext`/`runInContext` in a **real separate
`JSGlobalContext`** (created in the same `JSContextGroup` so values marshal
freely — `src/vm.rs`, `__velox_vm_run`): the sandbox's properties become the new
context's globals, so top-level `var`/function declarations **and** implicit
assignments write back, while host globals (`process`/`require`) are genuinely
unreachable. Contexts are released one-deferred (the result is protected against
the main context first). A `with(proxy)` shim in `vm.js` is the fallback if the
native is absent.
`SharedArrayBuffer` (JSC ships `Atomics` but not SAB) is backed by
runtime-owned memory: `src/shared.rs` keeps a process-global registry of heap
regions, each mapped into a context as an ArrayBuffer via
`JSObjectMakeArrayBufferWithBytesNoCopy` over the *same* pointer. A SAB crosses a
worker boundary by region id (the `worker_threads.js` serialize/deserialize
replacer↔reviver retains/releases the region), so **cross-thread sharing works**:
the worker maps the same physical bytes and `Atomics` ops are coherent across
threads (verified: 4 workers × 50k `Atomics.add` → exact, no lost updates).
Lifetime is refcounted across every live ArrayBuffer view + in-flight transfer
(the JSC NoCopy deallocator decrements; freed at zero). `Atomics.wait`/`notify`
exist but don't block cross-thread. **WebAssembly** async API
(`instantiate`/`compile` + streaming) is reimplemented in `web_globals.js` over
JSC's *synchronous* `Module`/`Instance` constructors: JSC's native async settles
via its `deferredWorkTimer` (a CFRunLoop timer) which never fires under velox's
kqueue loop, so those promises would hang forever — the shim compiles
synchronously and resolves immediately (unblocks emscripten output, e.g. sql.js).
**`node:sqlite`** is a real embedded database: `src/sqlite.rs` bridges
`rusqlite` (SQLite compiled in via the `bundled` feature — no system dep) behind
`__velox_sqlite_*` natives, and `builtins/sqlite.js` wraps them as
`DatabaseSync`/`StatementSync` (run/get/all/iterate, positional + named params,
`:memory:` and file DBs). Values cross as JSON; BLOBs and >2^53 integers are
tagged (`{t:"blob"|"bigint", v}`) so binary/BigInt survive the hop. Connections
live in a thread-local registry (each worker gets its own); statements re-prepare
from SQL per call (no cross-FFI borrow). User-defined scalar `function`s and
`aggregate`s are bridged: the rusqlite callback marshals args to JSON and calls a
JS dispatcher (the user's fn is held JS-side, GC-reachable; the captured
`JSContextRef` rides in a `Send` newtype since the callback only runs on the
owning thread) — don't re-enter the same DB from inside one (the connection is
borrowed for the query). A `better-sqlite3` shim (`builtins/better_sqlite3.js`,
registered as a builtin so `require('better-sqlite3')` routes to it not the
unusable native addon) maps that package's API onto node:sqlite, so knex,
Drizzle, and Kysely run against a real DB. `URL` follows the WHATWG algorithm
closely —
strips tab/newline/leading-trailing controls, treats backslash as slash in
special schemes, drops default ports, normalizes dot-segments (preserving empty
ones), percent-encodes userinfo/path/query/fragment per their encode sets,
normalizes IPv4 hosts (decimal/hex/octal/single-number → canonical dotted-quad),
encodes IDN hosts to **Punycode** (RFC 3492 `xn--…`), and fails on missing host
(passes 48/48 of a web-platform-tests battery, `examples/url-conformance.ts`).
`async_hooks` ships `AsyncLocalStorage` (`builtins/async_hooks.js`): it patches
the async primitives (Promise.then, queueMicrotask, timers, `process.nextTick`)
to capture+restore the context frame, so it propagates across callbacks, timers,
microtasks, and explicit `.then` chains, and keeps concurrent contexts isolated.
It does NOT propagate across a bare `await` — JSC's internal await bypasses a
patched `Promise.prototype.then`, and the public C API exposes no async-context
hook (Bun uses JSC internals velox can't reach). Use `AsyncResource.bind(fn)` /
`AsyncLocalStorage.snapshot()` to carry context across an await manually.
WebSockets (`builtins/ws.js`, RFC 6455): `WebSocketServer` hooks an http server's
`'upgrade'` event (added to `http.js`), the global `WebSocket` client + `ws`
default export, and `Velox.serve({ websocket })`. `node:` builtins are loaded as
**singletons** — `module.rs`'s bundle `require` routes every `node:` id through
the one global `__velox_builtin_require`, so the bundle and runtime share one
instance (critical for stateful I/O shims like net/http that install
process-global native handlers; two instances would clobber each other).
`--eval`/`-e` runs an inline string (staged as a PID-unique hidden file so
relative imports resolve against cwd). `[profile.release]` is LTO+stripped
(`panic = "unwind"` — required for `C-unwind` JS-exception propagation).
**JIT/code-signing (critical for CPU perf):** on Apple Silicon, JSC's JIT only
works if the binary is code-signed with the `com.apple.security.cs.allow-jit`
entitlement (`velox.entitlements`); unsigned, JSC runs its interpreter (~9×
slower — `JSC_useJIT=0/1` env vars have no effect because the JIT can't allocate
executable memory). `cargo run`/`cargo test` auto-sign via a cargo `runner`
(`scripts/sign-and-run.sh`, wired in `.cargo/config.toml`); `make release`/`make
install` sign the standalone binary (a plain `cargo install` strips the
signature). Signed perf: ~7 ms cold start, ~34k req/s HTTP, and CPU on par with
or faster than Node (`fib(32)×5` ~40 ms vs ~63 ms). On **Linux** none of this
applies — WebKitGTK's JIT works unsigned, so the `codesign` step is skipped
(`Makefile` guards on `uname`; the cargo runner is already gated to macOS in
`.cargo/config.toml`). Linux needs `libjavascriptcoregtk-4.1-dev` + `pkg-config`
at build time (`build.rs` links it); a `Dockerfile.linux` + the `linux` CI job
verify the build. One Linux caveat: JSC's private
`JSGlobalContextSetUnhandledRejectionCallback` SPI isn't exported by WebKitGTK,
so `process`'s `'unhandledRejection'` reporting is macOS-only (the hook is a
no-op on Linux — unhandled rejections are silently dropped). HTTPS server uses a
self-signed cert when none given.

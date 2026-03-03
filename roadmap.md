# Velox Roadmap

Tracking progress toward a production-ready JavaScript/TypeScript runtime.

## Completed

- [x] V8 JavaScript engine integration
- [x] CLI (`velox run <file>`)
- [x] TypeScript/TSX transpilation (oxc)
- [x] Async/await support with event loop
- [x] Colored error messages with source location
- [x] `console.log/error/warn/info/debug/table`
- [x] `fetch()` - Promise-based HTTP client

## Phase 1: Core APIs

Essential globals and APIs for basic scripts.

- [ ] `setTimeout` / `clearTimeout`
- [ ] `setInterval` / `clearInterval`
- [ ] `TextEncoder` / `TextDecoder`
- [ ] `URL` / `URLSearchParams`
- [ ] `atob` / `btoa` (base64)
- [ ] `structuredClone`
- [ ] `queueMicrotask`
- [ ] `performance.now()`
- [ ] `crypto.randomUUID()` / `crypto.getRandomValues()`

## Phase 2: File System

File I/O for scripts that interact with the filesystem.

- [ ] `Velox.readFile(path)` → Promise<string>
- [ ] `Velox.readFileSync(path)` → string
- [ ] `Velox.writeFile(path, data)` → Promise<void>
- [ ] `Velox.writeFileSync(path, data)`
- [ ] `Velox.exists(path)` → boolean
- [ ] `Velox.mkdir(path)` / `Velox.rm(path)`
- [ ] `Velox.readDir(path)` → string[]
- [ ] `Velox.stat(path)` → FileInfo

## Phase 3: Process & Environment

System interaction capabilities.

- [ ] `Velox.env` - environment variables
- [ ] `Velox.args` - command line arguments
- [ ] `Velox.cwd()` / `Velox.chdir(path)`
- [ ] `Velox.exit(code)`
- [ ] `Velox.exec(command)` - run shell commands
- [ ] `Velox.pid` / `Velox.platform` / `Velox.arch`

## Phase 4: Module System

Import/export support for multi-file projects.

- [ ] ES modules (`import`/`export`)
- [ ] Relative imports (`./foo.ts`)
- [ ] Absolute imports (`/path/to/foo.ts`)
- [ ] JSON imports
- [ ] Import maps support
- [ ] `node_modules` resolution (optional)

## Phase 5: Networking

Extended networking capabilities.

- [ ] `WebSocket` client
- [ ] `Velox.serve()` - HTTP server
- [ ] TCP/UDP sockets
- [ ] TLS support

## Phase 6: Developer Experience

Quality of life improvements.

- [ ] REPL mode (`velox` with no args)
- [ ] Watch mode (`velox run --watch`)
- [ ] Source maps for TypeScript errors
- [ ] `velox fmt` - code formatter
- [ ] `velox check` - type checker
- [ ] Better stack traces

## Phase 7: Performance & Stability

Production hardening.

- [ ] Snapshot support (faster startup)
- [ ] Worker threads
- [ ] Memory limits
- [ ] CPU time limits
- [ ] Graceful shutdown handling
- [ ] Signal handling (SIGINT, SIGTERM)

## Future Ideas

- [ ] FFI (Foreign Function Interface)
- [ ] WASM support
- [ ] SQLite built-in
- [ ] Package manager (`velox add <pkg>`)
- [ ] Compile to single binary
- [ ] Windows support testing
- [ ] Permissions system (like Deno)

---

## Current Focus

**Phase 1: Core APIs** - Building the essential web platform APIs that most scripts expect to be available.

## Contributing

Pick an unchecked item, implement it in `src/builtins/`, and update this roadmap!

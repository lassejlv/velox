# Velox Roadmap

Tracking progress toward a production-ready JavaScript/TypeScript runtime.

## Type-safe global Velox for all fns in example/velox.d.ts

## Completed

- [x] V8 JavaScript engine integration
- [x] CLI (`velox run <file>`)
- [x] TypeScript/TSX transpilation (oxc)
- [x] Async/await support with event loop
- [x] Colored error messages with source location
- [x] `console.log/error/warn/info/debug/table`
- [x] `fetch()` - Promise-based HTTP client

---

## Phase 1: Core APIs

Essential globals and APIs for basic scripts.

- [x] `setTimeout(fn, ms)` / `clearTimeout(id)`
- [x] `setInterval(fn, ms)` / `clearInterval(id)`
- [x] `TextEncoder` / `TextDecoder`
- [x] `URL` / `URLSearchParams`
- [x] `atob(str)` / `btoa(str)`
- [x] `structuredClone(obj)`
- [x] `queueMicrotask(fn)`
- [x] `performance.now()`
- [x] `crypto.randomUUID()`
- [x] `crypto.getRandomValues(array)`

---

## Phase 2: Velox.fs — File System

```typescript
namespace Velox.fs {
  // Reading
  readFile(path: string): Promise<Uint8Array>
  readFileSync(path: string): Uint8Array
  readTextFile(path: string): Promise<string>
  readTextFileSync(path: string): string

  // Writing
  writeFile(path: string, data: Uint8Array): Promise<void>
  writeFileSync(path: string, data: Uint8Array): void
  writeTextFile(path: string, data: string): Promise<void>
  writeTextFileSync(path: string, data: string): void
  appendFile(path: string, data: string | Uint8Array): Promise<void>

  // Directory operations
  readDir(path: string): Promise<DirEntry[]>
  readDirSync(path: string): DirEntry[]
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  mkdirSync(path: string, options?: { recursive?: boolean }): void

  // File operations
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  removeSync(path: string, options?: { recursive?: boolean }): void
  rename(from: string, to: string): Promise<void>
  copy(from: string, to: string): Promise<void>

  // Info
  stat(path: string): Promise<FileInfo>
  statSync(path: string): FileInfo
  exists(path: string): Promise<boolean>
  existsSync(path: string): boolean

  // Links
  symlink(target: string, path: string): Promise<void>
  readLink(path: string): Promise<string>
}

interface FileInfo {
  name: string
  size: number
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
  mtime: Date | null
  atime: Date | null
  birthtime: Date | null
  mode: number
}

interface DirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymlink: boolean
}
```

Checklist:
- [x] `Velox.fs.readFile` / `readFileSync`
- [x] `Velox.fs.readTextFile` / `readTextFileSync`
- [x] `Velox.fs.writeFile` / `writeFileSync`
- [x] `Velox.fs.writeTextFile` / `writeTextFileSync`
- [x] `Velox.fs.appendFile`
- [x] `Velox.fs.readDir` / `readDirSync`
- [x] `Velox.fs.mkdir` / `mkdirSync`
- [x] `Velox.fs.remove` / `removeSync`
- [x] `Velox.fs.rename`
- [x] `Velox.fs.copy`
- [x] `Velox.fs.stat` / `statSync`
- [x] `Velox.fs.exists` / `existsSync`
- [x] `Velox.fs.symlink` / `readLink`

---

## Phase 3: Velox.path — Path Utilities

```typescript
namespace Velox.path {
  join(...paths: string[]): string
  resolve(...paths: string[]): string
  dirname(path: string): string
  basename(path: string, suffix?: string): string
  extname(path: string): string
  normalize(path: string): string
  isAbsolute(path: string): boolean
  relative(from: string, to: string): string
  parse(path: string): ParsedPath
  format(obj: ParsedPath): string

  readonly sep: string      // "/" or "\\"
  readonly delimiter: string // ":" or ";"
}

interface ParsedPath {
  root: string
  dir: string
  base: string
  ext: string
  name: string
}
```

Checklist:
- [x] `Velox.path.join`
- [x] `Velox.path.resolve`
- [x] `Velox.path.dirname`
- [x] `Velox.path.basename`
- [x] `Velox.path.extname`
- [x] `Velox.path.normalize`
- [x] `Velox.path.isAbsolute`
- [x] `Velox.path.relative`
- [x] `Velox.path.parse` / `format`
- [x] `Velox.path.sep` / `delimiter`

---

## Phase 4: Velox.process — Process & Environment

```typescript
namespace Velox {
  readonly args: string[]           // CLI arguments (after script path)
  readonly execPath: string         // Path to velox binary
  readonly pid: number
  readonly platform: "darwin" | "linux" | "windows"
  readonly arch: "x64" | "arm64"
  readonly version: string          // Velox version

  cwd(): string
  chdir(path: string): void
  exit(code?: number): never

  env: {
    get(key: string): string | undefined
    set(key: string, value: string): void
    delete(key: string): void
    toObject(): Record<string, string>
    [key: string]: string | undefined  // Proxy access
  }
}
```

Checklist:
- [x] `Velox.args`
- [x] `Velox.execPath`
- [x] `Velox.pid`
- [x] `Velox.platform` / `arch` / `version`
- [x] `Velox.cwd()` / `chdir()`
- [x] `Velox.exit()`
- [x] `Velox.env.get` / `set` / `delete`
- [x] `Velox.env` proxy access

---

## Phase 5: Velox.exec — Shell Commands

```typescript
namespace Velox {
  exec(command: string): Promise<ExecResult>
  execSync(command: string): ExecResult

  spawn(command: string, options?: SpawnOptions): ChildProcess
}

interface ExecResult {
  code: number
  stdout: string
  stderr: string
  success: boolean
}

interface SpawnOptions {
  cwd?: string
  env?: Record<string, string>
  stdin?: "inherit" | "piped" | "null"
  stdout?: "inherit" | "piped" | "null"
  stderr?: "inherit" | "piped" | "null"
}

interface ChildProcess {
  pid: number
  stdin: WritableStream | null
  stdout: ReadableStream | null
  stderr: ReadableStream | null
  status: Promise<{ code: number; success: boolean }>
  kill(signal?: string): void
}
```

Checklist:
- [x] `Velox.exec` / `execSync`
- [x] `Velox.spawn`
- [ ] ChildProcess stdin/stdout/stderr streams
- [x] ChildProcess kill/status

---

## Phase 6: Velox.serve — HTTP Server

```typescript
namespace Velox {
  serve(options: ServeOptions): Server
}

interface ServeOptions {
  port?: number
  hostname?: string
  handler: (req: Request) => Response | Promise<Response>
  onListen?: (addr: { port: number; hostname: string }) => void
  onError?: (error: Error) => Response | void
}

interface Server {
  finished: Promise<void>
  addr: { port: number; hostname: string }
  shutdown(): Promise<void>
}
```

Checklist:
- [x] `Velox.serve()` basic HTTP server
- [x] Request/Response objects (web standard)
- [x] Graceful shutdown
- [x] Async handler support (Promise<Response>)
- [x] onError callback
- [ ] TLS/HTTPS support

---

## Phase 7: Module System

```typescript
// ES Modules
import { foo } from "./foo.ts"
import data from "./data.json"
import type { Bar } from "./types.ts"

// Dynamic import
const mod = await import("./dynamic.ts")

// Meta
import.meta.url      // file:///path/to/script.ts
import.meta.main     // true if entry point
import.meta.dirname  // /path/to
import.meta.filename // /path/to/script.ts
```

Checklist:
- [x] ES module parsing
- [x] Relative imports (`./`, `../`)
- [x] Absolute imports (`/path/to`)
- [x] JSON imports
- [x] Dynamic `import()`
- [x] `import.meta.url`
- [x] `import.meta.main`
- [x] `import.meta.dirname` / `filename`
- [x] Import maps (`--import-map` flag + auto-detection)
- [x] `node_modules` resolution

---

## Phase 8: Developer Experience

- [x] REPL mode (`velox` with no args)
- [x] Watch mode (`velox run --watch`)
- [ ] Source maps for TypeScript errors
- [x] `velox fmt` - code formatter (oxc)
- [x] `velox check` - syntax checker
- [x] `velox test` - test runner
- [ ] `velox compile` - compile to binary
- [ ] Better stack traces with source locations

---

## Phase 9: Performance & Stability

- [ ] V8 snapshot support (faster startup)
- [x] Worker threads (`new Worker()`)
- [ ] Memory limits (`--max-memory`)
- [ ] CPU time limits
- [x] Graceful shutdown (SIGINT, SIGTERM)
- [x] Permissions system (`--allow-read`, `--allow-write`, `--allow-net`, `--allow-run`, `--allow-env`, `--allow-all`)

---

## Future Ideas

- [ ] FFI (Foreign Function Interface)
- [ ] WASM support
- [ ] SQLite built-in (`Velox.sqlite`)
- [x] Package manager (`velox add <pkg>`)
- [ ] WebSocket server
- [ ] TCP/UDP sockets
- [ ] Windows support

---

## Current Focus

**Phase 7: Module System** → ✅ COMPLETE

**Phase 8: Developer Experience** → ✅ IN PROGRESS
- Watch mode, fmt, check, test commands implemented
- Remaining: source maps, compile to binary, better stack traces

**Hono Framework Compatibility** → ✅ COMPLETE
- Full URL support for Request objects
- Fixed Response status handling for undefined values
- Tested with actual Hono npm package

**Phase 9: Performance & Stability** → IN PROGRESS
- Graceful shutdown (SIGINT/SIGTERM) implemented
- Worker threads (`new Worker()`) implemented
- Permissions system (`--allow-read`, `--allow-write`, `--allow-net`, `--allow-run`, `--allow-env`, `--allow-all`) implemented
- Next: Memory limits, V8 snapshots

## Implementation Guide

Each `Velox.*` namespace should be implemented as a separate file:

```
src/builtins/
├── mod.rs
├── console.rs
├── fetch.rs
├── timers.rs      # setTimeout, setInterval
├── encoding.rs    # TextEncoder, TextDecoder, atob, btoa
├── url.rs         # URL, URLSearchParams
├── crypto.rs      # crypto.randomUUID, getRandomValues
├── fs.rs          # Velox.fs.*
├── path.rs        # Velox.path.*
├── process.rs     # Velox.args, env, cwd, exit
├── exec.rs        # Velox.exec, spawn
└── serve.rs       # Velox.serve
```

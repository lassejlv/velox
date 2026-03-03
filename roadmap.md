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
- [ ] `Velox.fs.readFile` / `readFileSync`
- [ ] `Velox.fs.readTextFile` / `readTextFileSync`
- [ ] `Velox.fs.writeFile` / `writeFileSync`
- [ ] `Velox.fs.writeTextFile` / `writeTextFileSync`
- [ ] `Velox.fs.appendFile`
- [ ] `Velox.fs.readDir` / `readDirSync`
- [ ] `Velox.fs.mkdir` / `mkdirSync`
- [ ] `Velox.fs.remove` / `removeSync`
- [ ] `Velox.fs.rename`
- [ ] `Velox.fs.copy`
- [ ] `Velox.fs.stat` / `statSync`
- [ ] `Velox.fs.exists` / `existsSync`
- [ ] `Velox.fs.symlink` / `readLink`

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
- [ ] `Velox.path.join`
- [ ] `Velox.path.resolve`
- [ ] `Velox.path.dirname`
- [ ] `Velox.path.basename`
- [ ] `Velox.path.extname`
- [ ] `Velox.path.normalize`
- [ ] `Velox.path.isAbsolute`
- [ ] `Velox.path.relative`
- [ ] `Velox.path.parse` / `format`
- [ ] `Velox.path.sep` / `delimiter`

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
- [ ] `Velox.args`
- [ ] `Velox.execPath`
- [ ] `Velox.pid`
- [ ] `Velox.platform` / `arch` / `version`
- [ ] `Velox.cwd()` / `chdir()`
- [ ] `Velox.exit()`
- [ ] `Velox.env.get` / `set` / `delete`
- [ ] `Velox.env` proxy access

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
- [ ] `Velox.exec` / `execSync`
- [ ] `Velox.spawn`
- [ ] ChildProcess stdin/stdout/stderr streams
- [ ] ChildProcess kill/status

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
- [ ] `Velox.serve()` basic HTTP server
- [ ] Request/Response objects (web standard)
- [ ] Graceful shutdown
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
- [ ] ES module parsing
- [ ] Relative imports (`./`, `../`)
- [ ] Absolute imports (`/path/to`)
- [ ] JSON imports
- [ ] Dynamic `import()`
- [ ] `import.meta.url`
- [ ] `import.meta.main`
- [ ] `import.meta.dirname` / `filename`
- [ ] Import maps
- [ ] `node_modules` resolution (optional)

---

## Phase 8: Developer Experience

- [x] REPL mode (`velox` with no args)
- [ ] Watch mode (`velox run --watch`)
- [ ] Source maps for TypeScript errors
- [ ] `velox fmt` - code formatter (oxc)
- [ ] `velox check` - type checker
- [ ] `velox test` - test runner
- [ ] `velox compile` - compile to binary
- [ ] Better stack traces with source locations

---

## Phase 9: Performance & Stability

- [ ] V8 snapshot support (faster startup)
- [ ] Worker threads (`new Worker()`)
- [ ] Memory limits (`--max-memory`)
- [ ] CPU time limits
- [ ] Graceful shutdown (SIGINT, SIGTERM)
- [ ] Permissions system (`--allow-read`, `--allow-net`, etc.)

---

## Future Ideas

- [ ] FFI (Foreign Function Interface)
- [ ] WASM support
- [ ] SQLite built-in (`Velox.sqlite`)
- [ ] Package manager (`velox add <pkg>`)
- [ ] WebSocket server
- [ ] TCP/UDP sockets
- [ ] Windows support

---

## Current Focus

**Phase 1: Core APIs** → `setTimeout`, `URL`, `TextEncoder`, `crypto`

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

// Velox Runtime Type Definitions
// https://github.com/lassejlv/velox

declare namespace Velox {
  // Process info
  const args: string[];
  const execPath: string;
  const pid: number;
  const platform: "darwin" | "linux" | "windows";
  const arch: "x64" | "arm64";
  const version: string;

  // Process functions
  function cwd(): string;
  function chdir(path: string): void;
  function exit(code?: number): never;

  // Environment variables
  const env: {
    get(key: string): string | undefined;
    set(key: string, value: string): void;
    delete(key: string): void;
    toObject(): Record<string, string>;
    [key: string]: string | ((...args: any[]) => any) | undefined;
  };

  // Shell commands
  function exec(command: string): Promise<ExecResult>;
  function execSync(command: string): ExecResult;
  function spawn(command: string, options?: SpawnOptions): ChildProcess;

  // File System
  namespace fs {
    // Reading
    function readFile(path: string): Promise<Uint8Array>;
    function readFileSync(path: string): Uint8Array;
    function readTextFile(path: string): Promise<string>;
    function readTextFileSync(path: string): string;

    // Writing
    function writeFile(path: string, data: Uint8Array): Promise<void>;
    function writeFileSync(path: string, data: Uint8Array): void;
    function writeTextFile(path: string, data: string): Promise<void>;
    function writeTextFileSync(path: string, data: string): void;
    function appendFile(path: string, data: string | Uint8Array): Promise<void>;

    // Directory operations
    function readDir(path: string): Promise<DirEntry[]>;
    function readDirSync(path: string): DirEntry[];
    function mkdir(
      path: string,
      options?: { recursive?: boolean }
    ): Promise<void>;
    function mkdirSync(path: string, options?: { recursive?: boolean }): void;

    // File operations
    function remove(
      path: string,
      options?: { recursive?: boolean }
    ): Promise<void>;
    function removeSync(path: string, options?: { recursive?: boolean }): void;
    function rename(from: string, to: string): Promise<void>;
    function copy(from: string, to: string): Promise<void>;

    // Info
    function stat(path: string): Promise<FileInfo>;
    function statSync(path: string): FileInfo;
    function exists(path: string): Promise<boolean>;
    function existsSync(path: string): boolean;

    // Links
    function symlink(target: string, path: string): Promise<void>;
    function readLink(path: string): Promise<string>;
  }

  // Path utilities
  namespace path {
    function join(...paths: string[]): string;
    function resolve(...paths: string[]): string;
    function dirname(path: string): string;
    function basename(path: string, suffix?: string): string;
    function extname(path: string): string;
    function normalize(path: string): string;
    function isAbsolute(path: string): boolean;
    function relative(from: string, to: string): string;
    function parse(path: string): ParsedPath;
    function format(obj: ParsedPath): string;

    const sep: string;
    const delimiter: string;
  }

  // HTTP Server
  function serve(options: ServeOptions): Server;
}

// Type definitions
interface FileInfo {
  name: string;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  mtime: Date | null;
  atime: Date | null;
  birthtime: Date | null;
  mode: number;
}

interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

interface ParsedPath {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  success: boolean;
}

interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: "inherit" | "piped" | "null";
  stdout?: "inherit" | "piped" | "null";
  stderr?: "inherit" | "piped" | "null";
}

interface ChildProcess {
  pid: number;
  kill(signal?: string): void;
  wait(): Promise<{ code: number; success: boolean }>;
  output(): Promise<string>;
}

interface ServeOptions {
  port?: number;
  hostname?: string;
  handler: (request: Request) => Response | Promise<Response>;
  onListen?: (addr: { port: number; hostname: string }) => void;
  onError?: (error: Error) => Response | void;
}

interface Server {
  addr: { port: number; hostname: string };
  shutdown(): Promise<void>;
}

// Augment import.meta for Velox
interface ImportMeta {
  url: string;
  main: boolean;
  dirname: string;
  filename: string;
}

// Web Standard APIs
// Velox provides Web Standard APIs (Headers, Request, Response, URL, URLSearchParams)
// that are compatible with the Fetch Standard. These are available globally.
//
// Additional globals:
// - fetch(url, init?): Promise<Response>
// - setTimeout/setInterval/clearTimeout/clearInterval
// - TextEncoder/TextDecoder
// - atob/btoa
// - crypto.randomUUID(), crypto.getRandomValues()
// - performance.now()
// - queueMicrotask(fn)
// - structuredClone(obj)
// - console.log/error/warn/info/debug/table
// - Worker (Web Workers for parallel execution)

// Worker API
declare class Worker {
  constructor(scriptURL: string);
  postMessage(message: any): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

interface MessageEvent {
  data: any;
}

interface ErrorEvent {
  message: string;
}

// Worker scope globals (available inside worker scripts)
declare var self: typeof globalThis & {
  postMessage(message: any): void;
  onmessage: ((event: MessageEvent) => void) | null;
};
declare function postMessage(message: any): void;

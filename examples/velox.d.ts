// Velox Runtime Type Definitions

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
    function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    function mkdirSync(path: string, options?: { recursive?: boolean }): void;

    // File operations
    function remove(path: string, options?: { recursive?: boolean }): Promise<void>;
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

  namespace path {
    // Path manipulation
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

    // Constants
    const sep: string;
    const delimiter: string;
  }
}

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

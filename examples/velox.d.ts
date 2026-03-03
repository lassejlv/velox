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
	// Shell commands
	function exec(command: string): Promise<ExecResult>;
	function execSync(command: string): ExecResult;
	function spawn(command: string, options?: SpawnOptions): ChildProcess;
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
		function mkdir(path: string, options?: {
			recursive?: boolean;
		}): Promise<void>;
		function mkdirSync(path: string, options?: {
			recursive?: boolean;
		}): void;
		// File operations
		function remove(path: string, options?: {
			recursive?: boolean;
		}): Promise<void>;
		function removeSync(path: string, options?: {
			recursive?: boolean;
		}): void;
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
	// HTTP Server
	function serve(options: ServeOptions): Server;
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
	wait(): Promise<{
		code: number;
		success: boolean;
	}>;
	output(): Promise<string>;
}
// HTTP Server types
interface ServeOptions {
	port?: number;
	hostname?: string;
	handler: (request: Request) => Response | Promise<Response>;
	onListen?: (addr: {
		port: number;
		hostname: string;
	}) => void;
	onError?: (error: Error) => Response | void;
}
interface Server {
	addr: {
		port: number;
		hostname: string;
	};
	shutdown(): Promise<void>;
}
// NOTE: Velox provides Web Standard APIs (Headers, Request, Response) that are
// compatible with the built-in TypeScript DOM types. When using TypeScript,
// include "lib": ["ES2020", "DOM"] in your tsconfig.json to get type definitions
// for these standard APIs.
//
// Velox implements:
// - Headers: constructor, get, set, has, delete, append, entries, keys, values, forEach
// - Request: constructor, url, method, headers, bodyUsed, text(), json(), arrayBuffer(), bytes(), clone()
// - Response: constructor, status, statusText, ok, headers, bodyUsed, text(), json(), arrayBuffer(), bytes(), clone()
// - Response.json(data, init?), Response.redirect(url, status?), Response.error()

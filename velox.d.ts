/**
 * Type definitions for the built-in **Velox** API.
 *
 * These types cover the curated, import-free surface installed as `globalThis.Velox`
 * (`src/builtins/velox.js`), plus the Web Platform globals that `Velox.serve`
 * and `Velox.fetch` are designed to work with.
 *
 * For `node:*` builtins (loaded lazily via `Velox.require` / `Velox.fs`, etc.),
 * use [`@types/node`](https://www.npmjs.com/package/@types/node) separately.
 *
 * @platform macOS (darwin) only
 * @version 0.1.0
 *
 * @example
 * ```ts
 * /// <reference path="./velox.d.ts" />
 *
 * const server = Velox.serve({
 *   port: 3000,
 *   fetch(req) {
 *     return Response.json({ ok: true, path: new URL(req.url).pathname });
 *   },
 * });
 *
 * Velox.writeTextSync("out.txt", "hello");
 * console.log(Velox.readTextSync("out.txt"));
 * server.close();
 * Velox.exit(0);
 * ```
 */

// =============================================================================
// Velox.serve
// =============================================================================

/**
 * HTTP(S) server returned by {@link Velox.serve}.
 * Backed by `node:http` / `node:https` internally.
 */
interface VeloxServer {
  /**
   * Start listening.
   * @param port Port number (default applied by `Velox.serve` options).
   * @param hostname Host to bind.
   * @param callback Called when the server is accepting connections.
   */
  listen(port?: number, hostname?: string, callback?: () => void): this;
  listen(port?: number, callback?: () => void): this;

  /**
   * Stop accepting new connections.
   * @param callback Optional callback when the server has closed.
   */
  close(callback?: (err?: Error) => void): this;

  /**
   * Address the server is bound to, or `null` if not listening.
   */
  address(): { port: number; address: string; family: string } | string | null;

  /** Attached WebSocket server when created with `{ websocket }` options. */
  _wss?: VeloxWebSocketServer;
}

/** WebSocket server instance (from the internal `ws` shim). */
interface VeloxWebSocketServer {
  close(callback?: (err?: Error) => void): void;
  on(event: "connection", listener: (ws: VeloxWebSocket, req: VeloxHttpIncomingMessage) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

/** Minimal Node-style request passed to WebSocket `open` handlers. */
interface VeloxHttpIncomingMessage {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/** WebSocket connection in `Velox.serve({ websocket })` handlers. */
interface VeloxWebSocket {
  /** Arbitrary per-connection data (initialized to `{}`). */
  data: Record<string, unknown>;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Uint8Array | ArrayBuffer | string, isBinary: boolean) => void): this;
  on(event: "close", listener: (code: number, reason: Uint8Array) => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

/**
 * Web-style handler: receives a WHATWG {@link Request}, returns a {@link Response}.
 * Used by `Velox.serve({ fetch })` and auto-detected when a two-arg handler has
 * arity ≤ 1.
 */
type VeloxFetchHandler = (
  request: Request,
  serverContext?: { req: VeloxHttpIncomingMessage; res: VeloxHttpServerResponse },
) => Response | Promise<Response | null | undefined>;

/** Minimal Node-style response for the optional `serverContext` argument. */
interface VeloxHttpServerResponse {
  statusCode: number;
  setHeader(name: string, value: string | number): void;
  writeHead(statusCode: number, headers?: Record<string, string | number>): void;
  end(data?: string | Uint8Array): void;
}

/**
 * Node-style handler: classic `(req, res)` callback.
 * Auto-detected when the handler function has arity ≥ 2.
 */
type VeloxNodeHandler = (req: VeloxHttpIncomingMessage, res: VeloxHttpServerResponse) => void;

/** Lifecycle hooks for `Velox.serve({ websocket: { … } })`. */
interface VeloxWebSocketHandlers {
  /** Called when a client completes the WebSocket handshake. */
  open?(ws: VeloxWebSocket, req: VeloxHttpIncomingMessage): void;
  /** Called for each incoming message frame. */
  message?(ws: VeloxWebSocket, data: Uint8Array | ArrayBuffer | string, isBinary: boolean): void;
  /** Called when the connection closes. */
  close?(ws: VeloxWebSocket, code: number, reason: Uint8Array): void;
  /** Called on connection errors. */
  error?(ws: VeloxWebSocket, err: Error): void;
}

/** TLS options forwarded to `node:https.createServer` when `tls` is set. */
interface VeloxTlsOptions {
  key?: string | Uint8Array;
  cert?: string | Uint8Array;
  pfx?: string | Uint8Array;
  passphrase?: string;
  [key: string]: unknown;
}

/** Options for {@link Velox.serve}. */
interface VeloxServeOptions {
  /**
   * Port to listen on.
   * @default 3000
   */
  port?: number;

  /**
   * Hostname to bind.
   * @default all interfaces
   */
  hostname?: string;

  /**
   * Enable HTTPS. Pass `true` for a self-signed cert, or TLS key/cert options.
   */
  tls?: true | VeloxTlsOptions;

  /**
   * Web-style fetch handler — Bun/Deno flavored.
   * Mutually composable with `handler` (one primary handler is required).
   */
  fetch?: VeloxFetchHandler;

  /**
   * Explicit Node-style `(req, res)` handler.
   */
  handler?: VeloxNodeHandler;

  /**
   * Attach a WebSocket server to the same HTTP listener.
   * Plain HTTP requests receive `426 Upgrade Required`.
   */
  websocket?: VeloxWebSocketHandlers;

  /**
   * Called once the server is listening.
   */
  onListen?(info: { port: number; hostname: string }): void;
}

// =============================================================================
// Velox global
// =============================================================================

/**
 * Built-in module loader for `node:` shims.
 * Accepts `"node:fs"`, `"fs"`, etc. Throws if the builtin is unknown.
 */
type VeloxBuiltinRequire = (specifier: string) => unknown;

/**
 * The **`Velox`** global — velox's curated, import-free API.
 *
 * Installed at startup after `process`, `Buffer`, and `fetch` are available.
 * `Velox(port, handler)` is shorthand for `Velox.serve(port, handler)`.
 */
interface VeloxGlobal {
  /** Runtime version string. Currently `"0.1.0"`. */
  readonly version: string;

  /**
   * Load a built-in `node:` shim by name.
   * Results are cached after the first load.
   */
  require: VeloxBuiltinRequire;

  /**
   * Start an HTTP or HTTPS server.
   *
   * @example Web-style
   * ```ts
   * Velox.serve({ port: 3000, fetch(req) { return new Response("ok"); } });
   * ```
   *
   * @example Node-style
   * ```ts
   * Velox.serve(3000, (req, res) => { res.end("ok"); });
   * ```
   *
   * @example Callable shorthand
   * ```ts
   * Velox(3000, (req, res) => { res.end("ok"); });
   * ```
   */
  serve(port: number, handler: VeloxNodeHandler | VeloxFetchHandler): VeloxServer;
  serve(options: VeloxServeOptions, handler?: VeloxNodeHandler | VeloxFetchHandler): VeloxServer;

  /** Alias for `globalThis.process`. */
  readonly process: {
    env: Record<string, string | undefined>;
    argv: string[];
    cwd(): string;
    exit(code?: number): never;
    [key: string]: unknown;
  };

  /** Alias for `globalThis.Buffer`. */
  readonly Buffer: {
    from(data: string | Uint8Array | ArrayBuffer, encoding?: string): Uint8Array;
    alloc(size: number): Uint8Array;
    concat(list: readonly Uint8Array[]): Uint8Array;
    [key: string]: unknown;
  };

  /** Alias for `process.env`. */
  readonly env: Record<string, string | undefined>;

  /** Script arguments (`process.argv.slice(2)`). */
  readonly args: string[];

  /** Current working directory (`process.cwd()`). */
  cwd(): string;

  /** Exit the process (`process.exit()`). */
  exit(code?: number): never;

  /** Alias for `globalThis.fetch`. */
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;

  /** Read a UTF-8 text file synchronously. */
  readTextSync(path: string): string;

  /** Write a UTF-8 text file synchronously. */
  writeTextSync(path: string, data: string): void;

  /** Read a file as raw bytes synchronously. */
  readBytesSync(path: string): Uint8Array;

  /** Read a UTF-8 text file asynchronously. */
  readText(path: string): Promise<string>;

  /** Write a UTF-8 text file asynchronously. */
  writeText(path: string, data: string): Promise<void>;

  /**
   * Lazy `node:fs` accessor — loads the builtin on first access.
   * @see Node.js `fs` documentation for API details.
   */
  readonly fs: unknown;

  /** Lazy `node:path` accessor. */
  readonly path: unknown;

  /** Lazy `node:url` accessor (`URL`, `URLSearchParams`, …). */
  readonly url: unknown;

  /** Lazy `node:os` accessor. */
  readonly os: unknown;

  /** Lazy `node:crypto` accessor. */
  readonly crypto: unknown;

  /** Lazy `node:http` accessor. */
  readonly http: unknown;

  /** Lazy `node:https` accessor. */
  readonly https: unknown;

  /** Lazy `node:net` accessor. */
  readonly net: unknown;

  /** Lazy `node:tls` accessor. */
  readonly tls: unknown;

  /** Lazy `node:stream` accessor. */
  readonly stream: unknown;

  /** Lazy `node:zlib` accessor. */
  readonly zlib: unknown;

  /** Lazy `node:dns` accessor. */
  readonly dns: unknown;

  /** Lazy `node:child_process` accessor. */
  readonly child_process: unknown;

  /** Lazy `node:util` accessor. */
  readonly util: unknown;

  /** Lazy `node:events` accessor. */
  readonly events: unknown;

  /** Lazy `node:assert` accessor. */
  readonly assert: unknown;

  /** Lazy `node:querystring` accessor. */
  readonly querystring: unknown;

  /** Lazy `node:vm` accessor. */
  readonly vm: unknown;
}

/**
 * Callable shorthand: `Velox(3000, handler)` === `Velox.serve(3000, handler)`.
 */
interface VeloxCallable extends VeloxGlobal {
  (port: number, handler: VeloxNodeHandler | VeloxFetchHandler): VeloxServer;
  (options: VeloxServeOptions, handler?: VeloxNodeHandler | VeloxFetchHandler): VeloxServer;
}

declare var Velox: VeloxCallable;

// =============================================================================
// Web Platform globals used by Velox.serve / Velox.fetch
// (installed by velox preludes; documented here for import-free TypeScript)
// =============================================================================

/** @see https://fetch.spec.whatwg.org/#fetch-method */
declare function fetch(input: RequestInfo, init?: RequestInit): Promise<Response>;

type RequestInfo = Request | string | URL;
type BodyInit = Blob | BufferSource | FormData | URLSearchParams | string;
type HeadersInit = Headers | Record<string, string> | Iterable<[string, string]>;

interface RequestInit {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  redirect?: "error" | "follow" | "manual";
  signal?: AbortSignal | null;
}

/** @see https://fetch.spec.whatwg.org/#request-class */
declare class Request {
  constructor(input: RequestInfo, init?: RequestInit);
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly bodyUsed: boolean;
  clone(): Request;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
}

interface ResponseInit {
  status?: number;
  statusText?: string;
  headers?: HeadersInit;
}

/** @see https://fetch.spec.whatwg.org/#response-class */
declare class Response {
  constructor(body?: BodyInit | null, init?: ResponseInit);
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: Headers;
  readonly bodyUsed: boolean;
  clone(): Response;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  /** Serialize JSON with `Content-Type: application/json`. */
  static json(data: unknown, init?: ResponseInit): Response;
  static error(): Response;
  static redirect(url: string | URL, status?: number): Response;
}

/** @see https://fetch.spec.whatwg.org/#headers-class */
declare class Headers {
  constructor(init?: HeadersInit);
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  has(name: string): boolean;
  set(name: string, value: string): void;
  forEach(callback: (value: string, key: string) => void): void;
}

/** @see https://fetch.spec.whatwg.org/#blob */
declare class Blob {
  constructor(parts?: BlobPart[], options?: { type?: string });
  readonly size: number;
  readonly type: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, contentType?: string): Blob;
}
type BlobPart = BufferSource | Blob | string;

/** WHATWG URL — also available via `Velox.url.URL` after lazy load. */
declare class URL {
  constructor(url: string | URL, base?: string | URL);
  hash: string;
  host: string;
  hostname: string;
  href: string;
  readonly origin: string;
  password: string;
  pathname: string;
  port: string;
  protocol: string;
  search: string;
  readonly searchParams: URLSearchParams;
  username: string;
  toString(): string;
  static canParse(url: string, base?: string): boolean;
}

declare class URLSearchParams {
  constructor(init?: string | Record<string, string> | URLSearchParams);
  append(name: string, value: string): void;
  delete(name: string): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  set(name: string, value: string): void;
  toString(): string;
  forEach(callback: (value: string, key: string) => void): void;
}

/** Optional abort signal for `fetch` (also supported by `Velox.fetch`). */
declare class AbortController {
  constructor();
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare class AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
  static abort(reason?: unknown): AbortSignal;
  static timeout(milliseconds: number): AbortSignal;
}

//! `fetch` as a non-blocking, multiplexed I/O state machine.
//!
//! Each request is a `Connection` driven entirely on the event-loop thread:
//! the socket is registered with the shared `mio::Poll` (kqueue on macOS) and
//! advanced on readiness events — connect, optional TLS handshake, write
//! request, read response — with no worker threads. Many requests share one
//! kqueue at once.
//!
//! The JS side (`FETCH_PRELUDE`) owns the Promise and a token→{resolve,reject}
//! map, so JS callbacks never leave the main thread; the native side only deals
//! in plain data keyed by a numeric token.
//!
//! DNS has no portable async API, so (like Node's default `dns.lookup`) the
//! `getaddrinfo` call runs on a worker thread and nudges the loop awake via a
//! `mio::Waker` when it resolves; everything after that is async on kqueue.
//!
//! Simplifications (barebone): `Connection: close` so the body ends at EOF
//! (chunked bodies are decoded; keep-alive is not used), and one worker thread
//! per DNS lookup.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::io::{Read, Write};
use std::net::{SocketAddr, ToSocketAddrs};
use std::ptr;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};

use mio::net::TcpStream;
use mio::{Interest, Token};
use rustls::{ClientConfig, ClientConnection, RootCertStore};
use rustls_pki_types::ServerName;

use objc2_javascript_core::{
    JSContext, JSContextRef, JSObjectCallAsFunction, JSObjectGetProperty, JSObjectRef,
    JSStringCreateWithUTF8CString, JSStringRelease, JSValue, JSValueRef,
};

use crate::event_loop::{NativeFn, arg_slice, begin_io, end_io, registry};
use crate::runtime::js_value_to_string;

/// JavaScript that defines `globalThis.fetch` and the settle hook on top of the
/// native `__velox_fetch_start`.
pub const FETCH_PRELUDE: &str = r#"
(function () {
  const pending = {};
  let nextToken = 1;

  function makeHeaders(pairs) {
    const map = {};
    const order = [];
    for (let i = 0; i < pairs.length; i++) {
      const k = String(pairs[i][0]).toLowerCase();
      const v = String(pairs[i][1]);
      if (map[k] === undefined) { map[k] = v; order.push(k); }
      else { map[k] = map[k] + ", " + v; } // combine duplicates (per spec)
    }
    return {
      get: function (name) {
        const v = map[String(name).toLowerCase()];
        return v === undefined ? null : v;
      },
      has: function (name) { return map[String(name).toLowerCase()] !== undefined; },
      forEach: function (fn, thisArg) {
        for (let i = 0; i < order.length; i++) fn.call(thisArg, map[order[i]], order[i], this);
      },
      keys: function () { return order.slice(); },
      entries: function () { return order.map(function (k) { return [k, map[k]]; }); },
    };
  }

  function makeResponse(status, statusText, headersJson, body) {
    let pairs = [];
    try { pairs = JSON.parse(headersJson) || []; } catch (e) {}
    // Prefer the real WHATWG Response (installed at startup) so callers get a
    // spec object: `res instanceof Response`, `res.blob()`, real `Headers`, etc.
    if (typeof globalThis.Response !== "undefined" && typeof globalThis.Headers !== "undefined") {
      const headers = new Headers();
      for (let i = 0; i < pairs.length; i++) headers.append(pairs[i][0], pairs[i][1]);
      return new Response(body, { status: status, statusText: statusText, headers: headers });
    }
    return {
      ok: status >= 200 && status < 300,
      status: status,
      statusText: statusText,
      headers: makeHeaders(pairs),
      url: "",
      text: function () { return Promise.resolve(body); },
      json: function () { return Promise.resolve(JSON.parse(body)); },
    };
  }

  // Normalize options.headers (Headers instance, plain object, or [k,v][] array)
  // into a JSON array of [name, value] pairs for the native side.
  function headerPairs(h) {
    const pairs = [];
    if (!h) return pairs;
    if (typeof h.forEach === "function" && !Array.isArray(h)) {
      // Headers instance: forEach(value, name)
      h.forEach(function (v, k) { pairs.push([String(k), String(v)]); });
    } else if (Array.isArray(h)) {
      for (let i = 0; i < h.length; i++) pairs.push([String(h[i][0]), String(h[i][1])]);
    } else {
      for (const k in h) if (Object.prototype.hasOwnProperty.call(h, k)) pairs.push([String(k), String(h[k])]);
    }
    return pairs;
  }

  globalThis.fetch = function (url, options) {
    options = options || {};
    // Accept a Request instance as the first argument.
    if (typeof globalThis.Request !== "undefined" && url instanceof globalThis.Request) {
      const req = url;
      options = Object.assign({ method: req.method, headers: req.headers, body: req._bodyText }, options);
      url = req.url;
    }
    return new Promise(function (resolve, reject) {
      const token = nextToken++;
      pending[token] = { resolve: resolve, reject: reject };
      const method = options.method ? String(options.method) : "GET";
      const body = options.body != null ? String(options.body) : "";
      let headersJson = "[]";
      try { headersJson = JSON.stringify(headerPairs(options.headers)); } catch (e) {}
      __velox_fetch_start(String(url), token, method, body, headersJson);
    });
  };

  globalThis.__velox_fetch_settle = function (token, ok, status, statusText, headersJson, body) {
    const p = pending[token];
    if (!p) return;
    delete pending[token];
    if (ok) {
      p.resolve(makeResponse(status, statusText, headersJson, body));
    } else {
      p.reject(new Error(body || "fetch failed"));
    }
  };
})();
"#;

const READ_CHUNK: usize = 32 * 1024;

/// A DNS lookup result delivered from a worker thread: `(request id, address)`.
type DnsResult = (u64, Result<SocketAddr, String>);

/// A request waiting on DNS resolution before its socket can be opened.
struct PendingRequest {
    js_token: f64,
    target: Target,
    method: String,
    body: String,
    /// Custom request headers as `[name, value]` pairs (from `options.headers`).
    headers: Vec<(String, String)>,
}

thread_local! {
    /// Active connections, keyed by their `mio` token.
    static FETCHES: RefCell<HashMap<Token, Connection>> = RefCell::new(HashMap::new());
    /// Shared TLS client config (roots + ring provider), built once.
    static TLS_CONFIG: Arc<ClientConfig> = Arc::new(build_tls_config());

    /// Requests awaiting DNS, keyed by request id.
    static DNS_PENDING: RefCell<HashMap<u64, PendingRequest>> = RefCell::new(HashMap::new());
    static NEXT_REQ: Cell<u64> = const { Cell::new(0) };
    /// Channel carrying resolved addresses back from worker threads.
    static DNS_CHANNEL: (Sender<DnsResult>, Receiver<DnsResult>) = mpsc::channel();
}

fn build_tls_config() -> ClientConfig {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .expect("default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

/// Register the native `__velox_fetch_start` hook.
pub fn install(ctx: JSContextRef) {
    let start: NativeFn = fetch_start;
    unsafe { crate::event_loop::register(ctx, c"__velox_fetch_start", start) };
}

// ---------------------------------------------------------------------------
// Connection state machine
// ---------------------------------------------------------------------------

enum Transport {
    Plain(TcpStream),
    Tls {
        tls: Box<ClientConnection>,
        sock: TcpStream,
    },
}

impl Transport {
    fn socket(&mut self) -> &mut TcpStream {
        match self {
            Transport::Plain(sock) => sock,
            Transport::Tls { sock, .. } => sock,
        }
    }
}

struct Connection {
    js_token: f64,
    transport: Transport,
    connected: bool,
    request: Vec<u8>,
    written: usize,
    response: Vec<u8>,
}

/// Result of advancing a connection on a readiness event.
enum Outcome {
    /// Needs more I/O; wait for the next event.
    Pending,
    /// Response fully received (body ends at EOF).
    Done,
    /// Transport failure (DNS/connect/TLS/socket error).
    Failed(String),
}

impl Connection {
    /// Advance as far as possible without blocking.
    fn pump(&mut self) -> Outcome {
        if !self.connected {
            match self.transport.socket().take_error() {
                Ok(Some(error)) => return Outcome::Failed(error.to_string()),
                Err(error) => return Outcome::Failed(error.to_string()),
                Ok(None) => self.connected = true,
            }
        }

        match &mut self.transport {
            Transport::Plain(sock) => {
                pump_plain(sock, &self.request, &mut self.written, &mut self.response)
            }
            Transport::Tls { tls, sock } => pump_tls(
                tls,
                sock,
                &self.request,
                &mut self.written,
                &mut self.response,
            ),
        }
    }
}

/// Drive a plaintext HTTP connection: finish writing the request, then read the
/// response until EOF.
fn pump_plain(
    sock: &mut TcpStream,
    request: &[u8],
    written: &mut usize,
    response: &mut Vec<u8>,
) -> Outcome {
    while *written < request.len() {
        match sock.write(&request[*written..]) {
            Ok(0) => return Outcome::Failed("connection closed while writing".into()),
            Ok(n) => *written += n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Outcome::Pending,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Outcome::Failed(e.to_string()),
        }
    }

    let mut buf = [0u8; READ_CHUNK];
    loop {
        match sock.read(&mut buf) {
            Ok(0) => return Outcome::Done,
            Ok(n) => response.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Outcome::Pending,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if is_eof_like(&e) => return Outcome::Done,
            Err(e) => return Outcome::Failed(e.to_string()),
        }
    }
}

/// Drive a TLS connection using rustls' non-blocking pattern: `complete_io`
/// pumps the handshake and socket until it would block, then we feed the
/// request through the writer and drain plaintext from the reader.
fn pump_tls(
    tls: &mut ClientConnection,
    sock: &mut TcpStream,
    request: &[u8],
    written: &mut usize,
    response: &mut Vec<u8>,
) -> Outcome {
    loop {
        // Once the handshake is done, queue the (remaining) request as app data.
        if *written < request.len() && !tls.is_handshaking() {
            match tls.writer().write(&request[*written..]) {
                Ok(n) => *written += n,
                Err(e) => return Outcome::Failed(e.to_string()),
            }
        }

        let progressed = match tls.complete_io(sock) {
            Ok((read, wrote)) => read + wrote > 0,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => false,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if is_eof_like(&e) => {
                // Peer closed without close_notify; drain whatever decoded.
                let _ = drain_plaintext(tls, response);
                return Outcome::Done;
            }
            Err(e) => return Outcome::Failed(e.to_string()),
        };

        if !progressed {
            break;
        }
    }

    match drain_plaintext(tls, response) {
        Ok(true) => Outcome::Done, // clean EOF (close_notify)
        Ok(false) => Outcome::Pending,
        Err(e) => Outcome::Failed(e),
    }
}

/// Read all currently-available plaintext into `out`. Returns `Ok(true)` on EOF.
fn drain_plaintext(tls: &mut ClientConnection, out: &mut Vec<u8>) -> Result<bool, String> {
    let mut buf = [0u8; READ_CHUNK];
    loop {
        match tls.reader().read(&mut buf) {
            Ok(0) => return Ok(true),
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) if is_eof_like(&e) => return Ok(true),
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn is_eof_like(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(
        e.kind(),
        UnexpectedEof | ConnectionReset | ConnectionAborted | BrokenPipe
    )
}

// ---------------------------------------------------------------------------
// Native entry point + event dispatch
// ---------------------------------------------------------------------------

/// `__velox_fetch_start(url, token, method, body)` — kick off the DNS lookup on
/// a worker thread; the connection is opened once the address resolves.
unsafe extern "C-unwind" fn fetch_start(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let url = string_arg(ctx, args, 0).unwrap_or_default();
    let js_token = args
        .get(1)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0);
    let method = string_arg(ctx, args, 2).unwrap_or_else(|| "GET".to_string());
    let body = string_arg(ctx, args, 3).unwrap_or_default();
    let headers = string_arg(ctx, args, 4)
        .and_then(|json| serde_json::from_str::<Vec<(String, String)>>(&json).ok())
        .unwrap_or_default();

    let Some(target) = parse_url(&url) else {
        settle(ctx, js_token, Err(format!("invalid URL: {url}")));
        return unsafe { JSValue::new_undefined(ctx) };
    };

    // Resolve DNS off-thread (there's no portable async `getaddrinfo`), waking
    // the loop when done. The socket I/O afterward is fully async on kqueue.
    let req_id = NEXT_REQ.with(|c| {
        let id = c.get();
        c.set(id.wrapping_add(1));
        id
    });
    let host = target.host.clone();
    let port = target.port;
    let sender = DNS_CHANNEL.with(|(tx, _)| tx.clone());
    let waker = crate::event_loop::waker();

    DNS_PENDING.with(|p| {
        p.borrow_mut().insert(
            req_id,
            PendingRequest {
                js_token,
                target,
                method,
                body,
                headers,
            },
        )
    });
    begin_io();

    std::thread::spawn(move || {
        let result = resolve_address(&host, port);
        let _ = sender.send((req_id, result));
        let _ = waker.wake();
    });

    unsafe { JSValue::new_undefined(ctx) }
}

/// Blocking `getaddrinfo`, run on a worker thread. Prefers IPv4 (matching the
/// common `0.0.0.0` server bind; `localhost` often resolves to `::1` first).
fn resolve_address(host: &str, port: u16) -> Result<SocketAddr, String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("dns lookup failed for {host}: {e}"))?
        .collect();
    addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or_else(|| addrs.first())
        .copied()
        .ok_or_else(|| format!("no addresses for {host}"))
}

/// Drain resolved DNS results and open each connection (or settle on failure).
pub fn on_dns_ready(ctx: JSContextRef) {
    let results: Vec<DnsResult> = DNS_CHANNEL.with(|(_, rx)| {
        let mut drained = Vec::new();
        while let Ok(result) = rx.try_recv() {
            drained.push(result);
        }
        drained
    });

    for (req_id, result) in results {
        let Some(request) = DNS_PENDING.with(|p| p.borrow_mut().remove(&req_id)) else {
            continue;
        };
        let outcome = result.and_then(|address| start_connection(address, &request));
        if let Err(message) = outcome {
            end_io();
            settle(ctx, request.js_token, Err(message));
        }
    }
}

/// Open a non-blocking socket to `address`, register it, and store the
/// connection so the reactor can drive it.
fn start_connection(address: SocketAddr, request: &PendingRequest) -> Result<(), String> {
    let mut sock = TcpStream::connect(address).map_err(|e| e.to_string())?;

    let token = crate::event_loop::next_token();

    registry()
        .register(&mut sock, token, Interest::READABLE | Interest::WRITABLE)
        .map_err(|e| e.to_string())?;

    let target = &request.target;
    let transport = if target.tls {
        let server_name = ServerName::try_from(target.host.clone())
            .map_err(|_| format!("invalid TLS server name: {}", target.host))?;
        let config = TLS_CONFIG.with(Arc::clone);
        let tls = ClientConnection::new(config, server_name).map_err(|e| e.to_string())?;
        Transport::Tls {
            tls: Box::new(tls),
            sock,
        }
    } else {
        Transport::Plain(sock)
    };

    let connection = Connection {
        js_token: request.js_token,
        transport,
        connected: false,
        request: build_request(&request.method, target, &request.body, &request.headers)
            .into_bytes(),
        written: 0,
        response: Vec::new(),
    };

    FETCHES.with(|f| f.borrow_mut().insert(token, connection));
    Ok(())
}

/// Advance the connection for a readiness event, settling its promise when done.
pub fn on_ready(ctx: JSContextRef, event: &mio::event::Event) {
    let token = event.token();
    let Some(mut connection) = FETCHES.with(|f| f.borrow_mut().remove(&token)) else {
        return;
    };

    match connection.pump() {
        Outcome::Pending => {
            FETCHES.with(|f| f.borrow_mut().insert(token, connection));
        }
        Outcome::Done => {
            finish(&mut connection);
            let response = parse_response(&connection.response);
            settle(ctx, connection.js_token, Ok(response));
        }
        Outcome::Failed(message) => {
            finish(&mut connection);
            settle(ctx, connection.js_token, Err(message));
        }
    }
}

/// Deregister the socket and mark the async op complete.
fn finish(connection: &mut Connection) {
    let _ = registry().deregister(connection.transport.socket());
    end_io();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

struct Target {
    tls: bool,
    host: String,
    port: u16,
    path: String,
}

fn parse_url(url: &str) -> Option<Target> {
    let (scheme, rest) = url.split_once("://")?;
    let tls = match scheme {
        "https" => true,
        "http" => false,
        _ => return None,
    };
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => match p.parse::<u16>() {
            Ok(port) => (h.to_string(), port),
            Err(_) => (authority.to_string(), default_port(tls)),
        },
        None => (authority.to_string(), default_port(tls)),
    };
    if host.is_empty() {
        return None;
    }
    Some(Target {
        tls,
        host,
        port,
        path: if path.is_empty() {
            "/".into()
        } else {
            path.into()
        },
    })
}

fn default_port(tls: bool) -> u16 {
    if tls { 443 } else { 80 }
}

fn build_request(
    method: &str,
    target: &Target,
    body: &str,
    headers: &[(String, String)],
) -> String {
    // Which standard headers did the caller override? Compare case-insensitively
    // so we don't emit duplicates (and so user values win).
    let has = |name: &str| headers.iter().any(|(k, _)| k.eq_ignore_ascii_case(name));

    let mut request = format!("{method} {} HTTP/1.1\r\n", target.path);
    if !has("host") {
        request.push_str(&format!("Host: {}\r\n", target.host));
    }
    if !has("user-agent") {
        request.push_str("User-Agent: velox/0.1\r\n");
    }
    if !has("accept") {
        request.push_str("Accept: */*\r\n");
    }
    // Always close the connection (body ends at EOF) — ignore caller's Connection.
    request.push_str("Connection: close\r\n");

    // Caller-supplied headers (skip Connection/Content-Length; we manage those).
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("connection") || k.eq_ignore_ascii_case("content-length") {
            continue;
        }
        request.push_str(&format!("{k}: {v}\r\n"));
    }

    if !body.is_empty() {
        if !has("content-type") {
            request.push_str("Content-Type: text/plain;charset=UTF-8\r\n");
        }
        request.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    request.push_str("\r\n");
    request.push_str(body);
    request
}

struct Response {
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
    body: String,
}

fn parse_response(raw: &[u8]) -> Response {
    let mut headers = [httparse::EMPTY_HEADER; 128];
    let mut response = httparse::Response::new(&mut headers);
    match response.parse(raw) {
        Ok(httparse::Status::Complete(body_start)) => {
            let collected: Vec<(String, String)> = response
                .headers
                .iter()
                .filter(|h| !h.name.is_empty())
                .map(|h| {
                    (
                        h.name.to_string(),
                        String::from_utf8_lossy(h.value).into_owned(),
                    )
                })
                .collect();
            let chunked = collected.iter().any(|(name, value)| {
                name.eq_ignore_ascii_case("transfer-encoding")
                    && value.to_ascii_lowercase().contains("chunked")
            });
            let raw_body = &raw[body_start..];
            let body_bytes = if chunked {
                decode_chunked(raw_body)
            } else {
                raw_body.to_vec()
            };
            Response {
                status: response.code.unwrap_or(0),
                status_text: response.reason.unwrap_or("").to_string(),
                headers: collected,
                body: String::from_utf8_lossy(&body_bytes).into_owned(),
            }
        }
        _ => Response {
            status: 0,
            status_text: String::new(),
            headers: Vec::new(),
            body: String::from_utf8_lossy(raw).into_owned(),
        },
    }
}

/// Decode an HTTP/1.1 chunked body: a sequence of `<hex-size>\r\n<data>\r\n`
/// runs terminated by a zero-size chunk.
fn decode_chunked(mut data: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(line_end) = find(data, b"\r\n") {
        // The size line may carry `;ext` chunk extensions — ignore them.
        let size_field = &data[..line_end];
        let hex = size_field.split(|&b| b == b';').next().unwrap_or(&[]);
        let size = std::str::from_utf8(hex)
            .ok()
            .and_then(|s| usize::from_str_radix(s.trim(), 16).ok())
            .unwrap_or(0);

        data = &data[line_end + 2..];
        if size == 0 {
            break;
        }
        if data.len() < size {
            out.extend_from_slice(data); // truncated; salvage what we have
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size..];
        if data.starts_with(b"\r\n") {
            data = &data[2..];
        }
    }
    out
}

/// Find the first occurrence of `needle` in `haystack`.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

// ---------------------------------------------------------------------------
// Settling the JS promise (C API)
// ---------------------------------------------------------------------------

fn string_arg(ctx: JSContextRef, args: &[JSValueRef], index: usize) -> Option<String> {
    args.get(index)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
}

/// Settle the JS promise for `token` by calling
/// `__velox_fetch_settle(token, ok, status, statusText, headersJson, body)`.
fn settle(ctx: JSContextRef, token: f64, result: Result<Response, String>) {
    let (ok, status, status_text, headers_json, body) = match result {
        Ok(response) => (
            true,
            response.status as f64,
            response.status_text,
            headers_to_json(&response.headers),
            response.body,
        ),
        Err(message) => (false, 0.0, String::new(), "[]".to_string(), message),
    };

    unsafe {
        let args = [
            JSValue::new_number(ctx, token),
            JSValue::new_boolean(ctx, ok),
            JSValue::new_number(ctx, status),
            js_string(ctx, &status_text),
            js_string(ctx, &headers_json),
            js_string(ctx, &body),
        ];
        call_global(ctx, c"__velox_fetch_settle", &args);
    }
}

/// Serialize headers as a JSON array of `[name, value]` pairs (preserving order
/// and duplicates) for the JS side to assemble into a `Headers` object.
fn headers_to_json(headers: &[(String, String)]) -> String {
    let mut out = String::from("[");
    for (i, (name, value)) in headers.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        json_escape(name, &mut out);
        out.push(',');
        json_escape(value, &mut out);
        out.push(']');
    }
    out.push(']');
    out
}

/// Append `text` to `out` as a quoted, escaped JSON string.
fn json_escape(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Build a JS string value from a Rust string (NULs are stripped).
unsafe fn js_string(ctx: JSContextRef, text: &str) -> JSValueRef {
    let cstring = CString::new(text.replace('\0', "")).unwrap_or_default();
    unsafe {
        let js = JSStringCreateWithUTF8CString(cstring.as_ptr());
        let value = JSValue::new_string(ctx, js);
        JSStringRelease(js);
        value
    }
}

/// Call a global JS function by name, reporting any thrown exception.
unsafe fn call_global(ctx: JSContextRef, name: &CStr, args: &[JSValueRef]) {
    unsafe {
        let global = JSContext::global_object(ctx);
        let name_str = JSStringCreateWithUTF8CString(name.as_ptr());
        let function_value = JSObjectGetProperty(ctx, global, name_str, ptr::null_mut());
        JSStringRelease(name_str);

        let function = JSValue::to_object(ctx, function_value, ptr::null_mut());
        if function.is_null() {
            return;
        }

        let mut exception: JSValueRef = ptr::null();
        JSObjectCallAsFunction(
            ctx,
            function,
            ptr::null_mut(),
            args.len(),
            args.as_ptr() as *mut JSValueRef,
            &mut exception,
        );
        if !exception.is_null() {
            let message = js_value_to_string(ctx, exception);
            crate::ui::report_runtime_error(&message);
        }
    }
}

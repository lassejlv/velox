//! TCP/HTTP server support, multiplexed on the same kqueue reactor as `fetch`.
//!
//! A listening socket is registered with the loop's `mio::Poll`; on readiness
//! it accepts connections (each its own non-blocking socket) and bridges their
//! bytes to JS through global callbacks (`__velox_on_connection`/`_data`/`_end`/
//! `_close`/`_error`). The `net`/`http` shims (`src/builtins/`) build the
//! `Server`/`Socket`/request/response objects on top. Payloads cross as
//! binary-safe latin1 strings, like `fetch`.

use std::cell::RefCell;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, ToSocketAddrs};
use std::ptr;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, Sender};

use mio::net::{TcpListener, TcpStream};
use mio::{Interest, Token};
use objc2_javascript_core::{JSContextRef, JSObjectRef, JSValue, JSValueRef};
use rustls::{
    ClientConfig, ClientConnection, Connection as TlsConnection, RootCertStore, ServerConfig,
    ServerConnection,
};
use rustls_pki_types::{PrivateKeyDer, ServerName};

use crate::event_loop::{arg_slice, begin_io, end_io, next_token, register, registry};
use crate::node::{call_named, js_string, js_uint8array, js_value_to_bytes, js_value_to_latin1};
use crate::runtime::js_value_to_string;

const READ_CHUNK: usize = 16 * 1024;

struct Listener {
    listener: TcpListener,
    /// `Some` for an HTTPS listener: accepted connections are TLS-terminated.
    tls_config: Option<Arc<ServerConfig>>,
    /// The actually-bound local port (resolved even when JS asked for port 0).
    local_port: u16,
}

struct Conn {
    stream: TcpStream,
    /// `Some` for a TLS connection — outbound (`tls.connect`/`https`) client or
    /// inbound (`https` server) — unified under rustls' `Connection`.
    tls: Option<Box<TlsConnection>>,
    write_buf: Vec<u8>,
    /// Whether WRITABLE interest is currently registered.
    want_write: bool,
    /// Close the socket once the write buffer drains.
    closing: bool,
    /// An outbound socket still completing its connect (and TLS handshake).
    connecting: bool,
}

/// An outbound `net.connect`/`tls.connect` awaiting DNS before its socket opens.
struct PendingConnect {
    /// Bytes written by JS before the socket connected.
    write_buf: Vec<u8>,
    /// JS called `end()` before the socket connected.
    ended: bool,
    /// `Some(host)` for a TLS connection (the SNI name); `None` for plain TCP.
    tls_host: Option<String>,
    /// Advertise ALPN `h2`/`http/1.1` on the TLS handshake (for http2.connect).
    alpn: bool,
}

type DnsResult = (Token, Result<SocketAddr, String>);

thread_local! {
    static SERVERS: RefCell<HashMap<Token, Listener>> = RefCell::new(HashMap::new());
    static CONNS: RefCell<HashMap<Token, Conn>> = RefCell::new(HashMap::new());
    /// Outbound connections keyed by their (pre-allocated) token, awaiting DNS.
    static CONNECTS: RefCell<HashMap<Token, PendingConnect>> = RefCell::new(HashMap::new());
    static DNS_CHANNEL: (Sender<DnsResult>, Receiver<DnsResult>) = mpsc::channel();
    /// Shared TLS client config (roots + ring provider), built once.
    static TLS_CONFIG: Arc<ClientConfig> = Arc::new(build_tls_config());
    /// Variant that advertises ALPN `h2`/`http/1.1` — for `http2.connect`/TLS
    /// sockets that request ALPN. Kept separate so ordinary TLS clients don't
    /// negotiate h2 and surprise callers expecting HTTP/1.1.
    static TLS_CONFIG_H2: Arc<ClientConfig> = Arc::new(build_tls_config_alpn());
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

fn build_tls_config_alpn() -> ClientConfig {
    let mut config = build_tls_config();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    config
}

fn make_tls(host: &str, alpn: bool) -> Result<Box<TlsConnection>, String> {
    let server_name = ServerName::try_from(host.to_string())
        .map_err(|_| format!("invalid TLS server name: {host}"))?;
    let config = if alpn {
        TLS_CONFIG_H2.with(Arc::clone)
    } else {
        TLS_CONFIG.with(Arc::clone)
    };
    let conn = ClientConnection::new(config, server_name).map_err(|e| e.to_string())?;
    Ok(Box::new(TlsConnection::Client(conn)))
}

fn is_eof_like(e: &std::io::Error) -> bool {
    use std::io::ErrorKind::*;
    matches!(
        e.kind(),
        UnexpectedEof | ConnectionReset | ConnectionAborted | BrokenPipe
    )
}

impl Conn {
    /// Read all currently-available bytes (decrypting if TLS). Returns
    /// `(data, eof, error)`.
    fn read_available(&mut self) -> (Vec<u8>, bool, Option<String>) {
        let mut out = Vec::new();
        let Some(tls) = self.tls.as_mut() else {
            let mut buf = [0u8; READ_CHUNK];
            loop {
                match self.stream.read(&mut buf) {
                    Ok(0) => return (out, true, None),
                    Ok(n) => out.extend_from_slice(&buf[..n]),
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        return (out, false, None);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(ref e) if is_eof_like(e) => return (out, true, None),
                    Err(e) => return (out, false, Some(e.to_string())),
                }
            }
        };
        loop {
            match tls.complete_io(&mut self.stream) {
                Ok(_) => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(ref e) if is_eof_like(e) => {
                    drain_plaintext(tls, &mut out);
                    return (out, true, None);
                }
                Err(e) => return (out, false, Some(e.to_string())),
            }
            let mut buf = [0u8; READ_CHUNK];
            match tls.reader().read(&mut buf) {
                Ok(0) => return (out, true, None),
                Ok(n) => out.extend_from_slice(&buf[..n]),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    return (out, false, None);
                }
                Err(ref e) if is_eof_like(e) => return (out, true, None),
                Err(e) => return (out, false, Some(e.to_string())),
            }
        }
    }

    /// Push the write buffer toward the socket (encrypting if TLS).
    fn flush(&mut self, token: Token) -> Flush {
        if let Some(tls) = self.tls.as_mut() {
            if !self.write_buf.is_empty() {
                if let Err(e) = tls.writer().write_all(&self.write_buf) {
                    return Flush::Error(e.to_string());
                }
                self.write_buf.clear();
            }
            // Flush encrypted output to the socket directly — `complete_io`
            // would attempt a read first and return `WouldBlock` before writing.
            while tls.wants_write() {
                match tls.write_tls(&mut self.stream) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(e) => return Flush::Error(e.to_string()),
                }
            }
            let pending = tls.wants_write();
            return self.finish_flush(token, pending);
        }
        while !self.write_buf.is_empty() {
            match self.stream.write(&self.write_buf) {
                Ok(0) => return Flush::Error("connection closed while writing".into()),
                Ok(n) => {
                    self.write_buf.drain(..n);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Flush::Error(e.to_string()),
            }
        }
        let pending = !self.write_buf.is_empty();
        self.finish_flush(token, pending)
    }

    /// Adjust interest after a flush and decide whether to close.
    fn finish_flush(&mut self, token: Token, pending: bool) -> Flush {
        if pending {
            if !self.want_write {
                self.want_write = true;
                let _ = registry().reregister(
                    &mut self.stream,
                    token,
                    Interest::READABLE | Interest::WRITABLE,
                );
            }
            return Flush::Pending;
        }
        if self.connecting {
            return Flush::Idle; // keep WRITABLE for connect/handshake completion
        }
        if self.closing {
            return Flush::Done;
        }
        if self.want_write {
            self.want_write = false;
            let _ = registry().reregister(&mut self.stream, token, Interest::READABLE);
        }
        Flush::Idle
    }

    /// Advance an outbound connect: check the TCP result and drive the TLS
    /// handshake. Returns `Ok(true)` when fully ready, `Ok(false)` if the TLS
    /// handshake needs more I/O, `Err` on failure.
    fn drive_handshake(&mut self) -> Result<bool, String> {
        match self.stream.take_error() {
            Ok(Some(e)) => return Err(e.to_string()),
            Err(e) => return Err(e.to_string()),
            Ok(None) => {}
        }
        let Some(tls) = self.tls.as_mut() else {
            return Ok(true);
        };
        loop {
            match tls.complete_io(&mut self.stream) {
                Ok((read, wrote)) => {
                    if !tls.is_handshaking() {
                        return Ok(true);
                    }
                    if read + wrote == 0 {
                        return Ok(false);
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e.to_string()),
            }
        }
    }
}

fn drain_plaintext(tls: &mut TlsConnection, out: &mut Vec<u8>) {
    let mut buf = [0u8; READ_CHUNK];
    while let Ok(n) = tls.reader().read(&mut buf) {
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
    }
}

/// Register the native server hooks.
pub fn install(ctx: JSContextRef) {
    unsafe {
        register(ctx, c"__velox_listen", listen);
        register(ctx, c"__velox_listen_tls", listen_tls);
        register(ctx, c"__velox_server_port", server_port);
        register(ctx, c"__velox_connect", connect);
        register(ctx, c"__velox_connect_tls", connect_tls);
        register(ctx, c"__velox_socket_alpn", socket_alpn);
        register(ctx, c"__velox_socket_write", socket_write);
        register(ctx, c"__velox_socket_write_bytes", socket_write_bytes);
        register(ctx, c"__velox_socket_end", socket_end);
        register(ctx, c"__velox_socket_close", socket_close);
        register(ctx, c"__velox_close_server", close_server);
    }
}

// ---------------------------------------------------------------------------
// Reactor dispatch
// ---------------------------------------------------------------------------

/// Drive a server listener or connection on a readiness event. Tokens not owned
/// here are ignored (they belong to another driver, e.g. `fetch`).
pub fn on_ready(ctx: JSContextRef, event: &mio::event::Event) {
    let token = event.token();

    if SERVERS.with(|s| s.borrow().contains_key(&token)) {
        accept_all(ctx, token);
        return;
    }
    if !CONNS.with(|c| c.borrow().contains_key(&token)) {
        return;
    }

    // Finish an outbound connect (TCP + TLS handshake) before reading/writing.
    // The handshake needs both directions, so run it on any readiness.
    let connecting = CONNS.with(|c| c.borrow().get(&token).is_some_and(|conn| conn.connecting));
    if connecting {
        if !complete_connect(ctx, token) {
            return; // failed/closed
        }
        // Still handshaking, or gone: wait for the next event.
        let ready = CONNS.with(|c| {
            c.borrow()
                .get(&token)
                .map(|conn| !conn.connecting)
                .unwrap_or(false)
        });
        if !ready {
            return;
        }
    }

    if event.is_readable() {
        read_conn(ctx, token);
    }
    // Always flush afterward: this pushes any pending TLS output (e.g. the
    // server-side handshake response) and re-arms interest. Cheap when idle.
    if CONNS.with(|c| c.borrow().contains_key(&token)) {
        flush_conn(ctx, token);
    }
}

/// Drive an outbound connect/handshake. Emits `on_connect` once ready. Returns
/// `false` only if the connection failed and was closed.
fn complete_connect(ctx: JSContextRef, token: Token) -> bool {
    let result = CONNS.with(|c| {
        let mut map = c.borrow_mut();
        match map.get_mut(&token) {
            Some(conn) => conn.drive_handshake(),
            None => Err(String::new()),
        }
    });
    match result {
        Ok(true) => {
            CONNS.with(|c| {
                if let Some(conn) = c.borrow_mut().get_mut(&token) {
                    conn.connecting = false;
                }
            });
            unsafe {
                let args = [num(ctx, token)];
                call_named(ctx, c"__velox_on_connect", &args);
            }
            // Send anything buffered before the connection was ready.
            flush_conn(ctx, token);
            true
        }
        Ok(false) => true, // handshake in progress; stay connecting
        Err(message) => {
            if !message.is_empty() {
                emit_error(ctx, token, &message);
            }
            close_conn(ctx, token);
            false
        }
    }
}

/// Accept every pending connection on a listener.
fn accept_all(ctx: JSContextRef, server_token: Token) {
    let tls_config = SERVERS.with(|s| {
        s.borrow()
            .get(&server_token)
            .and_then(|l| l.tls_config.clone())
    });
    loop {
        let accepted = SERVERS.with(|s| {
            s.borrow_mut()
                .get_mut(&server_token)
                .map(|l| l.listener.accept())
        });
        match accepted {
            None => return,
            Some(Ok((mut stream, _addr))) => {
                let token = next_token();
                let _ = registry().register(
                    &mut stream,
                    token,
                    Interest::READABLE | Interest::WRITABLE,
                );
                // For HTTPS, terminate TLS: the server-side handshake is driven
                // by `read_available`/`flush` like any other TLS connection.
                let tls = tls_config.as_ref().and_then(|config| {
                    ServerConnection::new(config.clone())
                        .ok()
                        .map(|c| Box::new(TlsConnection::Server(c)))
                });
                CONNS.with(|c| {
                    c.borrow_mut().insert(
                        token,
                        Conn {
                            stream,
                            tls,
                            write_buf: Vec::new(),
                            want_write: true,
                            closing: false,
                            connecting: false,
                        },
                    )
                });
                begin_io();
                unsafe {
                    let args = [num(ctx, server_token), num(ctx, token)];
                    call_named(ctx, c"__velox_on_connection", &args);
                }
            }
            Some(Err(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock => return,
            Some(Err(ref e)) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Some(Err(_)) => return,
        }
    }
}

/// Read all available bytes from a connection (decrypting if TLS) and forward
/// them to JS, then signal EOF if the peer closed.
fn read_conn(ctx: JSContextRef, token: Token) {
    let (data, eof, error) = CONNS.with(|c| {
        let mut map = c.borrow_mut();
        match map.get_mut(&token) {
            Some(conn) => conn.read_available(),
            None => (Vec::new(), false, None),
        }
    });

    if let Some(message) = error {
        emit_error(ctx, token, &message);
        close_conn(ctx, token);
        return;
    }
    if !data.is_empty() {
        unsafe {
            // Hand JS the bytes as a Uint8Array (becomes a Buffer) — no latin1
            // string round-trip.
            let chunk = js_uint8array(ctx, &data);
            let args = [num(ctx, token), chunk];
            call_named(ctx, c"__velox_on_data", &args);
        }
        // JS may have closed the socket during the callback.
        if !CONNS.with(|c| c.borrow().contains_key(&token)) {
            return;
        }
    }
    if eof {
        unsafe {
            let args = [num(ctx, token)];
            call_named(ctx, c"__velox_on_end", &args);
        }
        close_conn(ctx, token);
    }
}

enum Flush {
    Idle,
    Pending,
    Done,
    Error(String),
}

/// Write as much of the connection's buffer as possible without blocking.
fn flush_conn(ctx: JSContextRef, token: Token) {
    let outcome = CONNS.with(|c| {
        let mut map = c.borrow_mut();
        match map.get_mut(&token) {
            Some(conn) => conn.flush(token),
            None => Flush::Idle,
        }
    });

    match outcome {
        Flush::Done => close_conn(ctx, token),
        Flush::Error(message) => {
            emit_error(ctx, token, &message);
            close_conn(ctx, token);
        }
        Flush::Idle | Flush::Pending => {}
    }
}

/// Deregister, drop, and notify JS that a connection closed.
fn close_conn(ctx: JSContextRef, token: Token) {
    let removed = CONNS.with(|c| c.borrow_mut().remove(&token));
    if let Some(mut conn) = removed {
        let _ = registry().deregister(&mut conn.stream);
        end_io();
        unsafe {
            let args = [num(ctx, token)];
            call_named(ctx, c"__velox_on_close", &args);
        }
    }
}

fn emit_error(ctx: JSContextRef, token: Token, message: &str) {
    unsafe {
        let args = [num(ctx, token), js_string(ctx, message)];
        call_named(ctx, c"__velox_on_error", &args);
    }
}

// ---------------------------------------------------------------------------
// Native functions
// ---------------------------------------------------------------------------

/// `__velox_listen(port, host)` → numeric server id (throws on bind error).
unsafe extern "C-unwind" fn listen(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    unsafe { bind_listener(ctx, args, None, exception) }
}

/// `__velox_listen_tls(port, host, certPem, keyPem)` → HTTPS server id. Empty
/// cert/key generates a self-signed certificate (dev convenience).
unsafe extern "C-unwind" fn listen_tls(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let cert_pem = args.get(2).map(|v| unsafe { js_value_to_string(ctx, *v) });
    let key_pem = args.get(3).map(|v| unsafe { js_value_to_string(ctx, *v) });
    let config = match build_server_config(cert_pem.as_deref(), key_pem.as_deref()) {
        Ok(config) => config,
        Err(message) => return unsafe { throw(ctx, exception, "ERR_TLS", &message) },
    };
    unsafe { bind_listener(ctx, args, Some(Arc::new(config)), exception) }
}

/// Shared bind logic for `listen`/`listen_tls`.
unsafe fn bind_listener(
    ctx: JSContextRef,
    args: &[JSValueRef],
    tls_config: Option<Arc<ServerConfig>>,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let port = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0) as u16;
    let host = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "0.0.0.0".to_string());

    let address = match resolve_bind_addr(&host, port) {
        Some(addr) => addr,
        None => {
            return unsafe {
                throw(
                    ctx,
                    exception,
                    "EADDRNOTAVAIL",
                    &format!("invalid address {host}:{port}"),
                )
            };
        }
    };

    let mut listener = match TcpListener::bind(address) {
        Ok(listener) => listener,
        Err(e) => {
            let code = if e.kind() == std::io::ErrorKind::AddrInUse {
                "EADDRINUSE"
            } else if e.kind() == std::io::ErrorKind::PermissionDenied {
                "EACCES"
            } else {
                "EADDRNOTAVAIL"
            };
            return unsafe { throw(ctx, exception, code, &format!("listen {address}: {e}")) };
        }
    };

    // Capture the real bound port — when JS asked for 0, the OS picked one.
    let local_port = listener.local_addr().map(|a| a.port()).unwrap_or(port);

    let token = next_token();
    let _ = registry().register(&mut listener, token, Interest::READABLE);
    SERVERS.with(|s| {
        s.borrow_mut().insert(
            token,
            Listener {
                listener,
                tls_config,
                local_port,
            },
        )
    });
    begin_io();
    unsafe { JSValue::new_number(ctx, token.0 as f64) }
}

/// `__velox_server_port(serverId)` → the actual bound local port (0 if unknown).
unsafe extern "C-unwind" fn server_port(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0) as usize;
    let port = SERVERS.with(|s| {
        s.borrow()
            .get(&Token(id))
            .map(|l| l.local_port)
            .unwrap_or(0)
    });
    unsafe { JSValue::new_number(ctx, port as f64) }
}

/// Build a rustls `ServerConfig` from PEM cert+key, or a self-signed cert when
/// they're absent/empty.
fn build_server_config(
    cert_pem: Option<&str>,
    key_pem: Option<&str>,
) -> Result<ServerConfig, String> {
    let (certs, key) = match (cert_pem, key_pem) {
        (Some(c), Some(k)) if !c.trim().is_empty() && !k.trim().is_empty() => {
            let certs = rustls_pemfile::certs(&mut c.as_bytes())
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            let key = rustls_pemfile::private_key(&mut k.as_bytes())
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "no private key found in PEM".to_string())?;
            (certs, key)
        }
        _ => {
            let generated = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
                .map_err(|e| e.to_string())?;
            let cert = generated.cert.der().clone();
            let key = PrivateKeyDer::try_from(generated.signing_key.serialize_der())
                .map_err(|e| e.to_string())?;
            (vec![cert], key)
        }
    };

    ServerConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(|e| e.to_string())
}

/// `__velox_connect(host, port)` → numeric socket id (connects asynchronously).
unsafe extern "C-unwind" fn connect(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    unsafe { start_connect(ctx, arg_slice(argc, argv), false) }
}

/// `__velox_connect_tls(host, port)` → numeric socket id for a TLS connection.
unsafe extern "C-unwind" fn connect_tls(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    unsafe { start_connect(ctx, arg_slice(argc, argv), true) }
}

/// Begin an outbound connection: resolve DNS off-thread and register the
/// pending connect. `tls` selects a TLS handshake after connecting.
unsafe fn start_connect(ctx: JSContextRef, args: &[JSValueRef], tls: bool) -> JSValueRef {
    let host = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "localhost".to_string());
    let port = args
        .get(1)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0) as u16;
    // args[2] (optional): non-zero requests ALPN h2/http1.1 on the handshake.
    let alpn = args
        .get(2)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0)
        != 0.0;

    let token = next_token();
    CONNECTS.with(|c| {
        c.borrow_mut().insert(
            token,
            PendingConnect {
                write_buf: Vec::new(),
                ended: false,
                tls_host: tls.then(|| host.clone()),
                alpn,
            },
        )
    });
    begin_io();

    // Resolve DNS off-thread (same approach as fetch), then wake the loop.
    let sender = DNS_CHANNEL.with(|(tx, _)| tx.clone());
    let waker = crate::event_loop::waker();
    std::thread::spawn(move || {
        let result = resolve_address(&host, port);
        let _ = sender.send((token, result));
        let _ = waker.wake();
    });

    unsafe { JSValue::new_number(ctx, token.0 as f64) }
}

fn resolve_address(host: &str, port: u16) -> Result<SocketAddr, String> {
    let addrs: Vec<SocketAddr> = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("dns lookup failed for {host}: {e}"))?
        .collect();
    // Prefer IPv4 — `localhost` often resolves to `::1` first, but servers
    // commonly bind IPv4 `0.0.0.0`.
    addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or_else(|| addrs.first())
        .copied()
        .ok_or_else(|| format!("no addresses for {host}"))
}

/// Open outbound sockets for connects whose DNS just resolved.
pub fn on_dns_ready(ctx: JSContextRef) {
    let results: Vec<DnsResult> = DNS_CHANNEL.with(|(_, rx)| {
        let mut drained = Vec::new();
        while let Ok(result) = rx.try_recv() {
            drained.push(result);
        }
        drained
    });

    for (token, result) in results {
        let Some(pending) = CONNECTS.with(|c| c.borrow_mut().remove(&token)) else {
            continue; // cancelled before DNS resolved
        };
        let address = match result {
            Ok(address) => address,
            Err(message) => {
                fail_connect(ctx, token, &message);
                continue;
            }
        };
        // Build the TLS client connection up front (if requested).
        let tls = match &pending.tls_host {
            Some(host) => match make_tls(host, pending.alpn) {
                Ok(conn) => Some(conn),
                Err(message) => {
                    fail_connect(ctx, token, &message);
                    continue;
                }
            },
            None => None,
        };

        match TcpStream::connect(address) {
            Ok(mut stream) => {
                let _ = registry().register(
                    &mut stream,
                    token,
                    Interest::READABLE | Interest::WRITABLE,
                );
                CONNS.with(|c| {
                    c.borrow_mut().insert(
                        token,
                        Conn {
                            stream,
                            tls,
                            write_buf: pending.write_buf,
                            want_write: true,
                            closing: pending.ended,
                            connecting: true,
                        },
                    )
                });
            }
            Err(e) => fail_connect(ctx, token, &e.to_string()),
        }
    }
}

/// Report a failed outbound connect to JS and release its `begin_io`.
fn fail_connect(ctx: JSContextRef, token: Token, message: &str) {
    emit_error(ctx, token, message);
    unsafe {
        let args = [num(ctx, token)];
        call_named(ctx, c"__velox_on_close", &args);
    }
    end_io();
}

/// `__velox_socket_alpn(socketId)` → the negotiated ALPN protocol (e.g. "h2"),
/// or "" if none / not a TLS connection. Valid after the connection is ready
/// (velox emits `on_connect` only after the TLS handshake completes).
unsafe extern "C-unwind" fn socket_alpn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let token = socket_token(ctx, args.first());
    let proto = CONNS.with(|c| {
        c.borrow()
            .get(&token)
            .and_then(|conn| conn.tls.as_ref())
            .and_then(|tls| {
                tls.alpn_protocol()
                    .map(|p| String::from_utf8_lossy(p).into_owned())
            })
    });
    unsafe { js_string(ctx, &proto.unwrap_or_default()) }
}

/// `__velox_socket_write(socketId, latin1)` — queue bytes and try to flush.
unsafe extern "C-unwind" fn socket_write(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let token = socket_token(ctx, args.first());
    let data = args
        .get(1)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default();
    queue_socket_write(ctx, token, data);
    unsafe { JSValue::new_undefined(ctx) }
}

/// `__velox_socket_write_bytes(socketId, uint8array)` — like `socket_write` but
/// takes the bytes directly from a typed array (no latin1 round-trip).
unsafe extern "C-unwind" fn socket_write_bytes(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let token = socket_token(ctx, args.first());
    let data = args
        .get(1)
        .map(|v| unsafe { js_value_to_bytes(ctx, *v) })
        .unwrap_or_default();
    queue_socket_write(ctx, token, data);
    unsafe { JSValue::new_undefined(ctx) }
}

/// Buffer `data` for the socket and flush (unless still connecting/resolving).
fn queue_socket_write(ctx: JSContextRef, token: Token, data: Vec<u8>) {
    let state = CONNS.with(|c| {
        c.borrow_mut().get_mut(&token).map(|conn| {
            conn.write_buf.extend_from_slice(&data);
            conn.connecting
        })
    });
    match state {
        Some(false) => flush_conn(ctx, token),
        Some(true) => {}
        None => {
            // Still resolving DNS: hold the bytes until the socket opens.
            CONNECTS.with(|c| {
                if let Some(pending) = c.borrow_mut().get_mut(&token) {
                    pending.write_buf.extend_from_slice(&data);
                }
            });
        }
    }
}

/// `__velox_socket_end(socketId)` — close once the write buffer drains.
unsafe extern "C-unwind" fn socket_end(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let token = socket_token(ctx, args.first());
    let in_conns = CONNS.with(|c| {
        if let Some(conn) = c.borrow_mut().get_mut(&token) {
            conn.closing = true;
            true
        } else {
            false
        }
    });
    if in_conns {
        flush_conn(ctx, token);
    } else {
        CONNECTS.with(|c| {
            if let Some(pending) = c.borrow_mut().get_mut(&token) {
                pending.ended = true;
            }
        });
    }
    unsafe { JSValue::new_undefined(ctx) }
}

/// `__velox_socket_close(socketId)` — close immediately.
unsafe extern "C-unwind" fn socket_close(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let token = socket_token(ctx, args.first());
    if CONNS.with(|c| c.borrow().contains_key(&token)) {
        close_conn(ctx, token);
    } else if CONNECTS.with(|c| c.borrow_mut().remove(&token)).is_some() {
        // Cancelled before the socket opened; the DNS result will be ignored.
        end_io();
    }
    unsafe { JSValue::new_undefined(ctx) }
}

/// `__velox_close_server(serverId)` — stop listening.
unsafe extern "C-unwind" fn close_server(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let token = socket_token(ctx, args.first());
    let removed = SERVERS.with(|s| s.borrow_mut().remove(&token));
    if let Some(mut server) = removed {
        let _ = registry().deregister(&mut server.listener);
        end_io();
    }
    unsafe { JSValue::new_undefined(ctx) }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Read an id argument and turn it into its `mio` token.
fn socket_token(ctx: JSContextRef, value: Option<&JSValueRef>) -> Token {
    let id = value
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0);
    Token(id as usize)
}

/// A token's id as a JS number.
unsafe fn num(ctx: JSContextRef, token: Token) -> JSValueRef {
    unsafe { JSValue::new_number(ctx, token.0 as f64) }
}

fn resolve_bind_addr(host: &str, port: u16) -> Option<SocketAddr> {
    if let Ok(addr) = format!("{host}:{port}").parse::<SocketAddr>() {
        return Some(addr);
    }
    // Prefer IPv4 — `localhost` often resolves to `::1` first, but the outbound
    // connector (`resolve_address`) prefers IPv4, so binding IPv6 here would make
    // a `host: "localhost"` server unreachable from a `localhost` client.
    let addrs: Vec<SocketAddr> = (host, port).to_socket_addrs().ok()?.collect();
    addrs
        .iter()
        .find(|a| a.is_ipv4())
        .or_else(|| addrs.first())
        .copied()
}

/// Throw a Node-style error by setting the callback's exception out-param.
unsafe fn throw(
    ctx: JSContextRef,
    exception: *mut JSValueRef,
    code: &str,
    message: &str,
) -> JSValueRef {
    unsafe {
        let args = [js_string(ctx, code), js_string(ctx, message)];
        let error = call_named(ctx, c"__velox_fs_error", &args);
        if !exception.is_null() {
            *exception = error;
        }
        JSValue::new_undefined(ctx)
    }
}

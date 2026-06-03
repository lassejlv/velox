//! Native system services: `zlib` compression, `dns` lookup, and
//! `child_process`. Binary data crosses the JS boundary as latin1 strings;
//! JSON is used for structured results (parsed with serde_json on the Rust
//! side). Async `exec`/`spawn` run on a worker thread and wake the loop.

use std::io::Read;
use std::ptr;
use std::sync::mpsc::{self, Receiver, Sender};

use objc2_javascript_core::{JSContextRef, JSObjectRef, JSValue, JSValueRef};
use serde_json::Value;

use crate::event_loop::{arg_slice, begin_io, end_io, register, waker};
use crate::node::{call_named, js_string, js_string_latin1, js_value_to_latin1};
use crate::runtime::js_value_to_string;

/// A stdin chunk delivered from the reader thread; `None` marks EOF.
type StdinItem = (f64, Option<Vec<u8>>);
/// An async fs result: `(token, Ok(bytes) | Err((code, message)))`.
type FsResult = (f64, Result<Vec<u8>, (String, String)>);
/// A completed async `exec`/`spawn` job: `(token, resultJson)`.
type ExecResult = (f64, String);

thread_local! {
    /// Completed async `exec`/`spawn` jobs: `(token, resultJson)`.
    static EXEC_CHANNEL: (Sender<ExecResult>, Receiver<ExecResult>) = mpsc::channel();
    /// stdin chunks read on a worker thread.
    static STDIN_CHANNEL: (Sender<StdinItem>, Receiver<StdinItem>) = mpsc::channel();
    /// Completed async fs operations.
    static FS_CHANNEL: (Sender<FsResult>, Receiver<FsResult>) = mpsc::channel();
}

pub fn install(ctx: JSContextRef) {
    unsafe {
        register(ctx, c"__velox_zlib", zlib_fn);
        register(ctx, c"__velox_dns_lookup", dns_lookup);
        register(ctx, c"__velox_dns_resolve", dns_resolve);
        register(ctx, c"__velox_spawn_sync", spawn_sync);
        register(ctx, c"__velox_exec", exec);
        register(ctx, c"__velox_stdin_start", stdin_start);
        register(ctx, c"__velox_stdin_set_raw", stdin_set_raw);
        register(ctx, c"__velox_read_file_async", read_file_async);
        register(ctx, c"__velox_write_file_async", write_file_async);
        register(ctx, c"__velox_fs_op_async", fs_op_async);
    }
}

/// `__velox_fs_op_async(token, op, path)` — run a metadata fs op off-thread.
/// `op` ∈ stat/lstat/readdir/realpath. Result data is UTF-8 (JSON or a path).
unsafe extern "C-unwind" fn fs_op_async(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let token = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0);
    let op = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let path = args
        .get(2)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    // Optional second argument: a dest path (rename/copyFile) or flags string
    // (mkdir/rm — "r" recursive, "f" force).
    let arg2 = args
        .get(3)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();

    let tx = FS_CHANNEL.with(|(t, _)| t.clone());
    let waker = waker();
    begin_io();
    std::thread::spawn(move || {
        let result = run_fs_op(&op, &path, &arg2);
        let _ = tx.send((token, result));
        let _ = waker.wake();
    });
    unsafe { JSValue::new_undefined(ctx) }
}

fn run_fs_op(op: &str, path: &str, arg2: &str) -> Result<Vec<u8>, (String, String)> {
    let to_err = |e: std::io::Error| (errno(&e), e.to_string());
    let ok = || Vec::new();
    match op {
        "stat" => stat_json(path, true).map(String::into_bytes),
        "lstat" => stat_json(path, false).map(String::into_bytes),
        "readdir" => readdir_json(path).map(String::into_bytes),
        "realpath" => std::fs::canonicalize(path)
            .map(|p| p.to_string_lossy().into_owned().into_bytes())
            .map_err(to_err),
        // --- mutation ops (now also off-thread) ---
        "mkdir" => {
            let r = if arg2.contains('r') {
                std::fs::create_dir_all(path)
            } else {
                std::fs::create_dir(path)
            };
            r.map(|_| ok()).map_err(to_err)
        }
        "rmdir" => {
            let r = if arg2.contains('r') {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_dir(path)
            };
            r.map(|_| ok()).map_err(to_err)
        }
        "rm" => {
            let recursive = arg2.contains('r');
            let force = arg2.contains('f');
            let meta = std::fs::symlink_metadata(path);
            let r = match meta {
                Ok(m) if m.is_dir() && recursive => std::fs::remove_dir_all(path),
                Ok(m) if m.is_dir() => std::fs::remove_dir(path),
                Ok(_) => std::fs::remove_file(path),
                Err(_) if force => Ok(()),
                Err(e) => Err(e),
            };
            match r {
                Ok(_) => Ok(ok()),
                Err(e) if force && e.kind() == std::io::ErrorKind::NotFound => Ok(ok()),
                Err(e) => Err(to_err(e)),
            }
        }
        "unlink" => std::fs::remove_file(path).map(|_| ok()).map_err(to_err),
        "rename" => std::fs::rename(path, arg2).map(|_| ok()).map_err(to_err),
        "copyFile" => std::fs::copy(path, arg2).map(|_| ok()).map_err(to_err),
        other => Err(("EINVAL".to_string(), format!("unknown fs op: {other}"))),
    }
}

fn stat_json(path: &str, follow: bool) -> Result<String, (String, String)> {
    use std::os::unix::fs::PermissionsExt;
    use std::time::UNIX_EPOCH;
    let meta = if follow {
        std::fs::metadata(path)
    } else {
        std::fs::symlink_metadata(path)
    }
    .map_err(|e| (errno(&e), e.to_string()))?;
    let kind = if meta.is_file() {
        "file"
    } else if meta.is_dir() {
        "dir"
    } else if meta.file_type().is_symlink() {
        "symlink"
    } else {
        "other"
    };
    let ms = |t: std::io::Result<std::time::SystemTime>| -> u128 {
        t.ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis())
            .unwrap_or(0)
    };
    Ok(format!(
        r#"{{"_type":"{}","size":{},"mode":{},"mtimeMs":{},"atimeMs":{},"ctimeMs":{},"birthtimeMs":{}}}"#,
        kind,
        meta.len(),
        meta.permissions().mode(),
        ms(meta.modified()),
        ms(meta.accessed()),
        ms(meta.modified()),
        ms(meta.created()),
    ))
}

fn readdir_json(path: &str) -> Result<String, (String, String)> {
    let entries = std::fs::read_dir(path).map_err(|e| (errno(&e), e.to_string()))?;
    let mut json = String::from("[");
    for (i, entry) in entries.flatten().enumerate() {
        if i > 0 {
            json.push(',');
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        json.push('"');
        for ch in name.chars() {
            match ch {
                '"' => json.push_str("\\\""),
                '\\' => json.push_str("\\\\"),
                c if (c as u32) < 0x20 => json.push_str(&format!("\\u{:04x}", c as u32)),
                c => json.push(c),
            }
        }
        json.push('"');
    }
    json.push(']');
    Ok(json)
}

/// `__velox_read_file_async(token, path)` — read a file off-thread.
unsafe extern "C-unwind" fn read_file_async(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let token = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0);
    let path = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();

    let tx = FS_CHANNEL.with(|(t, _)| t.clone());
    let waker = waker();
    begin_io();
    std::thread::spawn(move || {
        let result = std::fs::read(&path)
            .map_err(|e| (errno(&e), format!("{}: {}, open '{}'", errno(&e), e, path)));
        let _ = tx.send((token, result));
        let _ = waker.wake();
    });
    unsafe { JSValue::new_undefined(ctx) }
}

/// `__velox_write_file_async(token, path, latin1Data, append)` — write off-thread.
unsafe extern "C-unwind" fn write_file_async(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let token = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0);
    let path = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let data = args
        .get(2)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default();
    let append = args
        .get(3)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(false);

    let tx = FS_CHANNEL.with(|(t, _)| t.clone());
    let waker = waker();
    begin_io();
    std::thread::spawn(move || {
        use std::io::Write;
        let result = if append {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .and_then(|mut f| f.write_all(&data))
        } else {
            std::fs::write(&path, &data)
        };
        let result = result
            .map(|_| Vec::new())
            .map_err(|e| (errno(&e), format!("{}: {}, open '{}'", errno(&e), e, path)));
        let _ = tx.send((token, result));
        let _ = waker.wake();
    });
    unsafe { JSValue::new_undefined(ctx) }
}

fn errno(e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    match e.kind() {
        NotFound => "ENOENT",
        PermissionDenied => "EACCES",
        AlreadyExists => "EEXIST",
        _ => "EIO",
    }
    .to_string()
}

/// Deliver finished async child-process results and stdin chunks to JS.
pub fn on_wake(ctx: JSContextRef) {
    let done: Vec<(f64, String)> = EXEC_CHANNEL.with(|(_, rx)| {
        let mut drained = Vec::new();
        while let Ok(item) = rx.try_recv() {
            drained.push(item);
        }
        drained
    });
    for (token, json) in done {
        unsafe {
            let args = [JSValue::new_number(ctx, token), js_string(ctx, &json)];
            call_named(ctx, c"__velox_exec_done", &args);
        }
        end_io();
    }

    let chunks: Vec<StdinItem> = STDIN_CHANNEL.with(|(_, rx)| {
        let mut drained = Vec::new();
        while let Ok(item) = rx.try_recv() {
            drained.push(item);
        }
        drained
    });
    for (token, chunk) in chunks {
        match chunk {
            Some(data) => unsafe {
                let args = [
                    JSValue::new_number(ctx, token),
                    js_string_latin1(ctx, &data),
                ];
                call_named(ctx, c"__velox_stdin_data", &args);
            },
            None => {
                unsafe {
                    let args = [JSValue::new_number(ctx, token)];
                    call_named(ctx, c"__velox_stdin_end", &args);
                }
                end_io();
            }
        }
    }

    let fs_done: Vec<FsResult> = FS_CHANNEL.with(|(_, rx)| {
        let mut drained = Vec::new();
        while let Ok(item) = rx.try_recv() {
            drained.push(item);
        }
        drained
    });
    for (token, result) in fs_done {
        unsafe {
            let args = match &result {
                Ok(data) => [
                    JSValue::new_number(ctx, token),
                    js_string(ctx, ""),
                    js_string(ctx, ""),
                    js_string_latin1(ctx, data),
                ],
                Err((code, message)) => [
                    JSValue::new_number(ctx, token),
                    js_string(ctx, code),
                    js_string(ctx, message),
                    js_string(ctx, ""),
                ],
            };
            call_named(ctx, c"__velox_fs_done", &args);
        }
        end_io();
    }
}

/// `__velox_stdin_start(token)` — stream stdin to JS on a worker thread.
unsafe extern "C-unwind" fn stdin_start(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let token = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0);

    let tx = STDIN_CHANNEL.with(|(t, _)| t.clone());
    let waker = waker();
    begin_io();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = [0u8; 64 * 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send((token, Some(buf[..n].to_vec()))).is_err() {
                        return;
                    }
                    let _ = waker.wake();
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = tx.send((token, None));
        let _ = waker.wake();
    });
    unsafe { JSValue::new_undefined(ctx) }
}

// ---------------------------------------------------------------------------
// stdin raw mode (terminal)
// ---------------------------------------------------------------------------

/// The terminal's original termios, saved the first time raw mode is enabled so
/// it can be restored on disable or at process exit.
static SAVED_TERMIOS: std::sync::Mutex<Option<libc::termios>> = std::sync::Mutex::new(None);

/// Restore the saved cooked-mode termios. Registered with `atexit` so a program
/// that leaves stdin in raw mode (or panics mid-prompt) doesn't wreck the user's
/// shell.
extern "C" fn restore_termios() {
    if let Ok(saved) = SAVED_TERMIOS.lock()
        && let Some(orig) = saved.as_ref()
    {
        unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, orig) };
    }
}

/// `__velox_stdin_set_raw(enable)` — put stdin into raw mode (no canonical line
/// buffering, no echo, no signal generation) so interactive prompts (inquirer,
/// prompts, create-vite, …) receive individual keypresses. A no-op when stdin
/// isn't a TTY. Mirrors libuv's TTY raw flags; keeps output post-processing so
/// terminal output still renders.
unsafe extern "C-unwind" fn stdin_set_raw(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let enable = args
        .first()
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(false);
    let fd = libc::STDIN_FILENO;
    if unsafe { libc::isatty(fd) } == 0 {
        return unsafe { JSValue::new_undefined(ctx) };
    }
    unsafe {
        if enable {
            let mut term: libc::termios = std::mem::zeroed();
            if libc::tcgetattr(fd, &mut term) != 0 {
                return JSValue::new_undefined(ctx);
            }
            {
                let mut saved = SAVED_TERMIOS.lock().unwrap();
                if saved.is_none() {
                    *saved = Some(term);
                    libc::atexit(restore_termios);
                }
            }
            let mut raw = term;
            raw.c_lflag &= !(libc::ICANON | libc::ECHO | libc::ISIG | libc::IEXTEN);
            raw.c_iflag &= !(libc::ICRNL
                | libc::INLCR
                | libc::IGNCR
                | libc::IXON
                | libc::ISTRIP
                | libc::BRKINT);
            raw.c_cc[libc::VMIN] = 1;
            raw.c_cc[libc::VTIME] = 0;
            libc::tcsetattr(fd, libc::TCSANOW, &raw);
        } else if let Some(orig) = SAVED_TERMIOS.lock().unwrap().as_ref() {
            libc::tcsetattr(fd, libc::TCSANOW, orig);
        }
    }
    unsafe { JSValue::new_undefined(ctx) }
}

// ---------------------------------------------------------------------------
// zlib
// ---------------------------------------------------------------------------

unsafe extern "C-unwind" fn zlib_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let mode = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let input = args
        .get(1)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default();
    match zlib_run(&mode, &input) {
        Ok(out) => unsafe { js_string_latin1(ctx, &out) },
        Err(e) => unsafe { throw(ctx, exception, "Z_ERRNO", &e) },
    }
}

fn zlib_run(mode: &str, input: &[u8]) -> Result<Vec<u8>, String> {
    use flate2::Compression;
    use flate2::read::{
        DeflateDecoder, DeflateEncoder, GzDecoder, GzEncoder, ZlibDecoder, ZlibEncoder,
    };

    let mut out = Vec::new();
    let level = Compression::default();
    let result = match mode {
        "gzip" => GzEncoder::new(input, level).read_to_end(&mut out),
        "gunzip" => GzDecoder::new(input).read_to_end(&mut out),
        "deflate" => ZlibEncoder::new(input, level).read_to_end(&mut out),
        "inflate" => ZlibDecoder::new(input).read_to_end(&mut out),
        "deflateRaw" => DeflateEncoder::new(input, level).read_to_end(&mut out),
        "inflateRaw" => DeflateDecoder::new(input).read_to_end(&mut out),
        "unzip" => {
            if input.len() >= 2 && input[0] == 0x1f && input[1] == 0x8b {
                GzDecoder::new(input).read_to_end(&mut out)
            } else {
                ZlibDecoder::new(input).read_to_end(&mut out)
            }
        }
        "brotliCompress" => {
            brotli::CompressorReader::new(input, 4096, 11, 22).read_to_end(&mut out)
        }
        "brotliDecompress" => brotli::Decompressor::new(input, 4096).read_to_end(&mut out),
        other => return Err(format!("unsupported zlib mode: {other}")),
    };
    result.map_err(|e| e.to_string())?;
    Ok(out)
}

// ---------------------------------------------------------------------------
// dns
// ---------------------------------------------------------------------------

unsafe extern "C-unwind" fn dns_lookup(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let host = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let family = args
        .get(1)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0) as i32;
    match resolve_host(&host, family) {
        Ok(json) => unsafe { js_string(ctx, &json) },
        Err(e) => unsafe { throw(ctx, exception, "ENOTFOUND", &e) },
    }
}

fn resolve_host(host: &str, family: i32) -> Result<String, String> {
    use std::net::ToSocketAddrs;
    let addrs = (host, 0u16)
        .to_socket_addrs()
        .map_err(|_| format!("getaddrinfo ENOTFOUND {host}"))?;
    let mut list: Vec<Value> = Vec::new();
    for addr in addrs {
        let ip = addr.ip();
        let fam = if ip.is_ipv4() { 4 } else { 6 };
        if family == 0 || family == fam {
            list.push(serde_json::json!({ "address": ip.to_string(), "family": fam }));
        }
    }
    if list.is_empty() {
        return Err(format!("getaddrinfo ENOTFOUND {host}"));
    }
    Ok(Value::Array(list).to_string())
}

// ---------------------------------------------------------------------------
// DNS record resolution (TXT/MX/SRV/NS/CNAME/SOA/PTR/CAA/A/AAAA)
//
// getaddrinfo only covers A/AAAA, so `dns.resolveTxt`/`resolveMx`/… need real
// DNS queries. We build a query packet, send it over UDP to the system resolver
// (first `nameserver` in /etc/resolv.conf, else 8.8.8.8), and parse the answer
// records. Synchronous with a 5s timeout, matching `__velox_dns_lookup`.
// ---------------------------------------------------------------------------

fn rrtype_code(rrtype: &str) -> u16 {
    match rrtype {
        "A" => 1,
        "NS" => 2,
        "CNAME" => 5,
        "SOA" => 6,
        "PTR" => 12,
        "MX" => 15,
        "TXT" => 16,
        "AAAA" => 28,
        "SRV" => 33,
        "CAA" => 257,
        "ANY" => 255,
        _ => 1,
    }
}

fn system_nameserver() -> std::net::IpAddr {
    use std::net::{IpAddr, Ipv4Addr};
    if let Ok(content) = std::fs::read_to_string("/etc/resolv.conf") {
        for line in content.lines() {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("nameserver") {
                if let Ok(ip) = rest.trim().parse::<IpAddr>() {
                    return ip;
                }
            }
        }
    }
    IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))
}

/// Read a (possibly compression-pointer-compressed) DNS name starting at `pos`.
/// Returns the name and the position immediately after the name in the original
/// sequence (following the first pointer, per RFC 1035 §4.1.4).
fn dns_read_name(data: &[u8], start: usize) -> (String, usize) {
    let mut name = String::new();
    let mut pos = start;
    let mut next_pos = start;
    let mut jumped = false;
    let mut guard = 0;
    while pos < data.len() && guard < 128 {
        guard += 1;
        let len = data[pos];
        if len & 0xC0 == 0xC0 {
            if pos + 1 >= data.len() {
                break;
            }
            let ptr = (((len & 0x3f) as usize) << 8) | data[pos + 1] as usize;
            if !jumped {
                next_pos = pos + 2;
            }
            jumped = true;
            pos = ptr;
            continue;
        }
        if len == 0 {
            pos += 1;
            if !jumped {
                next_pos = pos;
            }
            break;
        }
        pos += 1;
        if pos + len as usize > data.len() {
            break;
        }
        if !name.is_empty() {
            name.push('.');
        }
        name.push_str(&String::from_utf8_lossy(&data[pos..pos + len as usize]));
        pos += len as usize;
    }
    (name, next_pos)
}

fn dns_query(hostname: &str, rrtype: &str) -> Result<String, String> {
    let qtype = rrtype_code(rrtype);
    let server = system_nameserver();

    // Build the query packet.
    let mut packet: Vec<u8> = Vec::with_capacity(64);
    packet.extend_from_slice(&0x1234u16.to_be_bytes()); // ID
    packet.extend_from_slice(&0x0100u16.to_be_bytes()); // flags: RD
    packet.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
    packet.extend_from_slice(&[0, 0, 0, 0, 0, 0]); // AN/NS/AR counts
    for label in hostname.trim_end_matches('.').split('.') {
        if label.is_empty() {
            continue;
        }
        if label.len() > 63 {
            return Err(format!("dns: label too long in {hostname}"));
        }
        packet.push(label.len() as u8);
        packet.extend_from_slice(label.as_bytes());
    }
    packet.push(0);
    packet.extend_from_slice(&qtype.to_be_bytes());
    packet.extend_from_slice(&1u16.to_be_bytes()); // QCLASS IN

    let sock = std::net::UdpSocket::bind(if server.is_ipv4() {
        "0.0.0.0:0"
    } else {
        "[::]:0"
    })
    .map_err(|e| e.to_string())?;
    sock.set_read_timeout(Some(std::time::Duration::from_secs(5)))
        .ok();
    sock.send_to(&packet, std::net::SocketAddr::new(server, 53))
        .map_err(|e| format!("query{rrtype} EREFUSED {hostname}: {e}"))?;
    let mut buf = [0u8; 4096];
    let n = sock
        .recv(&mut buf)
        .map_err(|_| format!("query{rrtype} ETIMEOUT {hostname}"))?;
    parse_dns_response(&buf[..n], qtype, hostname, rrtype)
}

fn parse_dns_response(
    data: &[u8],
    qtype: u16,
    hostname: &str,
    rrtype: &str,
) -> Result<String, String> {
    if data.len() < 12 {
        return Err(format!("query{rrtype} EBADRESP {hostname}"));
    }
    let rcode = data[3] & 0x0f;
    if rcode == 3 {
        return Err(format!("query{rrtype} ENOTFOUND {hostname}"));
    }
    if rcode != 0 {
        return Err(format!(
            "query{rrtype} ESERVFAIL {hostname} (rcode {rcode})"
        ));
    }
    let qdcount = u16::from_be_bytes([data[4], data[5]]);
    let ancount = u16::from_be_bytes([data[6], data[7]]);
    let mut pos = 12;
    for _ in 0..qdcount {
        let (_, p) = dns_read_name(data, pos);
        pos = p + 4; // QTYPE + QCLASS
    }

    let mut results: Vec<Value> = Vec::new();
    for _ in 0..ancount {
        let (_, p) = dns_read_name(data, pos);
        pos = p;
        if pos + 10 > data.len() {
            break;
        }
        let rtype = u16::from_be_bytes([data[pos], data[pos + 1]]);
        let rdlen = u16::from_be_bytes([data[pos + 8], data[pos + 9]]) as usize;
        pos += 10;
        let rstart = pos;
        if rstart + rdlen > data.len() {
            break;
        }
        if rtype == qtype || qtype == 255 {
            match rtype {
                1 if rdlen == 4 => results.push(Value::String(format!(
                    "{}.{}.{}.{}",
                    data[pos],
                    data[pos + 1],
                    data[pos + 2],
                    data[pos + 3]
                ))),
                28 if rdlen == 16 => {
                    let segs: Vec<String> = (0..8)
                        .map(|i| {
                            format!(
                                "{:x}",
                                u16::from_be_bytes([data[pos + i * 2], data[pos + i * 2 + 1]])
                            )
                        })
                        .collect();
                    results.push(Value::String(segs.join(":")));
                }
                5 | 2 | 12 => {
                    let (name, _) = dns_read_name(data, pos);
                    results.push(Value::String(name));
                }
                15 => {
                    let pref = u16::from_be_bytes([data[pos], data[pos + 1]]);
                    let (exchange, _) = dns_read_name(data, pos + 2);
                    results.push(serde_json::json!({ "priority": pref, "exchange": exchange }));
                }
                16 => {
                    // TXT: one or more length-prefixed chunks → array of strings
                    // (Node's resolveTxt returns string[][], one array per record).
                    let mut chunks: Vec<Value> = Vec::new();
                    let mut tp = pos;
                    while tp < rstart + rdlen {
                        let l = data[tp] as usize;
                        tp += 1;
                        if tp + l > data.len() {
                            break;
                        }
                        chunks.push(Value::String(
                            String::from_utf8_lossy(&data[tp..tp + l]).into_owned(),
                        ));
                        tp += l;
                    }
                    results.push(Value::Array(chunks));
                }
                33 => {
                    let prio = u16::from_be_bytes([data[pos], data[pos + 1]]);
                    let weight = u16::from_be_bytes([data[pos + 2], data[pos + 3]]);
                    let port = u16::from_be_bytes([data[pos + 4], data[pos + 5]]);
                    let (target, _) = dns_read_name(data, pos + 6);
                    results.push(serde_json::json!({ "priority": prio, "weight": weight, "port": port, "name": target }));
                }
                6 => {
                    let (mname, p1) = dns_read_name(data, pos);
                    let (rname, p2) = dns_read_name(data, p1);
                    let rd = |o: usize| {
                        u32::from_be_bytes([data[o], data[o + 1], data[o + 2], data[o + 3]])
                    };
                    if p2 + 20 <= data.len() {
                        results.push(serde_json::json!({
                            "nsname": mname, "hostmaster": rname, "serial": rd(p2),
                            "refresh": rd(p2 + 4), "retry": rd(p2 + 8), "expire": rd(p2 + 12), "minttl": rd(p2 + 16)
                        }));
                    }
                }
                257 => {
                    let flags = data[pos];
                    let taglen = data[pos + 1] as usize;
                    if pos + 2 + taglen <= rstart + rdlen {
                        let tag =
                            String::from_utf8_lossy(&data[pos + 2..pos + 2 + taglen]).into_owned();
                        let val = String::from_utf8_lossy(&data[pos + 2 + taglen..rstart + rdlen])
                            .into_owned();
                        let mut obj = serde_json::Map::new();
                        obj.insert("critical".to_string(), Value::from(flags));
                        obj.insert(tag, Value::String(val));
                        results.push(Value::Object(obj));
                    }
                }
                _ => {}
            }
        }
        pos = rstart + rdlen;
    }

    if results.is_empty() {
        return Err(format!("query{rrtype} ENODATA {hostname}"));
    }
    Ok(Value::Array(results).to_string())
}

/// `__velox_dns_resolve(hostname, rrtype)` → JSON array of records, or throws.
unsafe extern "C-unwind" fn dns_resolve(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let host = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let rrtype = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_else(|| "A".to_string());
    match dns_query(&host, &rrtype) {
        Ok(json) => unsafe { js_string(ctx, &json) },
        Err(e) => unsafe { throw(ctx, exception, "ENOTFOUND", &e) },
    }
}

// ---------------------------------------------------------------------------
// child_process
// ---------------------------------------------------------------------------

unsafe extern "C-unwind" fn spawn_sync(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let (file, cmd_args, opts) = unsafe { read_command_args(ctx, args) };
    let result = run_command(&file, &cmd_args, &opts);
    unsafe { js_string(ctx, &result.to_string()) }
}

unsafe extern "C-unwind" fn exec(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let (file, cmd_args, opts) = unsafe { read_command_args(ctx, args) };
    let token = args
        .get(3)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0);

    let tx = EXEC_CHANNEL.with(|(t, _)| t.clone());
    let waker = waker();
    begin_io();
    std::thread::spawn(move || {
        let result = run_command(&file, &cmd_args, &opts);
        let _ = tx.send((token, result.to_string()));
        let _ = waker.wake();
    });
    unsafe { JSValue::new_undefined(ctx) }
}

/// Read `(file, argsJson, optsJson)` from native args.
unsafe fn read_command_args(
    ctx: JSContextRef,
    args: &[JSValueRef],
) -> (String, Vec<String>, Value) {
    let file = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let cmd_args: Vec<String> = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let opts: Value = args
        .get(2)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    (file, cmd_args, opts)
}

/// Run a process to completion (blocking) and return a Node-shaped result.
fn run_command(file: &str, args: &[String], opts: &Value) -> Value {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let shell = opts.get("shell").map(value_truthy).unwrap_or(false);
    let mut command = if shell {
        let mut c = Command::new("/bin/sh");
        c.arg("-c");
        if args.is_empty() {
            c.arg(file);
        } else {
            c.arg(format!("{} {}", file, args.join(" ")));
        }
        c
    } else {
        let mut c = Command::new(file);
        c.args(args);
        c
    };

    if let Some(cwd) = opts.get("cwd").and_then(Value::as_str) {
        command.current_dir(cwd);
    }
    if let Some(env) = opts.get("env").and_then(Value::as_object) {
        command.env_clear();
        for (key, value) in env {
            if let Some(s) = value.as_str() {
                command.env(key, s);
            }
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let input = opts
        .get("input")
        .and_then(Value::as_str)
        .map(latin1_to_bytes);

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return error_result(0, &e.to_string()),
    };
    let pid = child.id();

    if let Some(stdin) = child.stdin.take() {
        let mut stdin = stdin;
        if let Some(bytes) = &input {
            let _ = stdin.write_all(bytes);
        }
        // dropped here, closing the pipe so readers see EOF
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(e) => return error_result(pid, &e.to_string()),
    };

    let signal = exit_signal(&output.status);
    serde_json::json!({
        "status": output.status.code(),
        "signal": signal,
        "stdout": bytes_to_latin1(&output.stdout),
        "stderr": bytes_to_latin1(&output.stderr),
        "pid": pid,
        "error": Value::Null,
    })
}

fn error_result(pid: u32, message: &str) -> Value {
    serde_json::json!({
        "status": Value::Null,
        "signal": Value::Null,
        "stdout": "",
        "stderr": "",
        "pid": pid,
        "error": message,
    })
}

fn exit_signal(status: &std::process::ExitStatus) -> Value {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(sig) = status.signal() {
            return Value::String(format!("SIG{sig}"));
        }
    }
    let _ = status;
    Value::Null
}

fn value_truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Null => false,
        _ => true,
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Bytes → latin1 string (each byte becomes a `U+00xx` char) for JSON transport.
fn bytes_to_latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

/// latin1 string → bytes (low byte of each char).
fn latin1_to_bytes(s: &str) -> Vec<u8> {
    s.chars().map(|c| c as u8).collect()
}

/// Throw a Node-style `Error` (with `.code`) via the callback's exception slot.
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

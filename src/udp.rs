//! `node:dgram` — UDP sockets on the same kqueue reactor as everything else.
//! Each socket is a `mio::net::UdpSocket` registered for readability; incoming
//! datagrams are drained and bridged to JS (`__velox_on_udp(id, data, addr,
//! port)`). Payloads cross as binary-safe latin1 strings, like the TCP side.

use std::cell::RefCell;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::ptr;

use mio::net::UdpSocket;
use mio::{Interest, Token};
use objc2_javascript_core::{JSContextRef, JSObjectRef, JSValue, JSValueRef};

use crate::event_loop::{arg_slice, begin_io, end_io, next_token, register, registry};
use crate::node::{js_string, js_string_latin1, js_value_to_latin1};
use crate::runtime::js_value_to_string;

thread_local! {
    static SOCKETS: RefCell<HashMap<Token, UdpSocket>> = RefCell::new(HashMap::new());
}

/// Register the native dgram hooks.
pub fn install(ctx: JSContextRef) {
    unsafe {
        register(ctx, c"__velox_udp_bind", udp_bind);
        register(ctx, c"__velox_udp_send", udp_send);
        register(ctx, c"__velox_udp_close", udp_close);
        register(ctx, c"__velox_udp_address", udp_address);
        register(ctx, c"__velox_udp_set_broadcast", udp_set_broadcast);
    }
}

fn arg_str(ctx: JSContextRef, args: &[JSValueRef], i: usize) -> String {
    args.get(i)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default()
}
fn arg_num(ctx: JSContextRef, args: &[JSValueRef], i: usize) -> f64 {
    args.get(i)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0)
}

/// `__velox_udp_bind(port, addr)` → socket id (throws on bind error). `addr` may
/// be empty (defaults to 0.0.0.0). Port 0 binds an OS-assigned port.
unsafe extern "C-unwind" fn udp_bind(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let port = arg_num(ctx, args, 0) as u16;
    let host = {
        let h = arg_str(ctx, args, 1);
        if h.is_empty() {
            "0.0.0.0".to_string()
        } else {
            h
        }
    };
    let addr: SocketAddr = match format!("{host}:{port}").parse() {
        Ok(a) => a,
        Err(_) => {
            return unsafe { throw(ctx, exception, &format!("invalid address {host}:{port}")) };
        }
    };
    let mut sock = match UdpSocket::bind(addr) {
        Ok(s) => s,
        Err(e) => return unsafe { throw(ctx, exception, &e.to_string()) },
    };
    let token = next_token();
    let _ = registry().register(&mut sock, token, Interest::READABLE);
    SOCKETS.with(|s| s.borrow_mut().insert(token, sock));
    begin_io();
    unsafe { JSValue::new_number(ctx, token.0 as f64) }
}

/// `__velox_udp_send(id, dataLatin1, port, addr)` → bytes sent (or throws).
unsafe extern "C-unwind" fn udp_send(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_num(ctx, args, 0) as usize;
    let data = args
        .get(1)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default();
    let port = arg_num(ctx, args, 2) as u16;
    let host = {
        let h = arg_str(ctx, args, 3);
        if h.is_empty() {
            "127.0.0.1".to_string()
        } else {
            h
        }
    };
    let addr: SocketAddr = match format!("{host}:{port}").parse() {
        Ok(a) => a,
        Err(_) => {
            return unsafe { throw(ctx, exception, &format!("invalid address {host}:{port}")) };
        }
    };
    let result = SOCKETS.with(|s| {
        s.borrow()
            .get(&Token(id))
            .map(|sock| sock.send_to(&data, addr))
    });
    match result {
        Some(Ok(n)) => unsafe { JSValue::new_number(ctx, n as f64) },
        Some(Err(e)) => unsafe { throw(ctx, exception, &e.to_string()) },
        None => unsafe { throw(ctx, exception, "socket closed") },
    }
}

/// `__velox_udp_address(id)` → "ip:port" of the local bound address.
unsafe extern "C-unwind" fn udp_address(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_num(ctx, args, 0) as usize;
    let addr = SOCKETS.with(|s| {
        s.borrow()
            .get(&Token(id))
            .and_then(|sock| sock.local_addr().ok())
            .map(|a| a.to_string())
            .unwrap_or_default()
    });
    unsafe { js_string(ctx, &addr) }
}

/// `__velox_udp_set_broadcast(id, on)`.
unsafe extern "C-unwind" fn udp_set_broadcast(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_num(ctx, args, 0) as usize;
    let on = args
        .get(1)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(false);
    SOCKETS.with(|s| {
        if let Some(sock) = s.borrow().get(&Token(id)) {
            let _ = sock.set_broadcast(on);
        }
    });
    unsafe { JSValue::new_undefined(ctx) }
}

/// `__velox_udp_close(id)`.
unsafe extern "C-unwind" fn udp_close(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_num(ctx, args, 0) as usize;
    let removed = SOCKETS.with(|s| s.borrow_mut().remove(&Token(id)));
    if let Some(mut sock) = removed {
        let _ = registry().deregister(&mut sock);
        end_io();
    }
    unsafe { JSValue::new_undefined(ctx) }
}

/// Drain readable datagrams for a socket and dispatch each to JS. Datagrams are
/// recv'd out from under the borrow first, then JS is called (reactor invariant:
/// never hold the `SOCKETS` borrow across a re-entrant JS call).
pub fn on_ready(ctx: JSContextRef, event: &mio::event::Event) {
    let token = event.token();
    if !event.is_readable() {
        return;
    }
    let mut datagrams: Vec<(Vec<u8>, SocketAddr)> = Vec::new();
    SOCKETS.with(|s| {
        let map = s.borrow();
        let Some(sock) = map.get(&token) else { return };
        let mut buf = [0u8; 65_536];
        loop {
            match sock.recv_from(&mut buf) {
                Ok((n, from)) => datagrams.push((buf[..n].to_vec(), from)),
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => break,
            }
        }
    });
    for (data, from) in datagrams {
        unsafe { dispatch_message(ctx, token.0, &data, from) };
    }
}

/// Call `globalThis.__velox_on_udp(id, dataLatin1, addr, port)`.
unsafe fn dispatch_message(ctx: JSContextRef, id: usize, data: &[u8], from: SocketAddr) {
    use objc2_javascript_core::{
        JSContext, JSObjectCallAsFunction, JSObjectGetProperty, JSStringCreateWithUTF8CString,
        JSStringRelease,
    };
    unsafe {
        let global = JSContext::global_object(ctx);
        let name = JSStringCreateWithUTF8CString(c"__velox_on_udp".as_ptr());
        let func = JSObjectGetProperty(ctx, global, name, ptr::null_mut());
        JSStringRelease(name);
        let func_obj = JSValue::to_object(ctx, func, ptr::null_mut());
        if func_obj.is_null() {
            return;
        }
        let args = [
            JSValue::new_number(ctx, id as f64),
            js_string_latin1(ctx, data),
            js_string(ctx, &from.ip().to_string()),
            JSValue::new_number(ctx, from.port() as f64),
        ];
        let mut exception: JSValueRef = ptr::null();
        JSObjectCallAsFunction(
            ctx,
            func_obj,
            ptr::null_mut(),
            args.len(),
            args.as_ptr() as *mut JSValueRef,
            &mut exception,
        );
    }
}

/// Build + throw a JS Error into the native callback's exception out-param.
unsafe fn throw(ctx: JSContextRef, exception: *mut JSValueRef, message: &str) -> JSValueRef {
    unsafe {
        if !exception.is_null() {
            let err = crate::node::call_named(
                ctx,
                c"__velox_fs_error",
                &[js_string(ctx, "EUDP"), js_string(ctx, message)],
            );
            *exception = err;
        }
        JSValue::new_undefined(ctx)
    }
}

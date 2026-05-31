// node:net — a TCP shim for velox on bare JavaScriptCore (server + client).
//
// All socket payloads cross the native bridge as "latin1" strings (one char
// per byte, 0..255). The Rust host provides:
//   __velox_listen(port, host) -> serverId        (throws on bind error)
//   __velox_connect(host, port) -> socketId        (async connect; buffers writes)
//   __velox_socket_write(socketId, latin1)        (queue bytes)
//   __velox_socket_end(socketId)                  (flush, then close)
//   __velox_socket_close(socketId)                (close immediately)
//   __velox_close_server(serverId)                (stop listening)
// and CALLS the globals we install below to deliver incoming I/O to JS.

var EventEmitter = require('node:events');

// ---------------------------------------------------------------------------
// Registries (module-level): native ids -> JS objects.
// ---------------------------------------------------------------------------
var sockets = new Map(); // socketId -> Socket
var servers = new Map(); // serverId -> Server

// Defer a function to the next microtask (Promise-based; no timers needed).
function nextTick(fn) {
  Promise.resolve().then(fn);
}

// ---------------------------------------------------------------------------
// Socket
// ---------------------------------------------------------------------------
function Socket(options) {
  EventEmitter.call(this);
  options = options || {};
  this._socketId = options.socketId != null ? options.socketId : null;
  this._server = options.server || null;

  this.remoteAddress = '';
  this.remotePort = 0;
  this.localAddress = '';
  this.localPort = 0;

  this.writable = true;
  this.readable = true;
  this.destroyed = false;
  this.connecting = false;
  this.pending = false;

  this._encoding = null; // when set, 'data' is emitted as decoded strings
  this._corked = 0; // cork() depth — buffers writes until uncork()
  this._corkBuf = [];
  this.bytesRead = 0;
  this.bytesWritten = 0;

  // Node sockets carry a libuv `_handle` whose `_parentWrap` points back at the
  // socket. velox has no libuv handle, but some libraries (got/http2-wrapper)
  // read `socket._handle._parentWrap` to recover the JS socket — provide a
  // minimal stand-in with no-op control methods.
  var self = this;
  this._handle = {
    _parentWrap: self,
    setNoDelay: function () {}, setKeepAlive: function () {},
    readStart: function () {}, readStop: function () {},
    ref: function () {}, unref: function () {},
  };
}
inherits(Socket, EventEmitter);

// Lightweight prototype-chain helper (avoids depending on util.inherits).
function inherits(ctor, superCtor) {
  ctor.super_ = superCtor;
  ctor.prototype = Object.create(superCtor.prototype, {
    constructor: { value: ctor, enumerable: false, writable: true, configurable: true },
  });
}

// Coerce any write payload to a latin1 string suitable for the native bridge.
function toLatin1(data, encoding) {
  if (data == null) return '';
  if (typeof data === 'string') {
    return Buffer.from(data, encoding || 'utf8').toString('latin1');
  }
  if (Buffer.isBuffer(data)) return data.toString('latin1');
  // ArrayBuffer / TypedArray / array-like
  return Buffer.from(data).toString('latin1');
}

Socket.prototype.write = function (data, encoding, cb) {
  if (typeof encoding === 'function') { cb = encoding; encoding = null; }
  if (this.destroyed || this._socketId == null) {
    if (typeof cb === 'function') nextTick(cb);
    return false;
  }
  var latin1 = toLatin1(data, encoding);
  this.bytesWritten += latin1.length;
  if (this._corked > 0) {
    this._corkBuf.push(latin1);
  } else {
    __velox_socket_write(this._socketId, latin1);
  }
  if (typeof cb === 'function') nextTick(cb);
  return true;
};

Socket.prototype.end = function (data, encoding, cb) {
  if (typeof data === 'function') { cb = data; data = null; encoding = null; }
  else if (typeof encoding === 'function') { cb = encoding; encoding = null; }

  if (data != null) this.write(data, encoding);
  this._flushCork();

  this.writable = false;
  if (typeof cb === 'function') this.once('close', cb);

  if (!this.destroyed && this._socketId != null) {
    // Flush queued writes then close — the host fires on_close afterwards,
    // which is where we emit 'close'. We do not emit anything here.
    __velox_socket_end(this._socketId);
  }
  return this;
};

Socket.prototype.destroy = function (err) {
  if (this.destroyed) return this;
  this.writable = false;
  this.readable = false;
  if (this._socketId != null) __velox_socket_close(this._socketId);
  if (err) nextTick(() => this.emit('error', err));
  return this;
};
Socket.prototype.destroySoon = Socket.prototype.end;

Socket.prototype.setEncoding = function (encoding) {
  this._encoding = encoding || null;
  return this;
};

// cork()/uncork() — batch writes until the cork is released.
Socket.prototype.cork = function () { this._corked++; };
Socket.prototype.uncork = function () {
  if (this._corked > 0) this._corked--;
  if (this._corked === 0) this._flushCork();
};
Socket.prototype._flushCork = function () {
  if (this._corkBuf.length && this._socketId != null && !this.destroyed) {
    __velox_socket_write(this._socketId, this._corkBuf.join(''));
  }
  this._corkBuf = [];
};

// No-ops that exist for API compatibility (return `this` like Node).
Socket.prototype.setTimeout = function (ms, cb) {
  if (typeof cb === 'function') this.once('timeout', cb);
  return this;
};
Socket.prototype.setNoDelay = function () { return this; };
Socket.prototype.setKeepAlive = function () { return this; };
Socket.prototype.ref = function () { return this; };
Socket.prototype.unref = function () { return this; };
Socket.prototype.pause = function () { return this; };
Socket.prototype.resume = function () { return this; };

Socket.prototype.address = function () {
  return { port: this.localPort, address: this.localAddress, family: 'IPv4' };
};

// Minimal pipe(): forward our 'data'/'end' into a writable destination.
Socket.prototype.pipe = function (dest, opts) {
  var self = this;
  this.on('data', function (chunk) { dest.write(chunk); });
  if (!opts || opts.end !== false) {
    this.on('end', function () { if (dest.end) dest.end(); });
  }
  this.on('error', function (e) { if (dest.destroy) dest.destroy(e); });
  return dest;
};

// connect(port[, host][, connectListener]) — outbound client connection.
// Also accepts connect(options, cb) where options = { port, host } and
// connect(path) (unix domain sockets) which we reject.
Socket.prototype.connect = function (port, host, connectListener) {
  // connect(options[, cb])
  if (port !== null && typeof port === 'object') {
    var opts = port;
    connectListener = typeof host === 'function' ? host : connectListener;
    if (opts.path != null) throw new Error('unix domain sockets are not supported');
    host = opts.host;
    port = opts.port;
    if (opts.tls) this._useTls = true;
  } else if (typeof port === 'string' && !/^\d+$/.test(port)) {
    // connect(path) — a non-numeric string is a unix socket path.
    throw new Error('unix domain sockets are not supported');
  } else if (typeof host === 'function') {
    // connect(port, cb)
    connectListener = host;
    host = undefined;
  }

  host = host || 'localhost';
  port = Number(port);

  if (typeof connectListener === 'function') this.once('connect', connectListener);

  this.connecting = true;
  this.pending = true;
  this.remoteAddress = host;
  this.remotePort = port;

  // The host returns a socketId synchronously and connects asynchronously,
  // buffering any writes we issue before the connection is established.
  this._socketId = this._useTls
    ? __velox_connect_tls(host, port)
    : __velox_connect(host, port);
  sockets.set(this._socketId, this);
  return this;
};

// Deliver an inbound chunk to listeners, honoring setEncoding().
Socket.prototype._pushData = function (latin1) {
  this.bytesRead += latin1.length;
  var buf = Buffer.from(latin1, 'latin1');
  if (this._encoding) this.emit('data', buf.toString(this._encoding));
  else this.emit('data', buf);
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
function Server(options, connectionListener) {
  if (typeof options === 'function') {
    connectionListener = options;
    options = {};
  }
  EventEmitter.call(this);
  this._serverId = null;
  this._port = 0;
  this._host = '0.0.0.0';
  this.listening = false;
  this.maxConnections = null;
  if (typeof connectionListener === 'function') this.on('connection', connectionListener);
}
inherits(Server, EventEmitter);

// listen(port[, host][, backlog][, cb]) — flexible Node-style arg parsing.
Server.prototype.listen = function () {
  var args = Array.prototype.slice.call(arguments);
  var cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;

  var port = 0;
  var host = '0.0.0.0';
  if (args.length && typeof args[0] === 'object' && args[0] !== null) {
    // listen({ port, host }, cb)
    var opts = args[0];
    if (opts.port != null) port = opts.port;
    if (opts.host != null) host = opts.host;
  } else {
    if (args.length >= 1 && args[0] != null) port = args[0];
    // Next string arg (if any) is the host; numbers are backlog (ignored).
    for (var i = 1; i < args.length; i++) {
      if (typeof args[i] === 'string') { host = args[i]; break; }
    }
  }

  this._port = Number(port) || 0;
  this._host = host || '0.0.0.0';

  var self = this;
  // __velox_listen throws synchronously on bind error (e.g. EADDRINUSE).
  try {
    this._serverId = this._tlsOptions
      ? __velox_listen_tls(this._port, this._host, this._tlsOptions.cert || "", this._tlsOptions.key || "")
      : __velox_listen(this._port, this._host);
  } catch (e) {
    nextTick(function () {
      if (cb) self.removeListener('listening', cb);
      self.emit('error', e instanceof Error ? e : new Error(String(e)));
    });
    return this;
  }
  servers.set(this._serverId, this);
  this.listening = true;
  // Resolve the actual bound port (the OS assigns one when we asked for 0).
  try {
    var bound = __velox_server_port(this._serverId);
    if (bound) this._port = bound;
  } catch (e) {}

  if (cb) this.once('listening', cb);
  nextTick(function () { self.emit('listening'); });
  return this;
};

Server.prototype.address = function () {
  if (!this.listening) return null;
  return { port: this._port, address: this._host, family: 'IPv4' };
};

Server.prototype.close = function (cb) {
  var self = this;
  if (typeof cb === 'function') this.once('close', cb);
  if (this._serverId != null) {
    __velox_close_server(this._serverId);
    servers.delete(this._serverId);
  }
  this.listening = false;
  nextTick(function () { self.emit('close'); });
  return this;
};

Server.prototype.ref = function () { return this; };
Server.prototype.unref = function () { return this; };
Server.prototype.getConnections = function (cb) {
  if (typeof cb === 'function') nextTick(function () { cb(null, sockets.size); });
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
function createServer(options, connectionListener) {
  return new Server(options, connectionListener);
}

// ---------------------------------------------------------------------------
// Native -> JS dispatchers (installed on globalThis; the host calls these).
// ---------------------------------------------------------------------------
globalThis.__velox_on_connection = function (serverId, socketId) {
  var server = servers.get(serverId);
  var socket = new Socket({ socketId: socketId, server: server });
  sockets.set(socketId, socket);
  if (server) server.emit('connection', socket);
};

// Outbound socket finished connecting: mark live and emit 'connect'/'ready'.
globalThis.__velox_on_connect = function (socketId) {
  var socket = sockets.get(socketId);
  if (socket) {
    socket.connecting = false;
    socket.pending = false;
    socket.emit('connect');
    socket.emit('ready');
  }
};

globalThis.__velox_on_data = function (socketId, latin1) {
  var socket = sockets.get(socketId);
  if (socket) socket._pushData(latin1);
};

globalThis.__velox_on_end = function (socketId) {
  var socket = sockets.get(socketId);
  if (socket) {
    socket.readable = false;
    socket.emit('end');
  }
};

globalThis.__velox_on_close = function (socketId) {
  var socket = sockets.get(socketId);
  if (socket) {
    socket.destroyed = true;
    socket.writable = false;
    socket.readable = false;
    socket.emit('close', false);
    sockets.delete(socketId);
  }
};

globalThis.__velox_on_error = function (socketId, message) {
  var socket = sockets.get(socketId);
  if (socket) {
    var err = message instanceof Error ? message : new Error(String(message));
    socket.emit('error', err);
  }
};

// ---------------------------------------------------------------------------
// IP helpers
// ---------------------------------------------------------------------------
function isIPv4(s) {
  if (typeof s !== 'string') return false;
  var parts = s.split('.');
  if (parts.length !== 4) return false;
  for (var i = 0; i < 4; i++) {
    var p = parts[i];
    if (!/^\d{1,3}$/.test(p)) return false;
    var n = Number(p);
    if (n < 0 || n > 255) return false;
    if (p.length > 1 && p[0] === '0') return false; // no leading zeros
  }
  return true;
}
function isIPv6(s) {
  if (typeof s !== 'string') return false;
  // Permissive check: hex groups separated by ':', allowing one '::'.
  if (s.indexOf(':') === -1) return false;
  return /^[0-9a-fA-F:]+$/.test(s) && (s.match(/::/g) || []).length <= 1;
}
function isIP(s) {
  if (isIPv4(s)) return 4;
  if (isIPv6(s)) return 6;
  return 0;
}

// ---------------------------------------------------------------------------
// Client sockets — create a Socket and dial out.
//
// Arg forms (mirrors Node): connect(port[, host][, cb]),
// connect(options[, cb]) where options = { port, host }.
// ---------------------------------------------------------------------------
function connect(arg1, arg2, arg3) {
  var socket = new Socket();
  var options, cb;
  if (arg1 !== null && typeof arg1 === 'object') {
    options = arg1;
    cb = typeof arg2 === 'function' ? arg2 : undefined;
    socket.connect(options, cb);
  } else if (typeof arg2 === 'function') {
    // connect(port, cb)
    socket.connect(arg1, undefined, arg2);
  } else {
    // connect(port, host[, cb])
    socket.connect(arg1, arg2, arg3);
  }
  return socket;
}
var createConnection = connect;

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  Server: Server,
  Socket: Socket,
  Stream: Socket, // legacy alias
  createServer: createServer,
  connect: connect,
  createConnection: createConnection,
  isIP: isIP,
  isIPv4: isIPv4,
  isIPv6: isIPv6,
};
module.exports.default = module.exports;

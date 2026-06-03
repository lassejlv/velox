// node:http2 — a working HTTP/2 (h2c, cleartext) implementation over node:net.
//
// Built on the RFC 7540 frame codec + RFC 7541 HPACK in http2_hpack.js. Supports
// both the modern stream API (server 'stream' event + stream.respond/end; client
// session.request) and the compat API (server 'request' (req,res)). h2c only
// (createSecureServer/ALPN is not implemented). Flow control uses a generous
// receive window and respects the peer's send window for outgoing DATA.

var net = require('node:net');
var EventEmitter = require('node:events');
var stream = require('node:stream');
var H = require('http2_hpack');

var FT = H.FRAME_TYPES;
var FL = H.FLAGS;

function nextTick(fn) { Promise.resolve().then(fn); }

var DEFAULT_WINDOW = 65535;
var BIG_WINDOW = 16 * 1024 * 1024; // our receive window — bump so peers can send freely
var MAX_FRAME = 16384;

var constants = {
  HTTP2_HEADER_PATH: ':path',
  HTTP2_HEADER_METHOD: ':method',
  HTTP2_HEADER_STATUS: ':status',
  HTTP2_HEADER_AUTHORITY: ':authority',
  HTTP2_HEADER_SCHEME: ':scheme',
  HTTP2_HEADER_CONTENT_TYPE: 'content-type',
  HTTP2_HEADER_CONTENT_LENGTH: 'content-length',
  HTTP2_METHOD_GET: 'GET',
  HTTP2_METHOD_POST: 'POST',
  NGHTTP2_NO_ERROR: 0,
  NGHTTP2_CANCEL: 8,
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_NOT_FOUND: 404,
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
};

function inherits(ctor, superCtor) {
  ctor.super_ = superCtor;
  ctor.prototype = Object.create(superCtor.prototype, {
    constructor: { value: ctor, enumerable: false, writable: true, configurable: true },
  });
}

// ===========================================================================
// Http2Stream — a Duplex: readable = incoming DATA, writable = outgoing DATA.
// ===========================================================================
function Http2Stream(session, id, isServer) {
  stream.Duplex.call(this, {});
  this.session = session;
  this.id = id;
  this._isServer = isServer;
  this.sentHeaders = null;
  this.headersReceived = null;
  this._headersSent = false;
  this._endSent = false;
  this._sendWindow = session._peerInitialWindow != null ? session._peerInitialWindow : DEFAULT_WINDOW;
  this._outQueue = [];   // pending {data, endStream} when window is exhausted
  this.closed = false;
  this.rstCode = 0;
}
inherits(Http2Stream, stream.Duplex);

// Server: send response headers.
Http2Stream.prototype.respond = function (headers, options) {
  headers = headers || {};
  if (headers[':status'] === undefined) headers[':status'] = 200;
  var pairs = headersToPairs(headers, true);
  var endStream = !!(options && options.endStream);
  this.session._sendHeaders(this.id, pairs, endStream);
  this._headersSent = true;
  if (endStream) { this._endSent = true; this.closed = true; }
  return this;
};

Http2Stream.prototype._write = function (chunk, encoding, cb) {
  if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk, encoding || 'utf8');
  this._queueData(chunk, false);
  cb();
};
Http2Stream.prototype._final = function (cb) {
  this._queueData(Buffer.alloc(0), true);
  cb();
};
Http2Stream.prototype._read = function () { /* data is pushed by the session */ };

// Queue outgoing DATA, respecting the peer's flow-control window.
Http2Stream.prototype._queueData = function (data, endStream) {
  if (this._endSent) return;
  this._outQueue.push({ data: data, endStream: endStream });
  this._flushOut();
};
Http2Stream.prototype._flushOut = function () {
  while (this._outQueue.length) {
    var item = this._outQueue[0];
    var len = item.data.length;
    if (len === 0) {
      this._outQueue.shift();
      this.session._sendData(this.id, item.data, item.endStream);
      if (item.endStream) this._endSent = true;
      continue;
    }
    var allowed = Math.min(this._sendWindow, this.session._connSendWindow, MAX_FRAME);
    if (allowed <= 0) return; // blocked on flow control; resumes on WINDOW_UPDATE
    var take = Math.min(allowed, len);
    var slice = item.data.slice(0, take);
    var isLast = take === len && item.endStream;
    this.session._sendData(this.id, slice, isLast);
    this._sendWindow -= take;
    this.session._connSendWindow -= take;
    if (take === len) { this._outQueue.shift(); if (item.endStream) this._endSent = true; }
    else { item.data = item.data.slice(take); }
  }
};

Http2Stream.prototype.close = function (code, cb) {
  if (this.closed) { if (cb) nextTick(cb); return; }
  this.closed = true;
  this.session._sendRst(this.id, code || 0);
  if (cb) this.once('close', cb);
};

// ===========================================================================
// Http2Session — owns the socket, frame loop, HPACK, and stream map.
// ===========================================================================
function Http2Session(socket, isServer) {
  EventEmitter.call(this);
  this.socket = socket;
  this._isServer = isServer;
  this._buf = Buffer.alloc(0);
  this._decoder = new H.HpackDecoder(4096);
  this._encoder = new H.HpackEncoder(4096);
  this.streams = {};
  this._nextStreamId = isServer ? 2 : 1; // servers use even (push), clients odd
  this._peerInitialWindow = DEFAULT_WINDOW;
  this._connSendWindow = DEFAULT_WINDOW;
  this._prefaceSeen = false;
  this._headerAssembly = null; // {streamId, flags, chunks} during HEADERS+CONTINUATION
  this.closed = false;
  this.destroyed = false;
  var self = this;

  socket.on('data', function (d) { self._onData(Buffer.isBuffer(d) ? d : Buffer.from(d, 'latin1')); });
  socket.on('error', function (e) { self.emit('error', e); });
  socket.on('close', function () { self.destroyed = true; self.emit('close'); });

  // Send our connection preface + initial SETTINGS.
  if (!isServer) socket.write(H.CONNECTION_PREFACE);
  this._sendSettings({ 4: BIG_WINDOW, 3: 100 });
  // Bump the connection-level receive window.
  this._sendWindowUpdate(0, BIG_WINDOW - DEFAULT_WINDOW);
}
inherits(Http2Session, EventEmitter);

Http2Session.prototype._onData = function (chunk) {
  this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
  // Server: consume the client connection preface before frames.
  if (this._isServer && !this._prefaceSeen) {
    if (this._buf.length < H.CONNECTION_PREFACE.length) return;
    var pre = this._buf.slice(0, H.CONNECTION_PREFACE.length);
    if (!pre.equals(H.CONNECTION_PREFACE)) { this.destroy(new Error('bad HTTP/2 preface')); return; }
    this._prefaceSeen = true;
    this._buf = this._buf.slice(H.CONNECTION_PREFACE.length);
  }
  var parsed = H.parseFrames(this._buf);
  this._buf = parsed.rest;
  for (var i = 0; i < parsed.frames.length; i++) this._handleFrame(parsed.frames[i]);
};

Http2Session.prototype._handleFrame = function (frame) {
  switch (frame.type) {
    case FT.SETTINGS: return this._onSettings(frame);
    case FT.HEADERS: return this._onHeaders(frame);
    case FT.CONTINUATION: return this._onContinuation(frame);
    case FT.DATA: return this._onDataFrame(frame);
    case FT.WINDOW_UPDATE: return this._onWindowUpdate(frame);
    case FT.PING: return this._onPing(frame);
    case FT.RST_STREAM: return this._onRst(frame);
    case FT.GOAWAY: this.emit('goaway'); return;
    default: return;
  }
};

Http2Session.prototype._onSettings = function (frame) {
  if (frame.flags & FL.ACK) return;
  var s = H.parseSettings(frame.payload);
  if (s[4] != null) {
    var delta = s[4] - this._peerInitialWindow;
    this._peerInitialWindow = s[4];
    for (var id in this.streams) this.streams[id]._sendWindow += delta;
  }
  this._writeFrame(FT.SETTINGS, FL.ACK, 0, Buffer.alloc(0));
};

Http2Session.prototype._onHeaders = function (frame) {
  var block = H.parseHeadersPayload(frame.payload, frame.flags);
  if (frame.flags & FL.END_HEADERS) {
    this._deliverHeaders(frame.streamId, block, frame.flags);
  } else {
    this._headerAssembly = { streamId: frame.streamId, flags: frame.flags, chunks: [block] };
  }
};
Http2Session.prototype._onContinuation = function (frame) {
  var a = this._headerAssembly;
  if (!a || a.streamId !== frame.streamId) return;
  a.chunks.push(frame.payload);
  if (frame.flags & FL.END_HEADERS) {
    this._headerAssembly = null;
    this._deliverHeaders(a.streamId, Buffer.concat(a.chunks), a.flags);
  }
};

Http2Session.prototype._deliverHeaders = function (streamId, block, flags) {
  var pairs;
  try { pairs = this._decoder.decode(block); } catch (e) { this.destroy(e); return; }
  var headers = pairsToHeaders(pairs);
  var endStream = !!(flags & FL.END_STREAM);
  var st = this.streams[streamId];
  if (this._isServer && !st) {
    st = new Http2Stream(this, streamId, true);
    this.streams[streamId] = st;
    if (streamId >= this._nextStreamId) this._nextStreamId = streamId + 1;
    this.emit('stream', st, headers, flags);
    this._emitServerRequest(st, headers);
    if (endStream) st.push(null);
  } else if (st) {
    if (!st.headersReceived) {
      st.headersReceived = headers;
      st.emit('response', headers, flags);
    } else {
      st.emit('trailers', headers, flags);
    }
    if (endStream) st.push(null);
  }
};

Http2Session.prototype._onDataFrame = function (frame) {
  var data = H.stripPadding(frame.payload, frame.flags);
  var st = this.streams[frame.streamId];
  if (st && data.length) st.push(data);
  if (frame.payload.length > 0) {
    this._sendWindowUpdate(0, frame.payload.length);
    this._sendWindowUpdate(frame.streamId, frame.payload.length);
  }
  if (st && (frame.flags & FL.END_STREAM)) st.push(null);
};

Http2Session.prototype._onWindowUpdate = function (frame) {
  var inc = frame.payload.readUInt32BE(0) & 0x7fffffff;
  if (frame.streamId === 0) {
    this._connSendWindow += inc;
    for (var id in this.streams) this.streams[id]._flushOut();
  } else {
    var st = this.streams[frame.streamId];
    if (st) { st._sendWindow += inc; st._flushOut(); }
  }
};

Http2Session.prototype._onPing = function (frame) {
  if (frame.flags & FL.ACK) return;
  this._writeFrame(FT.PING, FL.ACK, 0, frame.payload);
};
Http2Session.prototype._onRst = function (frame) {
  var st = this.streams[frame.streamId];
  if (st) { st.rstCode = frame.payload.length >= 4 ? frame.payload.readUInt32BE(0) : 0; st.closed = true; st.push(null); st.emit('close'); delete this.streams[frame.streamId]; }
};

// --- frame senders ---------------------------------------------------------
Http2Session.prototype._writeFrame = function (type, flags, streamId, payload) {
  if (this.destroyed) return;
  this.socket.write(H.encodeFrame(type, flags, streamId, payload || Buffer.alloc(0)));
};
Http2Session.prototype._sendSettings = function (obj) {
  this._writeFrame(FT.SETTINGS, 0, 0, H.encodeSettings(obj || {}));
};
Http2Session.prototype._sendWindowUpdate = function (streamId, inc) {
  if (inc <= 0) return;
  var b = Buffer.alloc(4);
  b.writeUInt32BE(inc >>> 0, 0);
  this._writeFrame(FT.WINDOW_UPDATE, 0, streamId, b);
};
Http2Session.prototype._sendHeaders = function (streamId, pairs, endStream) {
  var block = this._encoder.encode(pairs);
  var flags = FL.END_HEADERS | (endStream ? FL.END_STREAM : 0);
  if (block.length <= MAX_FRAME) {
    this._writeFrame(FT.HEADERS, flags, streamId, block);
  } else {
    this._writeFrame(FT.HEADERS, endStream ? FL.END_STREAM : 0, streamId, block.slice(0, MAX_FRAME));
    var off = MAX_FRAME;
    while (off < block.length) {
      var end = Math.min(off + MAX_FRAME, block.length);
      this._writeFrame(FT.CONTINUATION, end >= block.length ? FL.END_HEADERS : 0, streamId, block.slice(off, end));
      off = end;
    }
  }
};
Http2Session.prototype._sendData = function (streamId, data, endStream) {
  this._writeFrame(FT.DATA, endStream ? FL.END_STREAM : 0, streamId, data);
};
Http2Session.prototype._sendRst = function (streamId, code) {
  var b = Buffer.alloc(4); b.writeUInt32BE(code >>> 0, 0);
  this._writeFrame(FT.RST_STREAM, 0, streamId, b);
};

// Client: open a new request stream.
Http2Session.prototype.request = function (headers, options) {
  if (this._isServer) throw new Error('server sessions cannot request');
  headers = headers || {};
  var id = this._nextStreamId; this._nextStreamId += 2;
  var st = new Http2Stream(this, id, false);
  this.streams[id] = st;
  var endStream = !!(options && options.endStream);
  var pairs = headersToPairs(headers, false);
  this._sendHeaders(id, pairs, endStream);
  st._headersSent = true;
  if (endStream) st._endSent = true;
  return st;
};

Http2Session.prototype.close = function (cb) {
  if (this.closed) { if (cb) nextTick(cb); return; }
  this.closed = true;
  var b = Buffer.alloc(8);
  b.writeUInt32BE(this._nextStreamId, 0);
  this._writeFrame(FT.GOAWAY, 0, 0, b);
  if (cb) this.once('close', cb);
  var self = this;
  nextTick(function () { try { self.socket.end(); } catch (e) {} });
};
Http2Session.prototype.destroy = function (err) {
  if (this.destroyed) return;
  this.destroyed = true;
  if (err) this.emit('error', err);
  try { this.socket.destroy(); } catch (e) {}
  this.emit('close');
};

Http2Session.prototype._emitServerRequest = function (st, headers) {
  if (!this._server || this._server.listenerCount('request') === 0) return;
  var req = new Http2ServerRequest(st, headers);
  var res = new Http2ServerResponse(st);
  this._server.emit('request', req, res);
};

// ===========================================================================
// Compat request/response objects (the (req, res) server API).
// ===========================================================================
function Http2ServerRequest(st, headers) {
  stream.Readable.call(this, {});
  this.stream = st;
  this.headers = headers;
  this.method = headers[':method'] || 'GET';
  this.url = headers[':path'] || '/';
  this.httpVersion = '2.0';
  this.httpVersionMajor = 2;
  var self = this;
  st.on('data', function (c) { self.push(c); });
  st.on('end', function () { self.push(null); });
  st.on('error', function (e) { self.emit('error', e); });
}
inherits(Http2ServerRequest, stream.Readable);
Http2ServerRequest.prototype._read = function () {};
Object.defineProperty(Http2ServerRequest.prototype, 'socket', { get: function () { return this.stream.session.socket; }, configurable: true });

function Http2ServerResponse(st) {
  EventEmitter.call(this);
  this.stream = st;
  this._headers = {};
  this.statusCode = 200;
  this.headersSent = false;
  this.finished = false;
}
inherits(Http2ServerResponse, EventEmitter);
Http2ServerResponse.prototype.setHeader = function (k, v) { this._headers[String(k).toLowerCase()] = v; return this; };
Http2ServerResponse.prototype.getHeader = function (k) { return this._headers[String(k).toLowerCase()]; };
Http2ServerResponse.prototype.removeHeader = function (k) { delete this._headers[String(k).toLowerCase()]; };
Http2ServerResponse.prototype.writeHead = function (status, statusMessageOrHeaders, headers) {
  this.statusCode = status;
  if (statusMessageOrHeaders && typeof statusMessageOrHeaders === 'object') headers = statusMessageOrHeaders;
  if (headers) for (var k in headers) this.setHeader(k, headers[k]);
  return this;
};
Http2ServerResponse.prototype._sendHead = function () {
  if (this.headersSent) return;
  this.headersSent = true;
  var h = { ':status': this.statusCode };
  for (var k in this._headers) h[k] = this._headers[k];
  this.stream.respond(h);
};
Http2ServerResponse.prototype.write = function (chunk, enc, cb) {
  this._sendHead();
  this.stream.write(chunk, enc, cb);
  return true;
};
Http2ServerResponse.prototype.end = function (chunk, enc, cb) {
  if (this.finished) return this;
  this._sendHead();
  this.finished = true;
  this.stream.end(chunk, enc, cb);
  this.emit('finish');
  return this;
};
Object.defineProperty(Http2ServerResponse.prototype, 'socket', { get: function () { return this.stream.session.socket; }, configurable: true });

// ===========================================================================
// Header object <-> HPACK pair-list conversion (pseudo-headers come first).
// ===========================================================================
var PSEUDO_ORDER_REQ = [':method', ':scheme', ':authority', ':path'];
var PSEUDO_ORDER_RES = [':status'];
function headersToPairs(headers, isResponse) {
  var pairs = [];
  var order = isResponse ? PSEUDO_ORDER_RES : PSEUDO_ORDER_REQ;
  for (var i = 0; i < order.length; i++) {
    if (headers[order[i]] !== undefined) pairs.push([order[i], String(headers[order[i]])]);
  }
  for (var k in headers) {
    if (k[0] === ':') continue;
    var v = headers[k];
    var lk = k.toLowerCase();
    if (Array.isArray(v)) { for (var j = 0; j < v.length; j++) pairs.push([lk, String(v[j])]); }
    else pairs.push([lk, String(v)]);
  }
  return pairs;
}
function pairsToHeaders(pairs) {
  var h = {};
  for (var i = 0; i < pairs.length; i++) {
    var name = pairs[i][0], val = pairs[i][1];
    if (name === ':status') val = Number(val); // Node exposes :status as a number
    if (h[name] === undefined) h[name] = val;
    else if (Array.isArray(h[name])) h[name].push(val);
    else h[name] = [h[name], val];
  }
  return h;
}

// ===========================================================================
// Server / client factories
// ===========================================================================
function Http2Server(options) {
  EventEmitter.call(this);
  var self = this;
  this._net = net.createServer(function (socket) {
    var session = new Http2Session(socket, true);
    session._server = self;
    self.emit('session', session);
    session.on('stream', function (st, headers, flags) { self.emit('stream', st, headers, flags); });
    session.on('error', function (e) { self.emit('clientError', e, socket); });
  });
  this._net.on('error', function (e) { self.emit('error', e); });
  this._net.on('listening', function () { self.emit('listening'); });
}
inherits(Http2Server, EventEmitter);
Http2Server.prototype.listen = function () { this._net.listen.apply(this._net, arguments); return this; };
Http2Server.prototype.close = function (cb) { this._net.close(cb); return this; };
Http2Server.prototype.address = function () { return this._net.address(); };

function createServer(options, onRequest) {
  if (typeof options === 'function') { onRequest = options; options = {}; }
  var server = new Http2Server(options || {});
  if (onRequest) server.on('request', onRequest);
  return server;
}
function createSecureServer() {
  throw new Error('http2.createSecureServer (h2 over TLS/ALPN) is not implemented in velox; use createServer for h2c');
}

// Client session over a fresh TCP connection — h2c (http:) or h2 over TLS with
// ALPN (https:). For TLS, the connection preface is buffered until the handshake
// completes (velox flushes pre-connect writes after on_connect), so it lands as
// the first application data after ALPN negotiates 'h2'.
function connect(authority, options, listener) {
  if (typeof options === 'function') { listener = options; options = {}; }
  options = options || {};
  var url = typeof authority === 'string' ? new URL(authority) : authority;
  var isHttps = url.protocol === 'https:';
  var scheme = isHttps ? 'https' : 'http';
  var port = url.port ? Number(url.port) : (isHttps ? 443 : 80);
  var host = url.hostname || 'localhost';
  var socket = isHttps
    ? net.connect({ host: host, port: port, tls: true, ALPNProtocols: ['h2'] })
    : net.connect(port, host);
  var session = new Http2Session(socket, false);
  session._authority = url.host || (host + (url.port ? ':' + url.port : ''));
  session.socket.on('connect', function () {
    if (isHttps && socket.alpnProtocol !== 'h2') {
      session.destroy(new Error('HTTP/2 ALPN negotiation failed (server offered ' + (socket.alpnProtocol || 'none') + ')'));
      return;
    }
    session.emit('connect', session, socket);
  });
  if (listener) session.once('connect', listener);
  var origRequest = session.request;
  session.request = function (headers, opts) {
    headers = Object.assign({}, headers);
    if (headers[':authority'] === undefined && headers.host === undefined) headers[':authority'] = session._authority;
    if (headers[':scheme'] === undefined) headers[':scheme'] = scheme;
    if (headers[':method'] === undefined) headers[':method'] = 'GET';
    if (headers[':path'] === undefined) headers[':path'] = '/';
    return origRequest.call(session, headers, opts);
  };
  return session;
}

module.exports = {
  constants: constants,
  createServer: createServer,
  createSecureServer: createSecureServer,
  connect: connect,
  getDefaultSettings: function () { return { headerTableSize: 4096, enablePush: false, initialWindowSize: BIG_WINDOW, maxFrameSize: MAX_FRAME }; },
  getPackedSettings: function (s) { return H.encodeSettings(s || {}); },
  getUnpackedSettings: function (buf) { return H.parseSettings(buf); },
  sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
  Http2Server: Http2Server,
  Http2Session: Http2Session,
  Http2Stream: Http2Stream,
  Http2ServerRequest: Http2ServerRequest,
  Http2ServerResponse: Http2ServerResponse,
};
module.exports.default = module.exports;

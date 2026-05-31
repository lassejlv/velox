// node:ws / WebSocket — RFC 6455 over velox's net sockets. Implements the
// handshake (Sec-WebSocket-Accept), frame encode/decode (incl. fragmentation,
// ping/pong/close, masking), a server (`WebSocketServer`, attaches to an http
// server's 'upgrade' event or opens its own) and a browser-style client
// (`new WebSocket(url)`). Frames are built/parsed as Buffers; socket payloads
// cross as latin1 strings.

var EventEmitter = require('node:events').EventEmitter;
var crypto = require('node:crypto');

var GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
var OPCODES = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

function acceptKey(key) {
  return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

// Encode a frame. Server frames are unmasked; client frames must be masked.
function encodeFrame(opcode, payload, mask) {
  payload = Buffer.isBuffer(payload) ? payload : Buffer.from(payload == null ? '' : String(payload), 'utf8');
  var len = payload.length;
  var maskBit = mask ? 0x80 : 0;
  var header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, maskBit | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode; header[1] = maskBit | 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode; header[1] = maskBit | 127;
    header.writeUInt32BE(Math.floor(len / 4294967296), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  if (mask) {
    var mk = crypto.randomBytes(4);
    var out = Buffer.alloc(len);
    for (var i = 0; i < len; i++) out[i] = payload[i] ^ mk[i % 4];
    return Buffer.concat([header, mk, out]);
  }
  return Buffer.concat([header, payload]);
}

// A frame reader that accumulates bytes and emits complete frames.
function FrameReader(onFrame) {
  this._buf = Buffer.alloc(0);
  this._onFrame = onFrame;
}
FrameReader.prototype.push = function (chunk) {
  this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
  var buf = this._buf;
  var offset = 0;
  while (offset + 2 <= buf.length) {
    var b0 = buf[offset], b1 = buf[offset + 1];
    var fin = (b0 & 0x80) !== 0;
    var opcode = b0 & 0x0f;
    var masked = (b1 & 0x80) !== 0;
    var len = b1 & 0x7f;
    var pos = offset + 2;
    if (len === 126) { if (pos + 2 > buf.length) break; len = buf.readUInt16BE(pos); pos += 2; }
    else if (len === 127) { if (pos + 8 > buf.length) break; len = buf.readUInt32BE(pos) * 4294967296 + buf.readUInt32BE(pos + 4); pos += 8; }
    var maskKey = null;
    if (masked) { if (pos + 4 > buf.length) break; maskKey = buf.subarray(pos, pos + 4); pos += 4; }
    if (pos + len > buf.length) break; // frame incomplete; wait for more
    var payload = buf.subarray(pos, pos + len);
    if (masked) {
      var unmasked = Buffer.alloc(len);
      for (var i = 0; i < len; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    } else {
      payload = Buffer.from(payload);
    }
    this._onFrame(fin, opcode, payload);
    offset = pos + len;
  }
  this._buf = offset ? buf.subarray(offset) : buf;
};

// --- WebSocket (shared by server + client) ---------------------------------

var CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;

function WebSocket(socket, isServer) {
  EventEmitter.call(this);
  this._socket = socket;
  this._isServer = isServer;
  this.readyState = isServer ? OPEN : CONNECTING;
  this._fragments = [];
  this._fragOpcode = 0;
  var self = this;
  this._reader = new FrameReader(function (fin, opcode, payload) { self._onFrame(fin, opcode, payload); });
  if (socket) this._bindSocket();
}
WebSocket.prototype = Object.create(EventEmitter.prototype);
WebSocket.prototype.constructor = WebSocket;
WebSocket.CONNECTING = CONNECTING; WebSocket.OPEN = OPEN; WebSocket.CLOSING = CLOSING; WebSocket.CLOSED = CLOSED;
WebSocket.prototype.CONNECTING = CONNECTING; WebSocket.prototype.OPEN = OPEN;
WebSocket.prototype.CLOSING = CLOSING; WebSocket.prototype.CLOSED = CLOSED;

WebSocket.prototype._bindSocket = function () {
  var self = this, socket = this._socket;
  socket.on('data', function (buf) {
    self._reader.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'latin1'));
  });
  socket.on('close', function () { self._finishClose(1006, ''); });
  socket.on('error', function (e) { self.emit('error', e); });
};

WebSocket.prototype._onFrame = function (fin, opcode, payload) {
  switch (opcode) {
    case OPCODES.text:
    case OPCODES.binary:
    case OPCODES.continuation:
      if (opcode !== OPCODES.continuation) this._fragOpcode = opcode;
      this._fragments.push(payload);
      if (fin) {
        var full = Buffer.concat(this._fragments);
        var op = this._fragOpcode;
        this._fragments = [];
        var data = op === OPCODES.text ? full.toString('utf8') : full;
        this.emit('message', data, op === OPCODES.binary);
      }
      break;
    case OPCODES.ping:
      this._sendFrame(OPCODES.pong, payload);
      this.emit('ping', payload);
      break;
    case OPCODES.pong:
      this.emit('pong', payload);
      break;
    case OPCODES.close:
      var code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
      var reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      if (this.readyState === OPEN) { this.readyState = CLOSING; this._sendFrame(OPCODES.close, payload); }
      this._finishClose(code, reason);
      break;
  }
};

WebSocket.prototype._sendFrame = function (opcode, payload) {
  if (!this._socket || this.readyState === CLOSED) return;
  var frame = encodeFrame(opcode, payload, !this._isServer); // clients mask
  this._socket.write(frame.toString('latin1'), 'latin1');
};

WebSocket.prototype.send = function (data, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = undefined; }
  var binary = Buffer.isBuffer(data) || data instanceof Uint8Array || data instanceof ArrayBuffer;
  var payload = binary ? (Buffer.isBuffer(data) ? data : Buffer.from(data)) : Buffer.from(String(data), 'utf8');
  this._sendFrame(binary ? OPCODES.binary : OPCODES.text, payload);
  if (typeof cb === 'function') Promise.resolve().then(cb);
};
WebSocket.prototype.ping = function (data) { this._sendFrame(OPCODES.ping, data || Buffer.alloc(0)); };
WebSocket.prototype.pong = function (data) { this._sendFrame(OPCODES.pong, data || Buffer.alloc(0)); };
WebSocket.prototype.close = function (code, reason) {
  if (this.readyState === CLOSED || this.readyState === CLOSING) return;
  this.readyState = CLOSING;
  var payload;
  if (code) {
    var r = Buffer.from(reason || '', 'utf8');
    payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0); r.copy(payload, 2);
  } else payload = Buffer.alloc(0);
  this._sendFrame(OPCODES.close, payload);
};
WebSocket.prototype.terminate = function () { if (this._socket) this._socket.destroy(); this._finishClose(1006, ''); };
WebSocket.prototype._finishClose = function (code, reason) {
  if (this.readyState === CLOSED) return;
  this.readyState = CLOSED;
  try { if (this._socket) this._socket.end(); } catch (e) {}
  this.emit('close', code, reason);
};
// Browser-style on* setters.
['open', 'message', 'close', 'error'].forEach(function (ev) {
  Object.defineProperty(WebSocket.prototype, 'on' + ev, {
    configurable: true,
    set: function (fn) { this['_on' + ev] && this.removeListener(ev, this['_on' + ev]); this['_on' + ev] = fn; if (fn) this.on(ev, ev === 'message' ? function (d) { fn({ data: d }); } : fn); },
    get: function () { return this['_on' + ev]; },
  });
});

// --- WebSocketServer -------------------------------------------------------

function WebSocketServer(options, callback) {
  EventEmitter.call(this);
  options = options || {};
  this.options = options;
  this.clients = new Set();
  var self = this;
  if (callback) this.on('listening', callback);

  function handleUpgrade(req, socket, head) {
    var key = req.headers['sec-websocket-key'];
    if (!key) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    var headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + acceptKey(key),
    ];
    var proto = req.headers['sec-websocket-protocol'];
    if (proto && options.handleProtocols) {
      var chosen = options.handleProtocols(proto.split(',').map(function (s) { return s.trim(); }), req);
      if (chosen) headers.push('Sec-WebSocket-Protocol: ' + chosen);
    }
    socket.write(headers.join('\r\n') + '\r\n\r\n', 'latin1');
    var ws = new WebSocket(socket, true);
    if (head && head.length) ws._reader.push(head);
    self.clients.add(ws);
    ws.on('close', function () { self.clients.delete(ws); });
    self.emit('connection', ws, req);
  }
  this.handleUpgrade = function (req, socket, head, cb) {
    var key = req.headers['sec-websocket-key'];
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Accept: ' + acceptKey(key)].join('\r\n') + '\r\n\r\n', 'latin1');
    var ws = new WebSocket(socket, true);
    if (head && head.length) ws._reader.push(head);
    self.clients.add(ws);
    ws.on('close', function () { self.clients.delete(ws); });
    if (cb) cb(ws, req);
  };

  if (options.server) {
    this._server = options.server;
    options.server.on('upgrade', handleUpgrade);
    nextTick(function () { self.emit('listening'); });
  } else if (options.port != null || options.noServer !== true) {
    var http = require('node:http');
    this._server = http.createServer(function (req, res) { res.writeHead(426); res.end('Upgrade Required'); });
    this._server.on('upgrade', handleUpgrade);
    if (options.port != null) this._server.listen(options.port, options.host, function () { self.emit('listening'); });
  }
}
WebSocketServer.prototype = Object.create(EventEmitter.prototype);
WebSocketServer.prototype.constructor = WebSocketServer;
WebSocketServer.prototype.address = function () { return this._server ? this._server.address() : null; };
WebSocketServer.prototype.close = function (cb) {
  this.clients.forEach(function (ws) { ws.terminate(); });
  this.clients.clear();
  if (this._server && !this.options.server) this._server.close(cb);
  else if (cb) nextTick(cb);
};

function nextTick(fn) { (typeof process !== 'undefined' && process.nextTick) ? process.nextTick(fn) : Promise.resolve().then(fn); }

// --- client: new WebSocket(url) --------------------------------------------

function connectClient(ws, url, protocols) {
  var net = require('node:net');
  var u = new URL(url);
  var secure = u.protocol === 'wss:';
  var port = u.port ? Number(u.port) : (secure ? 443 : 80);
  var path = (u.pathname || '/') + (u.search || '');
  var key = crypto.randomBytes(16).toString('base64');
  var opts = { port: port, host: u.hostname };
  if (secure) { opts.tls = true; opts.servername = u.hostname; }
  var socket = net.connect(opts);
  ws._socket = socket;
  var handshakeBuf = '';
  var upgraded = false;

  socket.on('connect', function () {
    var lines = [
      'GET ' + path + ' HTTP/1.1',
      'Host: ' + u.hostname + (u.port ? ':' + u.port : ''),
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key,
      'Sec-WebSocket-Version: 13',
    ];
    if (protocols) lines.push('Sec-WebSocket-Protocol: ' + (Array.isArray(protocols) ? protocols.join(', ') : protocols));
    socket.write(lines.join('\r\n') + '\r\n\r\n', 'latin1');
  });

  function onHandshakeData(buf) {
    handshakeBuf += Buffer.isBuffer(buf) ? buf.toString('latin1') : buf;
    var idx = handshakeBuf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    var headerPart = handshakeBuf.slice(0, idx);
    if (!/101/.test(headerPart.split('\r\n')[0])) {
      ws.emit('error', new Error('WebSocket handshake failed: ' + headerPart.split('\r\n')[0]));
      socket.destroy();
      return;
    }
    upgraded = true;
    ws.readyState = OPEN;
    socket.removeListener('data', onHandshakeData);
    ws._bindSocket();
    // Feed any frame bytes that arrived after the handshake response.
    var rest = handshakeBuf.slice(idx + 4);
    if (rest.length) ws._reader.push(Buffer.from(rest, 'latin1'));
    ws.emit('open');
  }
  socket.on('data', onHandshakeData);
  socket.on('error', function (e) { if (!upgraded) ws.emit('error', e); });
  socket.on('close', function () { if (!upgraded) ws._finishClose(1006, ''); });
}

function WebSocketClient(url, protocols) {
  WebSocket.call(this, null, false);
  this.url = url;
  var self = this;
  // Defer connect so on('open'/'message') handlers can attach first.
  nextTick(function () { connectClient(self, url, protocols); });
}
WebSocketClient.prototype = Object.create(WebSocket.prototype);
WebSocketClient.prototype.constructor = WebSocketClient;

// The `ws` package default export is the client class with Server attached.
function WS(address, protocols, options) {
  if (!(this instanceof WS)) return new WS(address, protocols, options);
  return new WebSocketClient(address, protocols);
}

module.exports = WebSocketClient;
module.exports.WebSocket = WebSocketClient;
module.exports.WebSocketServer = WebSocketServer;
module.exports.Server = WebSocketServer;
module.exports.Receiver = FrameReader;
module.exports.CONNECTING = CONNECTING;
module.exports.OPEN = OPEN;
module.exports.CLOSING = CLOSING;
module.exports.CLOSED = CLOSED;
module.exports.default = module.exports;

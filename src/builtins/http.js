// node:http — an HTTP/1.1 shim built on top of node:net (server + client).
//
// The server supports keep-alive: on an HTTP/1.1 connection where neither side
// requested `Connection: close`, the socket is kept open and the parser/message
// state is reset so the next request on the same socket fires 'request' again.
// The client (http.request / http.get) opens a net socket and parses the
// response into a client IncomingMessage.

var net = require('node:net');
var EventEmitter = require('node:events');
var Readable = require('node:stream').Readable;

function nextTick(fn) { Promise.resolve().then(fn); }

// Prototype-chain helper (kept local to avoid a util dependency).
function inherits(ctor, superCtor) {
  ctor.super_ = superCtor;
  ctor.prototype = Object.create(superCtor.prototype, {
    constructor: { value: ctor, enumerable: false, writable: true, configurable: true },
  });
}

// ---------------------------------------------------------------------------
// Standard status codes / methods
// ---------------------------------------------------------------------------
var STATUS_CODES = {
  100: 'Continue', 101: 'Switching Protocols', 102: 'Processing', 103: 'Early Hints',
  200: 'OK', 201: 'Created', 202: 'Accepted', 203: 'Non-Authoritative Information',
  204: 'No Content', 205: 'Reset Content', 206: 'Partial Content', 207: 'Multi-Status',
  208: 'Already Reported', 226: 'IM Used',
  300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other',
  304: 'Not Modified', 305: 'Use Proxy', 307: 'Temporary Redirect', 308: 'Permanent Redirect',
  400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden',
  404: 'Not Found', 405: 'Method Not Allowed', 406: 'Not Acceptable',
  407: 'Proxy Authentication Required', 408: 'Request Timeout', 409: 'Conflict',
  410: 'Gone', 411: 'Length Required', 412: 'Precondition Failed',
  413: 'Payload Too Large', 414: 'URI Too Long', 415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable', 417: 'Expectation Failed', 418: "I'm a Teapot",
  421: 'Misdirected Request', 422: 'Unprocessable Entity', 423: 'Locked',
  424: 'Failed Dependency', 425: 'Too Early', 426: 'Upgrade Required',
  428: 'Precondition Required', 429: 'Too Many Requests',
  431: 'Request Header Fields Too Large', 451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
  503: 'Service Unavailable', 504: 'Gateway Timeout', 505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates', 507: 'Insufficient Storage', 508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded', 510: 'Not Extended', 511: 'Network Authentication Required',
};

var METHODS = [
  'ACL', 'BIND', 'CHECKOUT', 'CONNECT', 'COPY', 'DELETE', 'GET', 'HEAD', 'LINK',
  'LOCK', 'M-SEARCH', 'MERGE', 'MKACTIVITY', 'MKCALENDAR', 'MKCOL', 'MOVE',
  'NOTIFY', 'OPTIONS', 'PATCH', 'POST', 'PROPFIND', 'PROPPATCH', 'PURGE', 'PUT',
  'REBIND', 'REPORT', 'SEARCH', 'SOURCE', 'SUBSCRIBE', 'TRACE', 'UNBIND',
  'UNLINK', 'UNLOCK', 'UNSUBSCRIBE',
];

// ---------------------------------------------------------------------------
// IncomingMessage — the parsed request (a readable-ish EventEmitter).
// ---------------------------------------------------------------------------
// IncomingMessage is a real Readable stream (push-based): the parser feeds body
// bytes via `_emitData` (-> push) and EOF via `_endData` (-> push(null)), so it
// works with `.pipe()`, `stream.pipeline()`, async iteration, and `setEncoding`
// — what node-fetch and other consumers expect — on top of the `'data'`/`'end'`
// events the legacy code already used.
function IncomingMessage(socket) {
  Readable.call(this, { read: function () {} });
  this.socket = socket;
  this.connection = socket;
  this.httpVersion = '1.1';
  this.httpVersionMajor = 1;
  this.httpVersionMinor = 1;
  this.method = null;
  this.url = null;
  this.statusCode = null;     // set on client (response) messages
  this.statusMessage = null;  // set on client (response) messages
  this.headers = {};
  this.rawHeaders = [];
  this.trailers = {};
  this.rawTrailers = [];
  this.complete = false;
  this.aborted = false;
}
inherits(IncomingMessage, Readable);

IncomingMessage.prototype.destroy = function (err) {
  if (this.socket) this.socket.destroy();
  return Readable.prototype.destroy.call(this, err);
};

// Push a parsed body chunk into the Readable buffer.
IncomingMessage.prototype._emitData = function (buf) {
  this.push(buf);
};
// Signal end-of-body (EOF) to the Readable.
IncomingMessage.prototype._endData = function () {
  this.push(null);
};

// Fold parsed header pairs into Node's lowercased `headers` object. Duplicate
// names are joined with ', ' (set-cookie is kept as an array per Node).
function addHeaderLine(req, name, value) {
  req.rawHeaders.push(name, value);
  var key = name.toLowerCase();
  var headers = req.headers;
  if (key === 'set-cookie') {
    if (headers[key]) headers[key].push(value);
    else headers[key] = [value];
  } else if (headers[key] !== undefined) {
    // Some headers (host, content-length, ...) keep the first value in Node,
    // but the common case is comma-joining; comma-join is spec-correct here.
    headers[key] += ', ' + value;
  } else {
    headers[key] = value;
  }
}

// ---------------------------------------------------------------------------
// HTTP request parser — streaming, robust to arbitrary chunk boundaries.
//
// State machine: HEADERS -> (BODY_LENGTH | BODY_CHUNKED | done). Bytes are
// accumulated in a latin1 string so we can index/slice cheaply; body bytes are
// re-wrapped as Buffers before being emitted.
// ---------------------------------------------------------------------------
function RequestParser(req, isResponse) {
  this.req = req;
  this.isResponse = !!isResponse; // first line is a status line, not a req line
  this.buffer = '';          // latin1 accumulator
  this.state = 'HEADERS';
  this.bodyRemaining = 0;    // for Content-Length
  this.chunkState = 'SIZE';  // for chunked: SIZE | DATA | DATA_CRLF | TRAILERS
  this.chunkRemaining = 0;
  this.readUntilClose = false; // response with no framing — body ends at EOF
  this.done = false;
  this.onHeaders = null;     // set by Server: fired once when headers parsed
}

RequestParser.prototype.push = function (latin1Chunk) {
  if (this.done) return;
  this.buffer += latin1Chunk;
  this._run();
};

// Reset the parser to read another message on the same socket (keep-alive).
// Re-targets a fresh message object and preserves any pipelined bytes.
RequestParser.prototype.reset = function (req) {
  this.req = req;
  this.state = 'HEADERS';
  this.bodyRemaining = 0;
  this.chunkState = 'SIZE';
  this.chunkRemaining = 0;
  this.readUntilClose = false;
  this.done = false;
  // Keep this.buffer — it may already hold the start of the next request.
};

// Peer EOF: finish a read-until-close body (client responses with no framing).
RequestParser.prototype.eof = function () {
  if (this.done) return;
  if (this.readUntilClose) this._finish();
};

RequestParser.prototype._run = function () {
  if (this.state === 'HEADERS') {
    var idx = this.buffer.indexOf('\r\n\r\n');
    if (idx === -1) return; // headers not complete yet — wait for more
    var headerBlock = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 4); // rest is (start of) the body
    this._parseHead(headerBlock);
    // Fire 'request' (onHeaders) BEFORE any body 'data'/'end' so the listener
    // is attached in time. This matters most for body-less requests, whose
    // 'end' would otherwise fire before the handler subscribes.
    if (this.onHeaders) this.onHeaders();
    if (this.state === 'DONE') { this._finish(); return; }
  }

  if (this.state === 'BODY_LENGTH') this._runLength();
  else if (this.state === 'BODY_CHUNKED') this._runChunked();
};

RequestParser.prototype._parseHead = function (block) {
  var req = this.req;
  var lines = block.split('\r\n');
  var firstLine = lines.shift();

  if (this.isResponse) {
    // "HTTP/x.y SP <status> SP <message>"
    var rFirstSp = firstLine.indexOf(' ');
    var rSecondSp = firstLine.indexOf(' ', rFirstSp + 1);
    var versionTok = firstLine.slice(0, rFirstSp); // e.g. "HTTP/1.1"
    var rSlash = versionTok.indexOf('/');
    if (rSlash !== -1) {
      req.httpVersion = versionTok.slice(rSlash + 1);
      var rDot = req.httpVersion.indexOf('.');
      var rMajor = parseInt(req.httpVersion.slice(0, rDot), 10);
      var rMinor = parseInt(req.httpVersion.slice(rDot + 1), 10);
      req.httpVersionMajor = isNaN(rMajor) ? 1 : rMajor;
      req.httpVersionMinor = isNaN(rMinor) ? 1 : rMinor;
    }
    if (rSecondSp === -1) {
      req.statusCode = parseInt(firstLine.slice(rFirstSp + 1).trim(), 10) || 0;
      req.statusMessage = '';
    } else {
      req.statusCode = parseInt(firstLine.slice(rFirstSp + 1, rSecondSp), 10) || 0;
      req.statusMessage = firstLine.slice(rSecondSp + 1);
    }
  } else {
    // "METHOD SP URL SP HTTP/x.y"
    var firstSp = firstLine.indexOf(' ');
    var lastSp = firstLine.lastIndexOf(' ');
    req.method = firstLine.slice(0, firstSp);
    req.url = firstLine.slice(firstSp + 1, lastSp);
    var httpVersion = firstLine.slice(lastSp + 1); // e.g. "HTTP/1.1"
    var slash = httpVersion.indexOf('/');
    if (slash !== -1) {
      req.httpVersion = httpVersion.slice(slash + 1);
      var dot = req.httpVersion.indexOf('.');
      var major = parseInt(req.httpVersion.slice(0, dot), 10);
      var minor = parseInt(req.httpVersion.slice(dot + 1), 10);
      req.httpVersionMajor = isNaN(major) ? 1 : major;
      req.httpVersionMinor = isNaN(minor) ? 1 : minor;
    }
  }

  // Header lines. Support obs-fold continuation lines (leading SP/HT).
  var pendingName = null, pendingValue = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === '') continue;
    if ((line[0] === ' ' || line[0] === '\t') && pendingName !== null) {
      pendingValue += ' ' + line.trim();
      continue;
    }
    if (pendingName !== null) { addHeaderLine(req, pendingName, pendingValue); }
    var colon = line.indexOf(':');
    if (colon === -1) { pendingName = null; continue; }
    pendingName = line.slice(0, colon).trim();
    pendingValue = line.slice(colon + 1).trim();
  }
  if (pendingName !== null) addHeaderLine(req, pendingName, pendingValue);

  // Decide how (if at all) to read the body.
  var te = req.headers['transfer-encoding'];
  var cl = req.headers['content-length'];
  if (te && te.toLowerCase().indexOf('chunked') !== -1) {
    this.state = 'BODY_CHUNKED';
    this.chunkState = 'SIZE';
  } else if (cl !== undefined) {
    var len = parseInt(cl, 10);
    if (len > 0) {
      this.state = 'BODY_LENGTH';
      this.bodyRemaining = len;
    } else {
      this.state = 'DONE'; // Content-Length: 0 — no body; finish after onHeaders
    }
  } else if (this.isResponse) {
    // Response with no Content-Length and no chunked framing: the body runs
    // until the server closes the connection.
    this.state = 'BODY_LENGTH';
    this.bodyRemaining = Infinity;
    this.readUntilClose = true;
  } else {
    // No body framing — request is complete at the header terminator.
    this.state = 'DONE';
  }
};

RequestParser.prototype._runLength = function () {
  if (this.buffer.length === 0) return;
  var take = Math.min(this.bodyRemaining, this.buffer.length);
  var slice = this.buffer.slice(0, take);
  this.buffer = this.buffer.slice(take);
  this.bodyRemaining -= take;
  this.req._emitData(Buffer.from(slice, 'latin1'));
  if (this.bodyRemaining === 0) this._finish();
};

RequestParser.prototype._runChunked = function () {
  while (true) {
    if (this.chunkState === 'SIZE') {
      var eol = this.buffer.indexOf('\r\n');
      if (eol === -1) return; // need the full size line
      var sizeLine = this.buffer.slice(0, eol);
      this.buffer = this.buffer.slice(eol + 2);
      // Strip any chunk extensions after ';'.
      var semi = sizeLine.indexOf(';');
      if (semi !== -1) sizeLine = sizeLine.slice(0, semi);
      this.chunkRemaining = parseInt(sizeLine.trim(), 16) || 0;
      if (this.chunkRemaining === 0) {
        this.chunkState = 'TRAILERS';
      } else {
        this.chunkState = 'DATA';
      }
    } else if (this.chunkState === 'DATA') {
      if (this.buffer.length === 0) return;
      var take = Math.min(this.chunkRemaining, this.buffer.length);
      var data = this.buffer.slice(0, take);
      this.buffer = this.buffer.slice(take);
      this.chunkRemaining -= take;
      this.req._emitData(Buffer.from(data, 'latin1'));
      if (this.chunkRemaining === 0) this.chunkState = 'DATA_CRLF';
    } else if (this.chunkState === 'DATA_CRLF') {
      if (this.buffer.length < 2) return; // wait for trailing CRLF
      this.buffer = this.buffer.slice(2); // consume "\r\n"
      this.chunkState = 'SIZE';
    } else if (this.chunkState === 'TRAILERS') {
      // Consume trailer headers up to the terminating CRLF.
      var end = this.buffer.indexOf('\r\n');
      if (end === -1) return;
      if (end === 0) {
        // Empty line — end of trailers and of the message.
        this.buffer = this.buffer.slice(2);
        this._finish();
        return;
      }
      // A trailer line; record it then keep scanning.
      var line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      var colon = line.indexOf(':');
      if (colon !== -1) {
        this.req.rawTrailers.push(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
      }
    }
  }
};

RequestParser.prototype._finish = function () {
  if (this.done) return;
  this.done = true;
  this.req.complete = true;
  this.req._endData(); // push(null) → Readable emits 'end' once drained
};

// ---------------------------------------------------------------------------
// ServerResponse
// ---------------------------------------------------------------------------
function ServerResponse(req) {
  EventEmitter.call(this);
  this.socket = req ? req.socket : null;
  this.connection = this.socket;
  this._req = req || null;  // request is re-read at send time for keep-alive
  this.statusCode = 200;
  this.statusMessage = undefined;
  this.headersSent = false;
  this.finished = false;
  this.writableEnded = false;
  this.sendDate = true;
  this._headers = {};      // lowercased name -> { name, value }
  this._headerSent = false;
  this._chunked = false;   // streaming with Transfer-Encoding: chunked
  this._hasContentLength = false;
  this._willKeepAlive = false; // finalized in _sendHeaders
}
inherits(ServerResponse, EventEmitter);

// Decide whether a request permits keep-alive: HTTP/1.1 (or HTTP/1.0 with an
// explicit `Connection: keep-alive`) and no `Connection: close`.
function shouldKeepAlive(req) {
  var conn = req.headers && req.headers['connection'];
  conn = conn ? String(conn).toLowerCase() : '';
  if (req.httpVersionMajor === 1 && req.httpVersionMinor >= 1) {
    return conn.indexOf('close') === -1;
  }
  // HTTP/1.0 (or older): only keep alive when explicitly requested.
  return conn.indexOf('keep-alive') !== -1;
}

ServerResponse.prototype.setHeader = function (name, value) {
  if (this.headersSent) throw new Error('Cannot set headers after they are sent to the client');
  this._headers[name.toLowerCase()] = { name: name, value: value };
  return this;
};
ServerResponse.prototype.getHeader = function (name) {
  var h = this._headers[name.toLowerCase()];
  return h ? h.value : undefined;
};
ServerResponse.prototype.getHeaderNames = function () {
  return Object.keys(this._headers).map(function (k) { return k; });
};
ServerResponse.prototype.getHeaders = function () {
  var out = {};
  for (var k in this._headers) out[k] = this._headers[k].value;
  return out;
};
ServerResponse.prototype.hasHeader = function (name) {
  return Object.prototype.hasOwnProperty.call(this._headers, name.toLowerCase());
};
ServerResponse.prototype.removeHeader = function (name) {
  delete this._headers[name.toLowerCase()];
};

// writeHead(status[, statusMessage][, headers])
ServerResponse.prototype.writeHead = function (statusCode, statusMessage, headers) {
  if (this.headersSent) throw new Error('Cannot render headers after they are sent to the client');
  this.statusCode = statusCode;
  if (typeof statusMessage === 'string') {
    this.statusMessage = statusMessage;
  } else if (statusMessage && typeof statusMessage === 'object') {
    headers = statusMessage;
  }
  if (headers) {
    if (Array.isArray(headers)) {
      // Flat [k, v, k, v, ...] form.
      for (var i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
    } else {
      for (var key in headers) this.setHeader(key, headers[key]);
    }
  }
  return this;
};
ServerResponse.prototype.writeHeader = ServerResponse.prototype.writeHead;

// Reusable framing buffers (avoid re-allocating per response).
var CRLF_BUF = Buffer.from('\r\n', 'latin1');
var CHUNK_TERM = Buffer.from('0\r\n\r\n', 'latin1');

// Serialize the status line + headers. With `defer`, the header bytes are
// stashed in `this._headerBuf` (so `end()` can coalesce them with the body into
// a single socket write) instead of being sent immediately.
ServerResponse.prototype._sendHeaders = function (knownLength, defer) {
  if (this._headerSent) return;

  var msg = this.statusMessage;
  if (msg === undefined) msg = STATUS_CODES[this.statusCode] || 'unknown';

  var lines = ['HTTP/1.1 ' + this.statusCode + ' ' + msg];

  // Default Date header unless the user set one.
  if (this.sendDate && !this.hasHeader('date')) lines.push('Date: ' + new Date().toUTCString());

  // Framing: prefer a known Content-Length; else fall back to chunked. We write
  // straight into _headers here (the public setHeader guard would reject these
  // once headersSent flips below).
  this._hasContentLength = this.hasHeader('content-length');
  if (!this._hasContentLength && !this.hasHeader('transfer-encoding')) {
    if (knownLength != null) {
      this._headers['content-length'] = { name: 'Content-Length', value: String(knownLength) };
      this._hasContentLength = true;
    } else {
      // Streaming write() with unknown length — use chunked encoding.
      this._headers['transfer-encoding'] = { name: 'Transfer-Encoding', value: 'chunked' };
      this._chunked = true;
    }
  }

  // Keep-alive requires a definite body boundary (Content-Length or chunked)
  // so the client knows where the response ends. We always have one of those
  // by this point, so keep alive iff the request allowed it and the user did
  // not override the Connection header. The request is re-read here (not at
  // construction) because its headers are only parsed by send time.
  var reqKeepAlive = this._req ? shouldKeepAlive(this._req) : false;
  if (this.hasHeader('connection')) {
    var connVal = String(this.getHeader('connection')).toLowerCase();
    this._willKeepAlive = connVal.indexOf('close') === -1 && reqKeepAlive;
  } else {
    this._willKeepAlive = reqKeepAlive;
    this._headers['connection'] = {
      name: 'Connection',
      value: this._willKeepAlive ? 'keep-alive' : 'close',
    };
  }

  this._headerSent = true;
  this.headersSent = true;

  for (var k in this._headers) {
    var h = this._headers[k];
    if (Array.isArray(h.value)) {
      for (var i = 0; i < h.value.length; i++) lines.push(h.name + ': ' + h.value[i]);
    } else {
      lines.push(h.name + ': ' + h.value);
    }
  }

  lines.push('', ''); // blank line terminating the header block
  var headerBuf = Buffer.from(lines.join('\r\n'), 'latin1');
  if (defer) { this._headerBuf = headerBuf; return; }
  if (this.socket) this.socket.write(headerBuf);
};

ServerResponse.prototype.write = function (chunk, encoding, cb) {
  if (typeof encoding === 'function') { cb = encoding; encoding = null; }
  // First write with no end() -> streaming, length unknown -> chunked framing.
  if (!this._headerSent) this._sendHeaders(null);

  var buf = chunk == null ? Buffer.alloc(0)
    : Buffer.isBuffer(chunk) ? chunk
    : Buffer.from(chunk, encoding || 'utf8');

  if (this._chunked) {
    if (buf.length > 0 && this.socket) {
      // One write per chunk: <hex-size>\r\n<data>\r\n
      var size = Buffer.from(buf.length.toString(16) + '\r\n', 'latin1');
      this.socket.write(Buffer.concat([size, buf, CRLF_BUF]));
    }
  } else if (buf.length > 0 && this.socket) {
    this.socket.write(buf); // raw bytes — no latin1 round-trip
  }
  if (typeof cb === 'function') nextTick(cb);
  return true;
};

ServerResponse.prototype.end = function (chunk, encoding, cb) {
  if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = null; }
  else if (typeof encoding === 'function') { cb = encoding; encoding = null; }
  if (this.finished) return this;

  var buf = chunk == null ? null
    : Buffer.isBuffer(chunk) ? chunk
    : Buffer.from(chunk, encoding || 'utf8');

  if (!this._headerSent) {
    // Whole body known in this single end() call -> emit a Content-Length, and
    // send headers + body in ONE socket write (the hot res.json/res.send path).
    this._sendHeaders(buf ? buf.length : 0, true);
    if (this.socket) {
      this.socket.write(
        buf && buf.length > 0 ? Buffer.concat([this._headerBuf, buf]) : this._headerBuf
      );
    }
  } else {
    // Headers already sent via write(); flush the final piece.
    if (buf && buf.length > 0) this.write(buf);
    if (this._chunked && this.socket) this.socket.write(CHUNK_TERM); // terminating chunk
  }

  this.finished = true;
  this.writableEnded = true;
  // Keep-alive: leave the socket open for the next request (the Server resets
  // its parser on 'finish'). Otherwise close it once the response is flushed.
  if (this.socket && !this._willKeepAlive) this.socket.end();
  this.emit('finish');
  if (typeof cb === 'function') nextTick(cb);
  return this;
};

ServerResponse.prototype.flushHeaders = function () { if (!this._headerSent) this._sendHeaders(null); };

// ---------------------------------------------------------------------------
// Server — wraps a net.Server; wires the parser to each connection.
// ---------------------------------------------------------------------------
function Server(options, requestListener) {
  if (typeof options === 'function') {
    requestListener = options;
    options = {};
  }
  EventEmitter.call(this);
  this._options = options || {};

  var self = this;
  this._net = net.createServer(function (socket) {
    self._onConnection(socket);
  });
  // Surface net-level server errors/close on the http server too.
  this._net.on('error', function (e) { self.emit('error', e); });
  this._net.on('close', function () { self.emit('close'); });

  if (typeof requestListener === 'function') this.on('request', requestListener);
}
inherits(Server, EventEmitter);

Server.prototype._onConnection = function (socket) {
  var self = this;
  this.emit('connection', socket);

  // A single parser persists for the life of the (possibly keep-alive) socket;
  // it is reset and re-targeted at a fresh IncomingMessage for each request.
  var parser = new RequestParser(new IncomingMessage(socket));

  // Wire the current message's lifecycle. Called for the first request and
  // again after each keep-alive reset.
  function arm() {
    var req = parser.req;
    var res = new ServerResponse(req);

    // Fire 'request' once the request line + headers are parsed (Node behavior).
    parser.onHeaders = function () {
      req.remoteAddress = socket.remoteAddress;
      // Protocol upgrade (e.g. WebSocket): hand the raw socket to 'upgrade'
      // listeners and stop HTTP parsing on this connection.
      var conn = String(req.headers['connection'] || '').toLowerCase();
      var upgrade = req.headers['upgrade'];
      if (upgrade && conn.indexOf('upgrade') !== -1 && self.listenerCount('upgrade') > 0) {
        parser.upgraded = true;
        var head = Buffer.from(parser.buffer || '', 'latin1');
        parser.buffer = '';
        self.emit('upgrade', req, socket, head);
        return;
      }
      self.emit('request', req, res);
    };

    // After the response finishes: keep-alive -> reset for the next request on
    // the same socket and re-run the parser against any pipelined bytes.
    res.once('finish', function () {
      if (!res._willKeepAlive || socket.destroyed) return;
      // The request body must be fully consumed before reuse; if the handler
      // ended the response early, drop any unread body so the parser realigns.
      parser.reset(new IncomingMessage(socket));
      arm();
      // Re-run against bytes already buffered (pipelined next request).
      if (parser.buffer.length) parser._run();
    });
  }
  arm();

  socket.on('data', function (buf) {
    // Once upgraded, raw bytes belong to the upgrade consumer (e.g. WebSocket),
    // which installs its own 'data' listener — don't feed the dead HTTP parser.
    if (parser.upgraded) return;
    // socket 'data' is a Buffer (no setEncoding here); feed latin1 to parser.
    parser.push(Buffer.isBuffer(buf) ? buf.toString('latin1') : toLatin1Str(buf));
  });
  socket.on('end', function () {
    // Peer EOF: if the parser never completed (e.g. no body framing), close it.
    if (!parser.done && parser.state !== 'HEADERS') parser._finish();
  });
  socket.on('error', function (e) { if (parser.req) parser.req.emit('error', e); });
};

function toLatin1Str(x) {
  if (typeof x === 'string') return Buffer.from(x, 'utf8').toString('latin1');
  return Buffer.from(x).toString('latin1');
}

Server.prototype.listen = function () {
  this._net.listen.apply(this._net, arguments);
  // Mirror 'listening' from the underlying net server.
  var self = this;
  this._net.once('listening', function () { self.emit('listening'); });
  return this;
};
Server.prototype.close = function (cb) {
  this._net.close(cb);
  return this;
};
Server.prototype.address = function () { return this._net.address(); };
Server.prototype.ref = function () { this._net.ref(); return this; };
Server.prototype.unref = function () { this._net.unref(); return this; };
Server.prototype.setTimeout = function (ms, cb) { if (cb) this.on('timeout', cb); return this; };

// ---------------------------------------------------------------------------
// ClientRequest — http.request(options[, cb]); a writable-ish EventEmitter.
//
// Opens a net socket and, once connected, writes the request line + headers
// (+ any body). The response is parsed into a client IncomingMessage, surfaced
// via the 'response' event and the http.request callback.
// ---------------------------------------------------------------------------
function normalizeClientOptions(options) {
  if (typeof options === 'string') {
    var u = new URL(options);
    options = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: (u.pathname || '/') + (u.search || ''),
    };
  } else {
    options = options || {};
  }
  return options;
}

// A connection pool. The default `globalAgent` has keepAlive off (one request
// per socket, like Node); pass `new http.Agent({ keepAlive: true })` to reuse
// sockets (and TLS sessions) across requests to the same host.
function Agent(options) {
  options = options || {};
  this.keepAlive = !!options.keepAlive;
  this.maxSockets = options.maxSockets || Infinity;
  this.maxFreeSockets = options.maxFreeSockets || 256;
  this._free = {}; // key -> [idle sockets]
}
Agent.prototype._acquire = function (key) {
  var list = this._free[key];
  while (list && list.length) {
    var s = list.pop();
    if (s && !s._veloxClosed) return s;
  }
  return null;
};
Agent.prototype._release = function (key, socket) {
  if (socket._veloxClosed) return;
  var list = this._free[key] || (this._free[key] = []);
  if (list.length < this.maxFreeSockets) list.push(socket);
  else if (socket.end) socket.end();
};
Agent.prototype.destroy = function () {
  for (var k in this._free) this._free[k].forEach(function (s) { if (s.end) s.end(); });
  this._free = {};
};
Agent.prototype.getName = function (o) {
  o = o || {};
  return (o.protocol === 'https:' ? 'https' : 'http') + ':' +
    (o.host || o.hostname || 'localhost') + ':' + (o.port || '');
};
var globalAgent = new Agent({ keepAlive: false });

function ClientRequest(options, cb) {
  EventEmitter.call(this);
  options = normalizeClientOptions(options);

  var useTls = options.protocol === 'https:' || options._tls === true;
  this._tls = useTls;
  this.method = (options.method || 'GET').toUpperCase();
  this.path = options.path || '/';
  var host = options.hostname || options.host || 'localhost';
  // hostname may include a trailing port if `host` was passed; keep it simple.
  this._host = host;
  this._port = Number(options.port) || (useTls ? 443 : 80);
  this._defaultPort = useTls ? 443 : 80;

  this.finished = false;
  this.aborted = false;
  this.destroyed = false;
  this._headerSent = false;
  this._headers = {};        // lowercased -> { name, value }
  this._bodyChunks = [];     // queued body before headers are flushed
  this._chunked = false;
  this.res = null;

  // Seed headers from the caller.
  var hdrs = options.headers || {};
  for (var k in hdrs) {
    if (Object.prototype.hasOwnProperty.call(hdrs, k)) this.setHeader(k, hdrs[k]);
  }
  // Default Host header (host[:port]) unless provided.
  if (!this.hasHeader('host')) {
    var hostHeader = this._host;
    if (this._port && this._port !== this._defaultPort) hostHeader += ':' + this._port;
    this.setHeader('Host', hostHeader);
  }

  if (typeof cb === 'function') this.once('response', cb);

  var self = this;
  this._key = (useTls ? 'https' : 'http') + ':' + this._host + ':' + this._port;
  this._agent = (options.agent !== undefined) ? options.agent : globalAgent;

  // Reuse a pooled keep-alive socket if the agent has one; else open a new one.
  var socket = (this._agent && this._agent.keepAlive) ? this._agent._acquire(this._key) : null;
  var reused = !!socket;
  if (!socket) {
    socket = useTls
      ? net.connect({ port: this._port, host: this._host, tls: true, servername: this._host })
      : net.connect(this._port, this._host);
    bindClientSocket(socket);
  }
  this.socket = socket;
  this.connection = socket;

  // Parse the response stream. The socket's persistent handlers delegate to
  // its *current* request (`_veloxReq`), so the socket can be reused.
  var res = new IncomingMessage(socket);
  var parser = new RequestParser(res, true);
  this._parser = parser;
  parser.onHeaders = function () {
    self.res = res;
    self.emit('response', res);
  };
  res.on('end', function () { self._releaseOrClose(res); });
  socket._veloxReq = self;

  // A fresh socket fires 'connect'; a reused one is already connected (end()
  // flushes immediately via the not-connecting path).
  if (!reused) socket.on('connect', function () { self._onSocketConnect(); });
}

// Persistent socket handlers that route I/O to the socket's current request.
function bindClientSocket(socket) {
  socket.on('data', function (buf) {
    var req = socket._veloxReq;
    if (req && req._parser) req._parser.push(Buffer.isBuffer(buf) ? buf.toString('latin1') : toLatin1Str(buf));
  });
  socket.on('end', function () { var req = socket._veloxReq; if (req && req._parser) req._parser.eof(); });
  socket.on('close', function () {
    socket._veloxClosed = true;
    var req = socket._veloxReq;
    if (req) { if (req._parser) req._parser.eof(); req.emit('close'); }
  });
  socket.on('error', function (e) { var req = socket._veloxReq; if (req) req.emit('error', e); });
}

inherits(ClientRequest, EventEmitter);

// After a response completes, return the socket to the pool (keep-alive) or
// close it. (Defined after `inherits`, which replaces the prototype.)
ClientRequest.prototype._releaseOrClose = function (res) {
  if (this._released) return;
  this._released = true;
  var conn = String((res.headers && res.headers.connection) || '').toLowerCase();
  var keepAlive = this._agent && this._agent.keepAlive && conn !== 'close'
    && res.httpVersion !== '1.0' && this.socket && !this.socket._veloxClosed;
  if (keepAlive) {
    this.socket._veloxReq = null;
    this._agent._release(this._key, this.socket);
  } else if (this.socket && this.socket.end) {
    this.socket.end();
  }
};

ClientRequest.prototype.setHeader = function (name, value) {
  if (this._headerSent) throw new Error('Cannot set headers after they are sent to the client');
  this._headers[name.toLowerCase()] = { name: name, value: value };
  return this;
};
ClientRequest.prototype.getHeader = function (name) {
  var h = this._headers[name.toLowerCase()];
  return h ? h.value : undefined;
};
ClientRequest.prototype.hasHeader = function (name) {
  return Object.prototype.hasOwnProperty.call(this._headers, name.toLowerCase());
};
ClientRequest.prototype.removeHeader = function (name) {
  delete this._headers[name.toLowerCase()];
};

// Build and send the request line + headers (called once, on connect or when
// the whole body is known at end()).
ClientRequest.prototype._sendHeaders = function (knownLength) {
  if (this._headerSent) return;

  // Framing for any body: a known Content-Length, else chunked.
  if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) {
    if (knownLength != null && knownLength > 0) {
      this.setHeader('Content-Length', String(knownLength));
    } else if (knownLength == null) {
      // Streaming write() without a known length -> chunked.
      this.setHeader('Transfer-Encoding', 'chunked');
      this._chunked = true;
    }
  } else if (String(this.getHeader('transfer-encoding') || '').toLowerCase().indexOf('chunked') !== -1) {
    this._chunked = true;
  }
  // Keep-alive when the agent pools sockets; otherwise close after the response.
  if (!this.hasHeader('connection')) {
    this.setHeader('Connection', (this._agent && this._agent.keepAlive) ? 'keep-alive' : 'close');
  }

  var lines = [this.method + ' ' + this.path + ' HTTP/1.1'];
  for (var k in this._headers) {
    var h = this._headers[k];
    if (Array.isArray(h.value)) {
      for (var i = 0; i < h.value.length; i++) lines.push(h.name + ': ' + h.value[i]);
    } else {
      lines.push(h.name + ': ' + h.value);
    }
  }
  lines.push('', '');
  this._headerSent = true;
  this.socket.write(lines.join('\r\n'), 'latin1');
};

// On connect: flush headers (computing Content-Length when the body is already
// fully queued) and any buffered body chunks.
ClientRequest.prototype._onSocketConnect = function () {
  if (this._headerSent) return; // already flushed (shouldn't happen)

  if (this.finished) {
    // Body fully known: send headers with a definite Content-Length.
    var total = 0;
    for (var i = 0; i < this._bodyChunks.length; i++) total += this._bodyChunks[i].length;
    this._sendHeaders(total);
    this._flushBody();
    this._finishBody();
  } else {
    // Streaming: headers now, body via write()/end() as it arrives (chunked).
    this._sendHeaders(null);
    this._flushBody();
  }
  this.emit('socket', this.socket);
};

ClientRequest.prototype._flushBody = function () {
  for (var i = 0; i < this._bodyChunks.length; i++) {
    this._writeBodyChunk(this._bodyChunks[i]);
  }
  this._bodyChunks = [];
};

ClientRequest.prototype._writeBodyChunk = function (buf) {
  if (buf.length === 0) return;
  if (this._chunked) {
    this.socket.write(buf.length.toString(16) + '\r\n', 'latin1');
    this.socket.write(buf.toString('latin1'), 'latin1');
    this.socket.write('\r\n', 'latin1');
  } else {
    this.socket.write(buf.toString('latin1'), 'latin1');
  }
};

ClientRequest.prototype._finishBody = function () {
  if (this._chunked) this.socket.write('0\r\n\r\n', 'latin1');
};

ClientRequest.prototype.write = function (chunk, encoding, cb) {
  if (typeof encoding === 'function') { cb = encoding; encoding = null; }
  var buf = chunk == null ? Buffer.alloc(0)
    : Buffer.isBuffer(chunk) ? chunk
    : Buffer.from(chunk, encoding || 'utf8');

  if (this._headerSent) {
    // Connection already established and streaming -> write straight through.
    this._writeBodyChunk(buf);
  } else {
    // Not connected yet: queue until _onSocketConnect flushes.
    this._bodyChunks.push(buf);
  }
  if (typeof cb === 'function') nextTick(cb);
  return true;
};

ClientRequest.prototype.end = function (chunk, encoding, cb) {
  if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = null; }
  else if (typeof encoding === 'function') { cb = encoding; encoding = null; }
  if (this.finished) return this;

  if (chunk != null) {
    var buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding || 'utf8');
    this._bodyChunks.push(buf);
  }
  this.finished = true;

  if (this._headerSent) {
    // Already streaming (chunked): terminate the body now.
    this._flushBody();
    this._finishBody();
  }
  // Otherwise _onSocketConnect (fired on 'connect') flushes with a definite
  // Content-Length. If the socket is already connected, flush immediately.
  else if (!this.socket.connecting && !this.socket.pending) {
    this._onSocketConnect();
  }

  if (typeof cb === 'function') this.once('finish', cb);
  this.emit('finish');
  return this;
};

ClientRequest.prototype.abort = function () {
  if (this.aborted) return;
  this.aborted = true;
  this.destroyed = true;
  if (this.socket) this.socket.destroy();
  this.emit('abort');
};
ClientRequest.prototype.destroy = function (err) {
  if (this.destroyed) return this;
  this.destroyed = true;
  if (this.socket) this.socket.destroy(err);
  if (err) this.emit('error', err);
  return this;
};
ClientRequest.prototype.setTimeout = function (ms, cb) { if (cb) this.once('timeout', cb); return this; };
ClientRequest.prototype.setNoDelay = function () { return this; };
ClientRequest.prototype.setSocketKeepAlive = function () { return this; };
ClientRequest.prototype.flushHeaders = function () {
  if (!this._headerSent && !this.socket.connecting) this._sendHeaders(null);
};

// ---------------------------------------------------------------------------
// Factory + client
// ---------------------------------------------------------------------------
function createServer(options, requestListener) {
  return new Server(options, requestListener);
}
function request(options, cb) {
  return new ClientRequest(options, cb);
}
function get(options, cb) {
  var req = new ClientRequest(options, cb);
  req.method = 'GET';
  req.end();
  return req;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  STATUS_CODES: STATUS_CODES,
  METHODS: METHODS,
  IncomingMessage: IncomingMessage,
  ServerResponse: ServerResponse,
  ClientRequest: ClientRequest,
  Server: Server,
  createServer: createServer,
  request: request,
  get: get,
  Agent: Agent,
  globalAgent: globalAgent,
};
module.exports.default = module.exports;

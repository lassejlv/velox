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
  this.onError = null;       // set by Server: fired on a request parse error
  this.errored = false;
}

RequestParser.prototype._fail = function (code, message) {
  this.errored = true;
  this.done = true;
  var err = new Error('Parse Error: ' + message);
  err.code = code;
  if (this.onError) this.onError(err);
};

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
    if (this.errored) return;
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
    // Strict request-line validation (llhttp rejects unknown methods).
    var methodTok = firstSp === -1 ? firstLine : firstLine.slice(0, firstSp);
    if (firstSp === -1 || METHODS.indexOf(methodTok) === -1) {
      this._fail('HPE_INVALID_METHOD', 'Invalid method encountered');
      return;
    }
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
    // Strictness for requests (llhttp parity, closes request smuggling):
    // a bare CR or LF inside a header line — `split('\r\n')` only removes
    // proper CRLF pairs, so any leftover is a stray terminator — and a line
    // without a colon are hard parse errors.
    if (!this.isResponse && (line.indexOf('\r') !== -1 || line.indexOf('\n') !== -1)) {
      this._fail('HPE_INVALID_HEADER_TOKEN', 'Invalid header token');
      return;
    }
    var colon = line.indexOf(':');
    if (colon === -1) {
      if (!this.isResponse) {
        this._fail('HPE_INVALID_HEADER_TOKEN', 'Invalid header token');
        return;
      }
      pendingName = null; continue;
    }
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
      // Strict size line (llhttp parity): no stray CR/LF, and the size token
      // itself must be pure hex — anything else is a hard parse error that
      // could otherwise be abused for request smuggling.
      if (sizeLine.indexOf('\r') !== -1 || sizeLine.indexOf('\n') !== -1) {
        this._fail('HPE_INVALID_CHUNK_SIZE', 'Invalid character in chunk size');
        return;
      }
      // Strip any chunk extensions after ';'.
      var semi = sizeLine.indexOf(';');
      if (semi !== -1) sizeLine = sizeLine.slice(0, semi);
      if (!/^[0-9a-fA-F]+$/.test(sizeLine.trim())) {
        this._fail('HPE_INVALID_CHUNK_SIZE', 'Invalid character in chunk size');
        return;
      }
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
      if (this.buffer.slice(0, 2) !== '\r\n') {
        this._fail('HPE_INVALID_CHUNK_SIZE', 'Chunk data not terminated by CRLF');
        return;
      }
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

// events.captureRejections integration: a listener on the response rejecting
// routes here — Node tears the connection down with that error.
ServerResponse.prototype[Symbol.for('nodejs.rejection')] = function (err) {
  if (this.socket) this.socket.emit('error', err);
};

// assignSocket/detachSocket — Node attaches the underlying socket to the
// response here; HTTP-injection libraries (light-my-request, supertest) build a
// ServerResponse over a synthetic null socket and call these, then read back
// what was written. Mirror the contract: cross-link socket._httpMessage and
// emit 'socket'.
ServerResponse.prototype.assignSocket = function (socket) {
  if (socket) socket._httpMessage = this;
  this.socket = socket;
  this.connection = socket;
  this.emit('socket', socket);
};
ServerResponse.prototype.detachSocket = function (socket) {
  if (socket) socket._httpMessage = null;
  this.socket = null;
  this.connection = null;
};

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

// Internal Node API some tests/libraries poke: write a raw piece of the
// response (header-flushing handled by write()).
ServerResponse.prototype._send = function (data, encoding, cb) {
  if (data != null && data !== '') return this.write(data, encoding, cb);
  if (!this._headerSent) this._sendHeaders(null);
  if (typeof cb === 'function') nextTick(cb);
  return true;
};

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
    var req10 = this._req && this._req.httpVersionMajor === 1 && this._req.httpVersionMinor === 0;
    if (req10) {
      // HTTP/1.0: chunked doesn't exist and Node never invents framing the
      // user didn't provide. If the client advertised `TE: chunked`, chunked
      // is fair game (and the connection may persist); otherwise stream raw
      // and mark the end of the body by closing the connection.
      var te = String((this._req.headers && this._req.headers['te']) || '').toLowerCase();
      if (te.indexOf('chunked') !== -1) {
        this._headers['transfer-encoding'] = { name: 'Transfer-Encoding', value: 'chunked' };
        this._chunked = true;
      } else {
        this._rawStream = true;
        this._forceClose = true; // no framing → the close IS the terminator
      }
    } else if (knownLength != null) {
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
  if (this._forceClose) reqKeepAlive = false;
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
    : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
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
  // Backpressure: the reactor buffers writes natively, but `while (res.write())`
  // loops need an eventual false + a later 'drain' to terminate (Node returns
  // false past the socket high-water mark). Track bytes per synchronous burst.
  this._outPending = (this._outPending || 0) + buf.length;
  if (this._outPending >= 16384) {
    var self = this;
    if (!this._drainScheduled) {
      this._drainScheduled = true;
      setTimeout(function () {
        self._drainScheduled = false;
        self._outPending = 0;
        if (!self.finished) self.emit('drain');
      }, 0);
    }
    return false;
  }
  return true;
};

ServerResponse.prototype.end = function (chunk, encoding, cb) {
  if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = null; }
  else if (typeof encoding === 'function') { cb = encoding; encoding = null; }
  if (this.finished) return this;

  var buf = chunk == null ? null
    : Buffer.isBuffer(chunk) ? chunk
    : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
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
    if (this._chunked && this.socket) {
      if (this._trailers) {
        // Terminating chunk followed by trailer headers (then the blank line).
        var tl = '0\r\n';
        for (var tk in this._trailers) tl += tk + ': ' + this._trailers[tk] + '\r\n';
        tl += '\r\n';
        this.socket.write(Buffer.from(tl, 'latin1'));
      } else {
        this.socket.write(CHUNK_TERM); // terminating chunk
      }
    }
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
// addTrailers — trailer headers sent after a chunked body (the response must
// advertise a `Trailer` header). Stored; emitted by end() on the chunked path.
ServerResponse.prototype.addTrailers = function (headers) {
  this._trailers = this._trailers || {};
  if (Array.isArray(headers)) { for (var i = 0; i < headers.length; i++) this._trailers[headers[i][0]] = headers[i][1]; }
  else for (var k in headers) this._trailers[k] = headers[k];
};
// 1xx informational responses sent ahead of the main response.
// Destroy the response: tear the underlying connection down (the client sees
// an abort). Node parity for `res.destroy([err])`.
ServerResponse.prototype.destroy = function (err) {
  if (this.destroyed) return this;
  this.destroyed = true;
  if (this.socket) this.socket.destroy(err);
  return this;
};

ServerResponse.prototype.writeContinue = function (cb) {
  if (this.socket) this.socket.write('HTTP/1.1 100 Continue\r\n\r\n', 'latin1');
  if (typeof cb === 'function') nextTick(cb);
};
ServerResponse.prototype.writeProcessing = function (cb) {
  if (this.socket) this.socket.write('HTTP/1.1 102 Processing\r\n\r\n', 'latin1');
  if (typeof cb === 'function') nextTick(cb);
};
ServerResponse.prototype.writeEarlyHints = function (hints, cb) {
  var lines = 'HTTP/1.1 103 Early Hints\r\n';
  if (hints) for (var k in hints) {
    var v = hints[k];
    if (Array.isArray(v)) for (var i = 0; i < v.length; i++) lines += k + ': ' + v[i] + '\r\n';
    else lines += k + ': ' + v + '\r\n';
  }
  lines += '\r\n';
  if (this.socket) this.socket.write(lines, 'latin1');
  if (typeof cb === 'function') nextTick(cb);
};

// ---------------------------------------------------------------------------
// Server — wraps a net.Server; wires the parser to each connection.
// ---------------------------------------------------------------------------
function Server(options, requestListener) {
  if (!(this instanceof Server)) return new Server(options, requestListener);
  if (typeof options === 'function') {
    requestListener = options;
    options = {};
  }
  EventEmitter.call(this);
  this._options = options || {};

  // Node tuning knobs frameworks read/write (stored; velox doesn't time out
  // idle connections, but the properties round-trip so code that sets them works).
  this.keepAliveTimeout = 5000;
  this.headersTimeout = 60000;
  this.requestTimeout = 300000;
  this.timeout = 0;
  this.maxHeadersCount = 2000;
  this.maxRequestsPerSocket = 0;

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

  // Node's clientError contract: a request parse error goes to 'clientError'
  // listeners if any; the default behavior answers 400 and closes the socket.
  function onParseError(err) {
    if (self.listenerCount('clientError') > 0) {
      self.emit('clientError', err, socket);
      return;
    }
    try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (e) {}
  }
  parser.onError = onParseError;

  // Eagerly reject garbage that follows a completed request (llhttp parses
  // pipelined bytes immediately; waiting for the response to finish would let
  // a malformed follow-up request hang the connection forever).
  function checkPipelinedGarbage() {
    if (parser.upgraded || parser.errored || !parser.done) return;
    var b = parser.buffer;
    var k = 0;
    while (k < b.length && (b[k] === '\r' || b[k] === '\n')) k++;
    if (k >= b.length) return; // nothing but blank lines so far
    var rest = b.slice(k);
    var sp = rest.indexOf(' ');
    var token = sp === -1 ? rest : rest.slice(0, sp);
    var ok = false;
    for (var m = 0; m < METHODS.length; m++) {
      if (sp === -1 ? METHODS[m].indexOf(token) === 0 : METHODS[m] === token) { ok = true; break; }
    }
    if (!ok) {
      var err = new Error('Parse Error: Invalid method encountered');
      err.code = 'HPE_INVALID_METHOD';
      parser.errored = true;
      onParseError(err);
    }
  }

  // Wire the current message's lifecycle. Called for the first request and
  // again after each keep-alive reset.
  function arm() {
    var req = parser.req;
    var res = new ServerResponse(req);
    parser._curRes = res;

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
    checkPipelinedGarbage();
  });
  socket.on('end', function () {
    // Peer EOF: if the parser never completed (e.g. no body framing), close it.
    if (!parser.done && parser.state !== 'HEADERS') parser._finish();
  });
  socket.on('error', function (e) {
    // A connection error tears the connection down (Node aborts the socket);
    // forward to the request only when someone is listening.
    if (parser.req && parser.req.listenerCount('error') > 0) parser.req.emit('error', e);
    socket.destroy();
  });
  socket.on('close', function () {
    // Client went away while a response was still being produced → the
    // request was aborted (Node: 'aborted', then 'error' if anyone listens).
    var req = parser.req, res = parser._curRes;
    if (req && res && !res.writableEnded && !req.aborted && !parser.upgraded) {
      req.aborted = true;
      req.emit('aborted');
      if (req.listenerCount('error') > 0) {
        var err = new Error('aborted');
        err.code = 'ECONNRESET';
        req.emit('error', err);
      }
    }
  });
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
  if (!(this instanceof Agent)) return new Agent(options);
  EventEmitter.call(this);
  options = options || {};
  this.options = options;
  this.keepAlive = !!options.keepAlive;
  this.keepAliveMsecs = options.keepAliveMsecs || 1000;
  this.maxSockets = options.maxSockets !== undefined ? options.maxSockets : Infinity;
  this.maxFreeSockets = options.maxFreeSockets || 256;
  this.maxTotalSockets = options.maxTotalSockets || Infinity;
  this.scheduling = options.scheduling || 'lifo';
  this.defaultPort = options.defaultPort || 80;
  this.protocol = options.protocol || 'http:';
  // Node's public bookkeeping maps (tooling inspects these).
  this.sockets = {};
  this.freeSockets = {};
  this.requests = {};
  this._free = {}; // key -> [idle sockets] (velox's internal keep-alive pool)
}
inherits(Agent, EventEmitter);
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
// Node's socket-pool name: host:port[:localAddress][:family] — note no
// protocol prefix and no `path` (velox's internal pool key is separate).
Agent.prototype.getName = function (o) {
  o = o || {};
  var name = (o.host || o.hostname || 'localhost') + ':' + (o.port || '');
  if (o.localAddress) name += ':' + o.localAddress;
  if (o.family === 4 || o.family === 6) name += ':' + o.family;
  return name;
};

// Legacy request-scheduling surface. velox drives requests from ClientRequest
// directly, but the bookkeeping mirrors Node: over maxSockets the request
// queues under its pool name; otherwise a connection is created for it.
Agent.prototype.addRequest = function (req, options, port, localAddress) {
  if (typeof options === 'string') {
    options = { host: options, port: port, localAddress: localAddress };
  }
  options = options || {};
  var name = this.getName(options);
  var active = (this.sockets[name] || []).length;
  if (active >= this.maxSockets) {
    (this.requests[name] = this.requests[name] || []).push(req);
    return;
  }
  var self = this;
  var socket = this.createConnection(options);
  (this.sockets[name] = this.sockets[name] || []).push(socket);
  if (socket && typeof socket.once === 'function') {
    socket.once('close', function () {
      var list = self.sockets[name];
      if (list) {
        var i = list.indexOf(socket);
        if (i !== -1) list.splice(i, 1);
        if (!list.length) delete self.sockets[name];
      }
    });
  }
  if (req && typeof req.onSocket === 'function') req.onSocket(socket);
};

// Open a raw connection for this agent (Node's overridable hook; supports an
// AbortSignal in the options and an optional (err, socket) callback).
Agent.prototype.createConnection = function (options, cb) {
  var net = require('node:net');
  var socket = net.connect(options);
  if (typeof cb === 'function') {
    socket.once('connect', function () { cb(null, socket); });
    socket.once('error', function (e) { cb(e); });
  }
  return socket;
};
Agent.prototype.keepSocketAlive = function () { return !!this.keepAlive; };
Agent.prototype.reuseSocket = function () {};
Agent.prototype.removeSocket = function (socket, options) {
  var name = this.getName(options || {});
  var list = this.sockets[name];
  if (list) {
    var i = list.indexOf(socket);
    if (i !== -1) list.splice(i, 1);
    if (!list.length) delete this.sockets[name];
  }
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
  // Writable-stream flags some clients (e.g. got's isClientRequest) check to
  // tell a still-open request apart from a response.
  this.writable = true;
  this.writableEnded = false;
  this.writableFinished = false;
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

  // Reuse a pooled keep-alive socket if the agent has one; else open a new one
  // (through the caller's `createConnection` factory when provided).
  var socket = (this._agent && this._agent.keepAlive) ? this._agent._acquire(this._key) : null;
  var reused = !!socket;
  if (!socket) {
    if (typeof options.createConnection === 'function') {
      socket = options.createConnection(
        { port: this._port, host: this._host, servername: useTls ? this._host : undefined },
        function (err, s) { if (err && self.listenerCount('error')) self.emit('error', err); }
      );
    } else {
      socket = useTls
        ? net.connect({ port: this._port, host: this._host, tls: true, servername: this._host })
        : net.connect(this._port, this._host);
    }
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
    res.req = self; // Node's back-reference (handlers use `this.req` on the res)
    self.emit('response', res);
  };
  res.on('end', function () { self._releaseOrClose(res); });
  socket._veloxReq = self;

  // A fresh socket fires 'connect'; a reused one is already connected (end()
  // flushes immediately via the not-connecting path).
  if (!reused) socket.on('connect', function () { self._onSocketConnect(); });

  // AbortSignal: abort the request (AbortError 'error' + destroy) on signal.
  if (options.signal) {
    var sig = options.signal;
    var reqSelf = this;
    var onReqAbort = function () {
      if (reqSelf.destroyed) return;
      // Node's http AbortError shape: name AbortError, code ABORT_ERR. A
      // custom (non-default) abort reason passes through as-is.
      var err;
      if (sig.reason instanceof Error && sig.reason.name !== 'AbortError') {
        err = sig.reason;
      } else {
        err = new Error('The operation was aborted');
        err.name = 'AbortError';
        err.code = 'ABORT_ERR';
      }
      reqSelf.destroy(err);
    };
    if (sig.aborted) {
      // Destroyed synchronously (callers check req.destroyed right away);
      // the 'error' itself still arrives on the next tick via destroy().
      onReqAbort();
    } else if (typeof sig.addEventListener === 'function') {
      sig.addEventListener('abort', onReqAbort, { once: true });
      this.once('close', function () {
        if (typeof sig.removeEventListener === 'function') sig.removeEventListener('abort', onReqAbort);
      });
    }
  }
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
    // Let a read-until-close body finish first — only THEN is an incomplete
    // response a genuine abort ('aborted' + Node's ECONNRESET 'error' shape,
    // the latter only when someone listens).
    if (req && req._parser) req._parser.eof();
    var res = req && req.res;
    if (res && !res.complete && !res.aborted) {
      res.aborted = true;
      res.emit('aborted');
      if (res.listenerCount('error') > 0) {
        var aerr = new Error('aborted');
        aerr.code = 'ECONNRESET';
        res.emit('error', aerr);
      }
    }
    if (req) { req.emit('close'); }
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
    : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    : Buffer.from(chunk, encoding || 'utf8');

  if (this._headerSent) {
    // Connection already established and streaming -> write straight through.
    this._writeBodyChunk(buf);
  } else {
    // Not connected yet: queue until _onSocketConnect flushes.
    this._bodyChunks.push(buf);
  }
  if (typeof cb === 'function') nextTick(cb);
  // Backpressure: report false past the high-water mark within a synchronous
  // burst and emit 'drain' on the next tick (see ServerResponse.write).
  this._outPending = (this._outPending || 0) + buf.length;
  if (this._outPending >= 16384) {
    var self = this;
    if (!this._drainScheduled) {
      this._drainScheduled = true;
      setTimeout(function () {
        self._drainScheduled = false;
        self._outPending = 0;
        if (!self.finished && !self.destroyed) self.emit('drain');
      }, 0);
    }
    return false;
  }
  return true;
};

// events.captureRejections integration (Node destroys the request with the
// listener's rejection reason, surfacing it as the request 'error').
ClientRequest.prototype[Symbol.for('nodejs.rejection')] = function (err) {
  this.destroy(err);
};

ClientRequest.prototype.end = function (chunk, encoding, cb) {
  if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = null; }
  else if (typeof encoding === 'function') { cb = encoding; encoding = null; }
  if (this.finished) return this;

  if (chunk != null) {
    var buf = Buffer.isBuffer(chunk) ? chunk
      : ArrayBuffer.isView(chunk) ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.from(chunk, encoding || 'utf8');
    this._bodyChunks.push(buf);
  }
  this.finished = true;
  this.writable = false;
  this.writableEnded = true;
  this.writableFinished = true;

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
  // Destroying a request that never got its response surfaces Node's
  // 'socket hang up' / ECONNRESET (destroy after the response is flowing
  // is silent).
  if (!err && !this.res && !this.aborted) {
    err = new Error('socket hang up');
    err.code = 'ECONNRESET';
  }
  // Destroy the socket plainly — the error surfaces on the REQUEST (a socket
  // 'error' with no listener would throw from a microtask).
  if (this.socket) this.socket.destroy();
  // Node delivers the destroy error on the next tick — callers attach their
  // 'error' listener right after the destroy()/abort() call.
  if (err) {
    var self = this;
    nextTick(function () { self.emit('error', err); });
  }
  return this;
};
ClientRequest.prototype.setTimeout = function (ms, cb) {
  if (cb) this.once('timeout', cb);
  var self = this;
  if (this._timeoutTimer) clearTimeout(this._timeoutTimer);
  if (ms > 0) {
    // Fire 'timeout' if no response arrives in time (the listener decides
    // whether to abort — Node never aborts on its own).
    this._timeoutTimer = setTimeout(function () {
      self._timeoutTimer = null;
      if (!self.res && !self.destroyed && !self.aborted) self.emit('timeout');
    }, ms);
    if (this._timeoutTimer && this._timeoutTimer.unref) this._timeoutTimer.unref();
    function clearIt() {
      if (self._timeoutTimer) { clearTimeout(self._timeoutTimer); self._timeoutTimer = null; }
    }
    this.once('response', clearIt);
    this.once('close', clearIt);
    this.once('error', clearIt);
  }
  return this;
};
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
// Node overloads: request(url[, options][, callback]) and
// request(options[, callback]). Merge a URL string/object with an options
// object (options fields win), and find the callback wherever it landed.
function normalizeRequestArgs(url, options, cb) {
  if (typeof url === 'string' || (typeof URL !== 'undefined' && url instanceof URL)) {
    var base = normalizeClientOptions(String(url));
    if (typeof options === 'function') { cb = options; options = undefined; }
    options = options && typeof options === 'object' ? Object.assign(base, options) : base;
  } else {
    // First arg is the options object: request(options[, callback]).
    if (typeof options === 'function') cb = options;
    options = url || {};
  }
  return [options, cb];
}

// options.host/hostname must be a string (or absent) — Node throws
// ERR_INVALID_ARG_TYPE synchronously, before any connection is attempted.
function validateHost(host, name) {
  if (host !== null && host !== undefined && typeof host !== 'string') {
    throw require('node:util')._veloxErr.errInvalidArgType(
      'The "options.' + name + '" property must be of type string or one of undefined or null.',
      host);
  }
}
function request(url, options, cb) {
  var a = normalizeRequestArgs(url, options, cb);
  validateHost(a[0].hostname, 'hostname');
  validateHost(a[0].host, 'host');
  return new ClientRequest(a[0], a[1]);
}
function get(url, options, cb) {
  var a = normalizeRequestArgs(url, options, cb);
  validateHost(a[0].hostname, 'hostname');
  validateHost(a[0].host, 'host');
  var req = new ClientRequest(a[0], a[1]);
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
  // Node's default HTTP header byte limit; undici validates this is a number.
  maxHeaderSize: 16384,
  setMaxIdleHTTPParsers: function () {},
};
module.exports.default = module.exports;

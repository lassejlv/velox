// node:_http_common — a JS reimplementation of Node's internal HTTPParser
// (normally a C++/llhttp binding). HTTP-mocking libraries (nock via
// @mswjs/interceptors) require this module directly and drive a parser over raw
// request/response bytes via the `kOn*` callback slots. This is a faithful
// HTTP/1.1 stream parser supporting content-length and chunked bodies.

var CRLF = '\r\n';

function HTTPParser(type) {
  this.reinitialize(type == null ? HTTPParser.REQUEST : type);
}

// Parser kind.
HTTPParser.REQUEST = 0;
HTTPParser.RESPONSE = 1;
// Callback slots — libraries assign `parser[HTTPParser.kOnBody] = fn`.
HTTPParser.kOnMessageBegin = 0;
HTTPParser.kOnHeaders = 1;
HTTPParser.kOnHeadersComplete = 2;
HTTPParser.kOnBody = 3;
HTTPParser.kOnMessageComplete = 4;
HTTPParser.kOnExecute = 5;
HTTPParser.kOnTimeout = 6;

HTTPParser.prototype.reinitialize = function (type) {
  this.type = type;
  this._buf = globalThis.Buffer.alloc(0);
  this._state = 'LINE';
  this._headers = [];
  this._versionMajor = 1;
  this._versionMinor = 1;
  this._method = '';
  this._url = '';
  this._statusCode = 0;
  this._statusMessage = '';
  this._contentLength = null;
  this._chunked = false;
  this._bodyRemaining = 0;
  this._chunkState = 'SIZE';
  this._upgrade = false;
  this._shouldKeepAlive = true;
  this._beganMessage = false;
};
// Node calls it `initialize`; older callers use `reinitialize`.
HTTPParser.prototype.initialize = function (type) { this.reinitialize(type); };
HTTPParser.prototype.close = function () {};
HTTPParser.prototype.free = function () {};
HTTPParser.prototype.remove = function () {};
HTTPParser.prototype.finish = function () {};
HTTPParser.prototype.pause = function () {};
HTTPParser.prototype.resume = function () {};

function indexOfCRLF(buf, from) {
  for (var i = from; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

HTTPParser.prototype._cb = function (slot) {
  var fn = this[slot];
  if (typeof fn === 'function') {
    return fn.apply(this, Array.prototype.slice.call(arguments, 1));
  }
};

// Feed a chunk of bytes. Returns the number of bytes consumed (Node semantics)
// or an Error if the stream is malformed.
HTTPParser.prototype.execute = function (chunk) {
  if (!globalThis.Buffer.isBuffer(chunk)) chunk = globalThis.Buffer.from(chunk);
  this._buf = this._buf.length ? globalThis.Buffer.concat([this._buf, chunk]) : chunk;
  var consumed = chunk.length;

  for (;;) {
    if (this._state === 'LINE') {
      var eol = indexOfCRLF(this._buf, 0);
      if (eol === -1) break; // need more bytes
      var line = this._buf.slice(0, eol).toString('latin1');
      this._buf = this._buf.slice(eol + 2);
      if (line.length === 0) continue; // tolerate leading blank lines
      if (!this._beganMessage) { this._beganMessage = true; this._cb(HTTPParser.kOnMessageBegin); }
      if (this.type === HTTPParser.REQUEST) {
        // METHOD SP URL SP HTTP/x.y
        var parts = line.split(' ');
        this._method = parts[0] || '';
        this._url = parts[1] || '';
        this._parseVersion(parts[2] || 'HTTP/1.1');
      } else {
        // HTTP/x.y STATUS [MESSAGE]
        var sp1 = line.indexOf(' ');
        this._parseVersion(line.slice(0, sp1));
        var rest = line.slice(sp1 + 1);
        var sp2 = rest.indexOf(' ');
        if (sp2 === -1) { this._statusCode = parseInt(rest, 10) || 0; this._statusMessage = ''; }
        else { this._statusCode = parseInt(rest.slice(0, sp2), 10) || 0; this._statusMessage = rest.slice(sp2 + 1); }
      }
      this._headers = [];
      this._state = 'HEADERS';
      continue;
    }

    if (this._state === 'HEADERS') {
      var hEnd = indexOfCRLF(this._buf, 0);
      if (hEnd === -1) break;
      if (hEnd === 0) {
        // Blank line — end of headers.
        this._buf = this._buf.slice(2);
        this._finishHeaders();
        continue;
      }
      var hline = this._buf.slice(0, hEnd).toString('latin1');
      this._buf = this._buf.slice(hEnd + 2);
      var colon = hline.indexOf(':');
      if (colon !== -1) {
        var name = hline.slice(0, colon).trim();
        var value = hline.slice(colon + 1).trim();
        this._headers.push(name, value);
        var lname = name.toLowerCase();
        if (lname === 'content-length') this._contentLength = parseInt(value, 10);
        else if (lname === 'transfer-encoding' && /chunked/i.test(value)) this._chunked = true;
        else if (lname === 'connection' && /close/i.test(value)) this._shouldKeepAlive = false;
        else if (lname === 'upgrade') this._upgrade = true;
      }
      continue;
    }

    if (this._state === 'BODY_LENGTH') {
      if (this._bodyRemaining <= 0) { this._completeMessage(); continue; }
      if (this._buf.length === 0) break;
      var take = Math.min(this._bodyRemaining, this._buf.length);
      var bodyChunk = this._buf.slice(0, take);
      this._buf = this._buf.slice(take);
      this._bodyRemaining -= take;
      this._cb(HTTPParser.kOnBody, bodyChunk, 0, bodyChunk.length);
      if (this._bodyRemaining <= 0) { this._completeMessage(); }
      continue;
    }

    if (this._state === 'BODY_CHUNKED') {
      if (this._chunkState === 'SIZE') {
        var ce = indexOfCRLF(this._buf, 0);
        if (ce === -1) break;
        var sizeLine = this._buf.slice(0, ce).toString('latin1').split(';')[0].trim();
        this._buf = this._buf.slice(ce + 2);
        var size = parseInt(sizeLine, 16);
        if (isNaN(size)) return new Error('invalid chunk size');
        if (size === 0) { this._chunkState = 'TRAILER'; continue; }
        this._bodyRemaining = size;
        this._chunkState = 'DATA';
        continue;
      }
      if (this._chunkState === 'DATA') {
        if (this._bodyRemaining > 0) {
          if (this._buf.length === 0) break;
          var t = Math.min(this._bodyRemaining, this._buf.length);
          var cc = this._buf.slice(0, t);
          this._buf = this._buf.slice(t);
          this._bodyRemaining -= t;
          this._cb(HTTPParser.kOnBody, cc, 0, cc.length);
          if (this._bodyRemaining > 0) break;
        }
        // consume trailing CRLF after the chunk data
        if (this._buf.length < 2) break;
        this._buf = this._buf.slice(2);
        this._chunkState = 'SIZE';
        continue;
      }
      if (this._chunkState === 'TRAILER') {
        var te = indexOfCRLF(this._buf, 0);
        if (te === -1) break;
        this._buf = this._buf.slice(te + 2); // skip final CRLF (and any trailers)
        this._completeMessage();
        continue;
      }
    }

    if (this._state === 'DONE') break;
    break;
  }
  return consumed;
};

HTTPParser.prototype._parseVersion = function (token) {
  var m = /HTTP\/(\d)\.(\d)/i.exec(token || '');
  if (m) { this._versionMajor = +m[1]; this._versionMinor = +m[2]; }
};

HTTPParser.prototype._finishHeaders = function () {
  // Node's kOnHeadersComplete:
  // (versionMajor, versionMinor, rawHeaders, method, url, statusCode,
  //  statusMessage, upgrade, shouldKeepAlive)
  this._cb(
    HTTPParser.kOnHeadersComplete,
    this._versionMajor, this._versionMinor, this._headers,
    this._method, this._url, this._statusCode, this._statusMessage,
    this._upgrade, this._shouldKeepAlive
  );
  if (this._chunked) { this._state = 'BODY_CHUNKED'; this._chunkState = 'SIZE'; }
  else if (this._contentLength != null) {
    this._bodyRemaining = this._contentLength;
    this._state = 'BODY_LENGTH';
  } else if (this.type === HTTPParser.RESPONSE && this._statusCode !== 204 && this._statusCode !== 304 && !(this._statusCode >= 100 && this._statusCode < 200)) {
    // Response without length/chunked: body runs until close. Emit remaining
    // bytes as body; completion happens on the next blank execute or finish.
    this._state = 'BODY_LENGTH';
    this._bodyRemaining = Infinity;
  } else {
    this._completeMessage();
  }
};

HTTPParser.prototype._completeMessage = function () {
  this._cb(HTTPParser.kOnMessageComplete);
  // Ready for a possible next message on the same connection (keep-alive).
  var type = this.type;
  this.reinitialize(type);
};

// `parsers` free-list shim (Node exposes a FreeList of parsers).
var parsers = {
  alloc: function () { return new HTTPParser(); },
  free: function () {},
};

// Header-name/token validators Node exposes (best-effort RFC 7230 token check).
var tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
function checkIsHttpToken(val) { return typeof val === 'string' && tokenRegExp.test(val); }
function checkInvalidHeaderChar(val) { return /[^\t\x20-\x7e\x80-\xff]/.test(String(val)); }

module.exports = {
  HTTPParser: HTTPParser,
  parsers: parsers,
  freeParser: function () {},
  checkIsHttpToken: checkIsHttpToken,
  checkInvalidHeaderChar: checkInvalidHeaderChar,
  _checkIsHttpToken: checkIsHttpToken,
  _checkInvalidHeaderChar: checkInvalidHeaderChar,
  CRLF: CRLF,
  continueExpression: /(?:^|\W)100-continue(?:$|\W)/i,
  chunkExpression: /(?:^|\W)chunked(?:$|\W)/i,
  kIncomingMessage: Symbol('IncomingMessage'),
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH', 'CONNECT', 'TRACE'],
};
module.exports.default = module.exports;

// velox builtin: Node.js-compatible Buffer for bare JavaScriptCore.
// IIFE prelude — installs globalThis.Buffer (+ TextEncoder/TextDecoder).
// No Web/DOM APIs used: UTF-8 and base64 codecs are hand-rolled.
(function () {
  'use strict';

  // Coded errors matching Node (`.code` + `Name [CODE]`), which Buffer tests and
  // callers assert on via `assert.throws(fn, { code })`.
  function codedError(Ctor, code, message) {
    var e = new Ctor(message);
    e.code = code;
    try { Object.defineProperty(e, 'name', { value: Ctor.name + ' [' + code + ']', configurable: true, writable: true }); } catch (x) {}
    return e;
  }
  function received(actual) {
    if (actual == null) return ' Received ' + actual;
    if (typeof actual === 'object') return ' Received an instance of ' + ((actual.constructor && actual.constructor.name) || 'Object');
    var s = typeof actual === 'string' ? "'" + actual + "'" : String(actual);
    if (s.length > 28) s = s.slice(0, 25) + '...';
    return ' Received type ' + typeof actual + ' (' + s + ')';
  }
  function errInvalidArgType(name, expected, actual) {
    return codedError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "' + name + '" argument must be of type ' + expected + '.' + received(actual));
  }
  function errOutOfRange(name, range, value) {
    return codedError(RangeError, 'ERR_OUT_OF_RANGE', 'The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + value);
  }
  function errUnknownEncoding(enc) {
    return codedError(TypeError, 'ERR_UNKNOWN_ENCODING', 'Unknown encoding: ' + enc);
  }
  function errBufferOOB(name) {
    return codedError(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', name ? '"' + name + '" is outside of buffer bounds' : 'Attempt to access memory outside buffer bounds');
  }

  // ---------------------------------------------------------------------------
  // Encoding name normalization
  // ---------------------------------------------------------------------------
  function normalizeEncoding(enc) {
    if (enc === undefined || enc === null) return 'utf8';
    switch (String(enc).toLowerCase()) {
      case 'utf8':
      case 'utf-8':
        return 'utf8';
      case 'hex':
        return 'hex';
      case 'base64':
        return 'base64';
      case 'base64url':
        return 'base64url';
      case 'latin1':
      case 'binary':
        return 'latin1';
      case 'ascii':
        return 'ascii';
      case 'utf16le':
      case 'ucs2':
      case 'ucs-2':
      case 'utf-16le':
        return 'utf16le';
      default:
        return undefined;
    }
  }

  function requireEncoding(enc) {
    var n = normalizeEncoding(enc);
    if (n === undefined) {
      throw errUnknownEncoding(enc);
    }
    return n;
  }

  // ---------------------------------------------------------------------------
  // UTF-8 codec
  // ---------------------------------------------------------------------------
  function utf8ByteLength(str) {
    var len = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        len += 1;
      } else if (c < 0x800) {
        len += 2;
      } else if (c >= 0xd800 && c <= 0xdbff) {
        // high surrogate
        var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          len += 4;
          i++;
        } else {
          len += 3; // lone surrogate -> U+FFFD (3 bytes)
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        len += 3; // lone low surrogate -> U+FFFD
      } else {
        len += 3;
      }
    }
    return len;
  }

  // Encode str into target Uint8Array starting at offset, writing at most maxBytes.
  // Returns number of bytes written. Stops before splitting a multi-byte char.
  function utf8Write(str, target, offset, maxBytes) {
    var start = offset;
    var end = offset + maxBytes;
    for (var i = 0; i < str.length; i++) {
      var cp = str.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        var next = i + 1 < str.length ? str.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (next - 0xdc00);
          i++;
        } else {
          cp = 0xfffd;
        }
      } else if (cp >= 0xdc00 && cp <= 0xdfff) {
        cp = 0xfffd;
      }

      if (cp < 0x80) {
        if (offset + 1 > end) break;
        target[offset++] = cp;
      } else if (cp < 0x800) {
        if (offset + 2 > end) break;
        target[offset++] = 0xc0 | (cp >> 6);
        target[offset++] = 0x80 | (cp & 0x3f);
      } else if (cp < 0x10000) {
        if (offset + 3 > end) break;
        target[offset++] = 0xe0 | (cp >> 12);
        target[offset++] = 0x80 | ((cp >> 6) & 0x3f);
        target[offset++] = 0x80 | (cp & 0x3f);
      } else {
        if (offset + 4 > end) break;
        target[offset++] = 0xf0 | (cp >> 18);
        target[offset++] = 0x80 | ((cp >> 12) & 0x3f);
        target[offset++] = 0x80 | ((cp >> 6) & 0x3f);
        target[offset++] = 0x80 | (cp & 0x3f);
      }
    }
    return offset - start;
  }

  function utf8ToBytes(str) {
    var buf = new Uint8Array(utf8ByteLength(str));
    utf8Write(str, buf, 0, buf.length);
    return buf;
  }

  // Decode a Uint8Array slice [start,end) as UTF-8, replacing invalid sequences
  // with U+FFFD (Node/WHATWG-compatible substitution).
  function utf8Slice(bytes, start, end) {
    var res = '';
    var i = start;
    // Build code units; use array chunking to avoid huge fromCharCode.apply
    var codeUnits = [];
    function pushCp(cp) {
      if (cp > 0xffff) {
        cp -= 0x10000;
        codeUnits.push(0xd800 + (cp >> 10));
        codeUnits.push(0xdc00 + (cp & 0x3ff));
      } else {
        codeUnits.push(cp);
      }
      if (codeUnits.length >= 0x1000) {
        res += String.fromCharCode.apply(String, codeUnits);
        codeUnits.length = 0;
      }
    }

    while (i < end) {
      var b0 = bytes[i];
      if (b0 < 0x80) {
        pushCp(b0);
        i += 1;
        continue;
      }

      var extra, min, cp;
      if ((b0 & 0xe0) === 0xc0) {
        extra = 1;
        min = 0x80;
        cp = b0 & 0x1f;
      } else if ((b0 & 0xf0) === 0xe0) {
        extra = 2;
        min = 0x800;
        cp = b0 & 0x0f;
      } else if ((b0 & 0xf8) === 0xf0) {
        extra = 3;
        min = 0x10000;
        cp = b0 & 0x07;
      } else {
        // invalid lead byte
        pushCp(0xfffd);
        i += 1;
        continue;
      }

      // Validate continuation bytes
      var valid = true;
      var consumed = 1;
      for (var k = 1; k <= extra; k++) {
        if (i + k >= end) {
          valid = false;
          break;
        }
        var bk = bytes[i + k];
        if ((bk & 0xc0) !== 0x80) {
          valid = false;
          break;
        }
        cp = (cp << 6) | (bk & 0x3f);
        consumed++;
      }

      if (!valid) {
        // Emit one U+FFFD and advance by the number of bytes actually consumed
        // that were part of this (truncated/invalid) sequence's lead+valid conts.
        pushCp(0xfffd);
        i += consumed;
        continue;
      }

      // Reject overlong, out-of-range, and surrogate code points
      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        pushCp(0xfffd);
        i += consumed;
        continue;
      }

      pushCp(cp);
      i += consumed;
    }

    if (codeUnits.length) {
      res += String.fromCharCode.apply(String, codeUnits);
    }
    return res;
  }

  // ---------------------------------------------------------------------------
  // latin1 / ascii codecs
  // ---------------------------------------------------------------------------
  function latin1ToBytes(str, target, offset, maxBytes) {
    var n = Math.min(str.length, maxBytes);
    for (var i = 0; i < n; i++) {
      target[offset + i] = str.charCodeAt(i) & 0xff;
    }
    return n;
  }

  function asciiToBytes(str, target, offset, maxBytes) {
    var n = Math.min(str.length, maxBytes);
    for (var i = 0; i < n; i++) {
      target[offset + i] = str.charCodeAt(i) & 0x7f;
    }
    return n;
  }

  function latin1Slice(bytes, start, end) {
    var res = '';
    var chunk = [];
    for (var i = start; i < end; i++) {
      chunk.push(bytes[i]);
      if (chunk.length >= 0x1000) {
        res += String.fromCharCode.apply(String, chunk);
        chunk.length = 0;
      }
    }
    if (chunk.length) res += String.fromCharCode.apply(String, chunk);
    return res;
  }

  // ---------------------------------------------------------------------------
  // utf16le codec
  // ---------------------------------------------------------------------------
  function utf16leToBytes(str, target, offset, maxBytes) {
    var units = Math.floor(maxBytes / 2);
    var n = Math.min(str.length, units);
    var written = 0;
    for (var i = 0; i < n; i++) {
      var c = str.charCodeAt(i);
      target[offset + written++] = c & 0xff;
      target[offset + written++] = (c >> 8) & 0xff;
    }
    return written;
  }

  function utf16leSlice(bytes, start, end) {
    // Round down to even number of bytes
    var len = end - start;
    if (len % 2 !== 0) len -= 1;
    var res = '';
    var chunk = [];
    for (var i = 0; i < len; i += 2) {
      chunk.push(bytes[start + i] | (bytes[start + i + 1] << 8));
      if (chunk.length >= 0x1000) {
        res += String.fromCharCode.apply(String, chunk);
        chunk.length = 0;
      }
    }
    if (chunk.length) res += String.fromCharCode.apply(String, chunk);
    return res;
  }

  // ---------------------------------------------------------------------------
  // hex codec
  // ---------------------------------------------------------------------------
  var HEX_CHARS = '0123456789abcdef';

  function hexSlice(bytes, start, end) {
    var res = '';
    for (var i = start; i < end; i++) {
      var b = bytes[i];
      res += HEX_CHARS[b >> 4] + HEX_CHARS[b & 0x0f];
    }
    return res;
  }

  function hexCharVal(c) {
    if (c >= 0x30 && c <= 0x39) return c - 0x30; // 0-9
    if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10; // a-f
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10; // A-F
    return -1;
  }

  // Node stops at first invalid hex char (parses as many valid pairs as possible).
  function hexToBytes(str, target, offset, maxBytes) {
    var written = 0;
    var i = 0;
    while (written < maxBytes && i + 1 < str.length + 1) {
      if (i + 1 >= str.length) break;
      var hi = hexCharVal(str.charCodeAt(i));
      var lo = hexCharVal(str.charCodeAt(i + 1));
      if (hi === -1 || lo === -1) break;
      target[offset + written++] = (hi << 4) | lo;
      i += 2;
    }
    return written;
  }

  function hexByteLength(str) {
    // Number of full valid hex pairs from the start.
    var count = 0;
    var i = 0;
    while (i + 1 < str.length + 1) {
      if (i + 1 >= str.length) break;
      if (hexCharVal(str.charCodeAt(i)) === -1 || hexCharVal(str.charCodeAt(i + 1)) === -1) break;
      count++;
      i += 2;
    }
    return count;
  }

  // ---------------------------------------------------------------------------
  // base64 / base64url codec
  // ---------------------------------------------------------------------------
  var B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  // Reverse lookup: accept both std and url alphabets for decode.
  var B64_DECODE = (function () {
    var t = new Int16Array(256);
    for (var i = 0; i < 256; i++) t[i] = -1;
    for (var j = 0; j < B64_STD.length; j++) t[B64_STD.charCodeAt(j)] = j;
    // url chars
    t['-'.charCodeAt(0)] = 62;
    t['_'.charCodeAt(0)] = 63;
    return t;
  })();

  function base64Slice(bytes, start, end, url) {
    var alpha = url ? B64_URL : B64_STD;
    var res = '';
    var len = end - start;
    var i = start;
    var fullGroups = Math.floor(len / 3);
    for (var g = 0; g < fullGroups; g++) {
      var n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      i += 3;
      res +=
        alpha[(n >> 18) & 0x3f] +
        alpha[(n >> 12) & 0x3f] +
        alpha[(n >> 6) & 0x3f] +
        alpha[n & 0x3f];
    }
    var rem = end - i;
    if (rem === 1) {
      var n1 = bytes[i] << 16;
      res += alpha[(n1 >> 18) & 0x3f] + alpha[(n1 >> 12) & 0x3f];
      if (!url) res += '==';
    } else if (rem === 2) {
      var n2 = (bytes[i] << 16) | (bytes[i + 1] << 8);
      res += alpha[(n2 >> 18) & 0x3f] + alpha[(n2 >> 12) & 0x3f] + alpha[(n2 >> 6) & 0x3f];
      if (!url) res += '=';
    }
    return res;
  }

  // Decode base64/base64url. Ignores whitespace, tolerates missing padding,
  // stops at '=' or first invalid char (Node-like tolerant behavior).
  function base64ToBytes(str, target, offset, maxBytes) {
    var written = 0;
    var acc = 0;
    var accBits = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c === 0x3d) break; // '='
      // skip whitespace: space, tab, lf, cr, vtab, ff
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) {
        continue;
      }
      var v = B64_DECODE[c];
      if (v === -1) break; // stop at invalid char (Node tolerant)
      acc = (acc << 6) | v;
      accBits += 6;
      if (accBits >= 8) {
        accBits -= 8;
        if (written >= maxBytes) break;
        target[offset + written++] = (acc >> accBits) & 0xff;
      }
    }
    return written;
  }

  function base64ByteLength(str) {
    // Count valid base64 chars (excluding whitespace and stopping at '=' / invalid)
    var validChars = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c === 0x3d) break;
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0b || c === 0x0c) {
        continue;
      }
      if (B64_DECODE[c] === -1) break;
      validChars++;
    }
    return Math.floor((validChars * 6) / 8);
  }

  // ---------------------------------------------------------------------------
  // String -> byte length by encoding
  // ---------------------------------------------------------------------------
  function byteLengthForEncoding(str, enc) {
    switch (enc) {
      case 'utf8':
        return utf8ByteLength(str);
      case 'ascii':
      case 'latin1':
        return str.length;
      case 'utf16le':
        return str.length * 2;
      case 'hex':
        return hexByteLength(str);
      case 'base64':
      case 'base64url':
        return base64ByteLength(str);
      default:
        return utf8ByteLength(str);
    }
  }

  // Write string into target by encoding; returns bytes written.
  function writeString(str, enc, target, offset, maxBytes) {
    switch (enc) {
      case 'utf8':
        return utf8Write(str, target, offset, maxBytes);
      case 'ascii':
        return asciiToBytes(str, target, offset, maxBytes);
      case 'latin1':
        return latin1ToBytes(str, target, offset, maxBytes);
      case 'utf16le':
        return utf16leToBytes(str, target, offset, maxBytes);
      case 'hex':
        return hexToBytes(str, target, offset, maxBytes);
      case 'base64':
      case 'base64url':
        return base64ToBytes(str, target, offset, maxBytes);
      default:
        return utf8Write(str, target, offset, maxBytes);
    }
  }

  function decodeSlice(bytes, enc, start, end) {
    switch (enc) {
      case 'utf8':
        return utf8Slice(bytes, start, end);
      case 'ascii':
        // Node masks to 7 bits for ascii output
        return latin1Slice7(bytes, start, end);
      case 'latin1':
        return latin1Slice(bytes, start, end);
      case 'utf16le':
        return utf16leSlice(bytes, start, end);
      case 'hex':
        return hexSlice(bytes, start, end);
      case 'base64':
        return base64Slice(bytes, start, end, false);
      case 'base64url':
        return base64Slice(bytes, start, end, true);
      default:
        return utf8Slice(bytes, start, end);
    }
  }

  function latin1Slice7(bytes, start, end) {
    var res = '';
    var chunk = [];
    for (var i = start; i < end; i++) {
      chunk.push(bytes[i] & 0x7f);
      if (chunk.length >= 0x1000) {
        res += String.fromCharCode.apply(String, chunk);
        chunk.length = 0;
      }
    }
    if (chunk.length) res += String.fromCharCode.apply(String, chunk);
    return res;
  }

  // Produce a fresh Uint8Array of bytes from a string + encoding.
  function stringToBytes(str, enc) {
    var len = byteLengthForEncoding(str, enc);
    var out = new Uint8Array(len);
    var written = writeString(str, enc, out, 0, len);
    if (written === len) return out;
    return out.subarray(0, written);
  }

  // ---------------------------------------------------------------------------
  // Buffer class
  // ---------------------------------------------------------------------------
  class Buffer extends Uint8Array {
    // Construct directly via Uint8Array constructor semantics.
    // Note: prefer Buffer.from / Buffer.alloc per Node.

    // -------- Statics --------
    static from(value, encOrOffset, length) {
      if (typeof value === 'string') {
        var enc = requireEncoding(encOrOffset);
        var bytes = stringToBytes(value, enc);
        // Reinterpret as Buffer sharing the freshly-allocated buffer
        return fromUint8(bytes);
      }

      if (value instanceof ArrayBuffer) {
        var byteOffset = encOrOffset === undefined ? 0 : Number(encOrOffset);
        var len =
          length === undefined ? value.byteLength - byteOffset : Number(length);
        var view = new Buffer(value, byteOffset, len);
        return view;
      }

      // SharedArrayBuffer-like (has byteLength but not ArrayBuffer): treat similarly
      if (
        value &&
        typeof value === 'object' &&
        typeof value.byteLength === 'number' &&
        !ArrayBuffer.isView(value) &&
        Object.prototype.toString.call(value) === '[object SharedArrayBuffer]'
      ) {
        var off2 = encOrOffset === undefined ? 0 : Number(encOrOffset);
        var len2 = length === undefined ? value.byteLength - off2 : Number(length);
        return new Buffer(value, off2, len2);
      }

      if (ArrayBuffer.isView(value)) {
        // Uint8Array / Buffer / other typed array -> copy bytes
        if (value instanceof Uint8Array) {
          var copy = new Buffer(value.length);
          copy.set(value);
          return copy;
        }
        // Other typed arrays: Node copies element values (numbers) into bytes.
        var arrLen = value.length;
        var b = new Buffer(arrLen);
        for (var i = 0; i < arrLen; i++) b[i] = value[i] & 0xff;
        return b;
      }

      if (Array.isArray(value) || (value && typeof value.length === 'number')) {
        var n = value.length >>> 0;
        var out = new Buffer(n);
        for (var j = 0; j < n; j++) {
          out[j] = value[j] & 0xff;
        }
        return out;
      }

      // Object with valueOf / Symbol.toPrimitive returning string?
      if (value && typeof value === 'object') {
        if (typeof value.valueOf === 'function' && value.valueOf() !== value) {
          var v = value.valueOf();
          if (v !== value) return Buffer.from(v, encOrOffset, length);
        }
        if (typeof value[Symbol.toPrimitive] === 'function') {
          var p = value[Symbol.toPrimitive]('string');
          if (typeof p === 'string') return Buffer.from(p, encOrOffset, length);
        }
      }

      throw new TypeError(
        'The first argument must be of type string or an instance of Buffer, ArrayBuffer, Array, or Array-like Object.'
      );
    }

    static alloc(size, fill, enc) {
      size = checkSize(size);
      var buf = new Buffer(size); // zero-filled by spec
      if (fill !== undefined && fill !== 0) {
        buf.fill(fill, 0, size, enc);
      }
      return buf;
    }

    static allocUnsafe(size) {
      size = checkSize(size);
      return new Buffer(size);
    }

    static allocUnsafeSlow(size) {
      size = checkSize(size);
      return new Buffer(size);
    }

    static isBuffer(o) {
      return o instanceof Buffer;
    }

    static isEncoding(enc) {
      if (typeof enc !== 'string') return false;
      return normalizeEncoding(enc) !== undefined;
    }

    static byteLength(string, enc) {
      if (typeof string !== 'string') {
        if (ArrayBuffer.isView(string)) return string.byteLength;
        if (string instanceof ArrayBuffer) return string.byteLength;
        throw new TypeError(
          'The "string" argument must be of type string or an instance of Buffer or ArrayBuffer.'
        );
      }
      return byteLengthForEncoding(string, requireEncoding(enc));
    }

    static concat(list, totalLength) {
      if (!Array.isArray(list)) {
        throw new TypeError('The "list" argument must be an instance of Array.');
      }
      if (list.length === 0) return Buffer.alloc(0);

      var computed = 0;
      if (totalLength === undefined) {
        for (var i = 0; i < list.length; i++) {
          computed += list[i].length;
        }
        totalLength = computed;
      } else {
        totalLength = checkSize(totalLength);
      }

      var result = new Buffer(totalLength);
      var pos = 0;
      for (var k = 0; k < list.length; k++) {
        var buf = list[k];
        if (!(buf instanceof Uint8Array)) {
          throw new TypeError(
            'The "list[' + k + ']" argument must be an instance of Buffer or Uint8Array.'
          );
        }
        if (pos + buf.length > totalLength) {
          result.set(buf.subarray(0, totalLength - pos), pos);
          pos = totalLength;
          break;
        }
        result.set(buf, pos);
        pos += buf.length;
      }
      return result;
    }

    static compare(a, b) {
      if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array)) {
        throw new TypeError(
          'The "buf1", "buf2" arguments must be one of type Buffer or Uint8Array.'
        );
      }
      return compareBytes(a, 0, a.length, b, 0, b.length);
    }

    // -------- Instance methods --------
    toString(enc, start, end) {
      enc = requireEncoding(enc);
      var len = this.length;
      if (start === undefined || start < 0) start = 0;
      else start = start | 0;
      if (start > len) start = len;
      if (end === undefined || end > len) end = len;
      else end = end | 0;
      if (end < 0) end = 0;
      if (end <= start) return '';
      return decodeSlice(this, enc, start, end);
    }

    toJSON() {
      var data = new Array(this.length);
      for (var i = 0; i < this.length; i++) data[i] = this[i];
      return { type: 'Buffer', data: data };
    }

    write(string, offset, length, enc) {
      // Argument shuffling per Node:
      // write(string)
      // write(string, encoding)
      // write(string, offset[, length][, encoding])
      if (offset === undefined) {
        offset = 0;
        length = this.length;
        enc = 'utf8';
      } else if (typeof offset === 'string') {
        enc = offset;
        offset = 0;
        length = this.length;
      } else {
        offset = offset >>> 0;
        if (length === undefined) {
          length = this.length - offset;
          enc = 'utf8';
        } else if (typeof length === 'string') {
          enc = length;
          length = this.length - offset;
        } else {
          length = length >>> 0;
          var remaining = this.length - offset;
          if (length > remaining) length = remaining;
          if (enc === undefined) enc = 'utf8';
        }
      }
      enc = requireEncoding(enc);
      if (offset > this.length) return 0;
      var maxBytes = Math.min(length, this.length - offset);
      if (maxBytes < 0) maxBytes = 0;
      return writeString(string, enc, this, offset, maxBytes);
    }

    fill(value, start, end, enc) {
      // fill(value[, offset[, end]][, encoding])
      if (typeof start === 'string') {
        enc = start;
        start = 0;
        end = this.length;
      } else if (typeof end === 'string') {
        enc = end;
        end = this.length;
      }
      if (start === undefined) start = 0;
      if (end === undefined) end = this.length;
      start = start | 0;
      end = end | 0;
      if (start < 0) start = 0;
      if (end > this.length) end = this.length;
      if (start >= end) return this;

      if (typeof value === 'number') {
        var v = value & 0xff;
        for (var i = start; i < end; i++) this[i] = v;
        return this;
      }

      if (typeof value === 'string') {
        enc = requireEncoding(enc);
        var bytes = stringToBytes(value, enc);
        if (bytes.length === 0) {
          // Node fills with 0 when string yields no bytes
          for (var z = start; z < end; z++) this[z] = 0;
          return this;
        }
        for (var j = start; j < end; j++) {
          this[j] = bytes[(j - start) % bytes.length];
        }
        return this;
      }

      if (value instanceof Uint8Array) {
        if (value.length === 0) {
          throw new TypeError('The "value" argument is invalid.');
        }
        for (var k = start; k < end; k++) {
          this[k] = value[(k - start) % value.length];
        }
        return this;
      }

      // Fallback: coerce to number
      var nv = Number(value) & 0xff;
      for (var m = start; m < end; m++) this[m] = nv;
      return this;
    }

    // Node's slice shares memory (like subarray).
    slice(start, end) {
      var len = this.length;
      if (start === undefined) start = 0;
      else {
        start = start | 0;
        if (start < 0) {
          start += len;
          if (start < 0) start = 0;
        } else if (start > len) start = len;
      }
      if (end === undefined) end = len;
      else {
        end = end | 0;
        if (end < 0) {
          end += len;
          if (end < 0) end = 0;
        } else if (end > len) end = len;
      }
      if (end < start) end = start;
      return new Buffer(this.buffer, this.byteOffset + start, end - start);
    }

    subarray(start, end) {
      return this.slice(start, end);
    }

    copy(target, targetStart, sourceStart, sourceEnd) {
      if (!(target instanceof Uint8Array)) {
        throw new TypeError(
          'The "target" argument must be an instance of Buffer or Uint8Array.'
        );
      }
      targetStart = targetStart === undefined ? 0 : targetStart | 0;
      sourceStart = sourceStart === undefined ? 0 : sourceStart | 0;
      sourceEnd = sourceEnd === undefined ? this.length : sourceEnd | 0;

      if (targetStart < 0) throw new RangeError('targetStart out of bounds');
      if (sourceStart < 0) throw new RangeError('sourceStart out of bounds');
      if (sourceStart > this.length) sourceStart = this.length;
      if (sourceEnd > this.length) sourceEnd = this.length;
      if (targetStart >= target.length || sourceStart >= sourceEnd) return 0;

      var len = sourceEnd - sourceStart;
      var available = target.length - targetStart;
      if (len > available) len = available;

      // Use subarray + set (handles overlap correctly via set's internal copy
      // when target and source share buffer? set does NOT guarantee overlap;
      // use Uint8Array.prototype.copyWithin-safe manual copy when overlapping).
      var src = this.subarray(sourceStart, sourceStart + len);
      if (target.buffer === this.buffer) {
        // Possible overlap; copy via temporary to be safe.
        target.set(new Uint8Array(src), targetStart);
      } else {
        target.set(src, targetStart);
      }
      return len;
    }

    equals(other) {
      if (!(other instanceof Uint8Array)) {
        throw new TypeError(
          'The "otherBuffer" argument must be an instance of Buffer or Uint8Array.'
        );
      }
      if (this === other) return true;
      if (this.length !== other.length) return false;
      for (var i = 0; i < this.length; i++) {
        if (this[i] !== other[i]) return false;
      }
      return true;
    }

    compare(target, targetStart, targetEnd, sourceStart, sourceEnd) {
      if (!(target instanceof Uint8Array)) {
        throw new TypeError(
          'The "target" argument must be an instance of Buffer or Uint8Array.'
        );
      }
      targetStart = targetStart === undefined ? 0 : targetStart | 0;
      targetEnd = targetEnd === undefined ? target.length : targetEnd | 0;
      sourceStart = sourceStart === undefined ? 0 : sourceStart | 0;
      sourceEnd = sourceEnd === undefined ? this.length : sourceEnd | 0;
      return compareBytes(this, sourceStart, sourceEnd, target, targetStart, targetEnd);
    }

    indexOf(value, byteOffset, enc) {
      return bidirectionalIndexOf(this, value, byteOffset, enc, true);
    }

    lastIndexOf(value, byteOffset, enc) {
      return bidirectionalIndexOf(this, value, byteOffset, enc, false);
    }

    includes(value, byteOffset, enc) {
      return this.indexOf(value, byteOffset, enc) !== -1;
    }

    // -------- swap --------
    swap16() {
      if (this.length % 2 !== 0) {
        throw new RangeError('Buffer size must be a multiple of 16-bits');
      }
      for (var i = 0; i < this.length; i += 2) {
        var a = this[i];
        this[i] = this[i + 1];
        this[i + 1] = a;
      }
      return this;
    }

    swap32() {
      if (this.length % 4 !== 0) {
        throw new RangeError('Buffer size must be a multiple of 32-bits');
      }
      for (var i = 0; i < this.length; i += 4) {
        var a = this[i];
        var b = this[i + 1];
        this[i] = this[i + 3];
        this[i + 1] = this[i + 2];
        this[i + 2] = b;
        this[i + 3] = a;
      }
      return this;
    }

    swap64() {
      if (this.length % 8 !== 0) {
        throw new RangeError('Buffer size must be a multiple of 64-bits');
      }
      for (var i = 0; i < this.length; i += 8) {
        for (var j = 0; j < 4; j++) {
          var tmp = this[i + j];
          this[i + j] = this[i + 7 - j];
          this[i + 7 - j] = tmp;
        }
      }
      return this;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers used by statics/methods
  // ---------------------------------------------------------------------------
  function fromUint8(u8) {
    // Wrap an existing Uint8Array's bytes as a Buffer without re-copy when it
    // already exactly covers its backing buffer; else copy region into a Buffer.
    var b = new Buffer(u8.length);
    b.set(u8);
    return b;
  }

  function checkSize(size) {
    if (typeof size !== 'number') {
      throw errInvalidArgType('size', 'number', size);
    }
    if (!Number.isInteger(size) || size < 0) {
      if (Number.isNaN(size)) throw errOutOfRange('size', 'a non-negative integer', size);
      else if (size < 0) throw errOutOfRange('size', '>= 0 and <= 2 ** 32 - 1', size);
      else size = Math.floor(size);
    }
    return size;
  }

  function compareBytes(a, aStart, aEnd, b, bStart, bEnd) {
    var aLen = aEnd - aStart;
    var bLen = bEnd - bStart;
    var len = Math.min(aLen, bLen);
    for (var i = 0; i < len; i++) {
      var av = a[aStart + i];
      var bv = b[bStart + i];
      if (av !== bv) return av < bv ? -1 : 1;
    }
    if (aLen < bLen) return -1;
    if (aLen > bLen) return 1;
    return 0;
  }

  function bidirectionalIndexOf(buf, value, byteOffset, enc, forward) {
    var len = buf.length;
    // Encoding argument shuffling
    if (typeof byteOffset === 'string') {
      enc = byteOffset;
      byteOffset = undefined;
    }
    if (byteOffset === undefined) {
      byteOffset = forward ? 0 : len - 1;
    } else {
      byteOffset = +byteOffset;
      if (Number.isNaN(byteOffset)) byteOffset = forward ? 0 : len - 1;
    }
    byteOffset = byteOffset | 0;
    if (byteOffset < 0) byteOffset += len;

    // Build needle bytes
    var needle;
    if (typeof value === 'number') {
      var n = value & 0xff;
      if (forward) {
        if (byteOffset < 0) byteOffset = 0;
        for (var i = byteOffset; i < len; i++) {
          if (buf[i] === n) return i;
        }
      } else {
        if (byteOffset >= len) byteOffset = len - 1;
        for (var j = byteOffset; j >= 0; j--) {
          if (buf[j] === n) return j;
        }
      }
      return -1;
    } else if (typeof value === 'string') {
      needle = stringToBytes(value, requireEncoding(enc));
    } else if (value instanceof Uint8Array) {
      needle = value;
    } else {
      throw new TypeError(
        'The "value" argument must be one of type number, string, Buffer, or Uint8Array.'
      );
    }

    if (needle.length === 0) {
      // Node: empty needle returns clamped offset (or length)
      if (forward) {
        if (byteOffset > len) return len;
        if (byteOffset < 0) return 0;
        return byteOffset;
      } else {
        if (byteOffset > len) return len;
        if (byteOffset < 0) return -1;
        return byteOffset;
      }
    }

    if (forward) {
      if (byteOffset < 0) byteOffset = 0;
      var last = len - needle.length;
      for (var s = byteOffset; s <= last; s++) {
        var match = true;
        for (var k = 0; k < needle.length; k++) {
          if (buf[s + k] !== needle[k]) {
            match = false;
            break;
          }
        }
        if (match) return s;
      }
      return -1;
    } else {
      var startPos = byteOffset;
      if (startPos > len - needle.length) startPos = len - needle.length;
      for (var t = startPos; t >= 0; t--) {
        var m2 = true;
        for (var q = 0; q < needle.length; q++) {
          if (buf[t + q] !== needle[q]) {
            m2 = false;
            break;
          }
        }
        if (m2) return t;
      }
      return -1;
    }
  }

  // ---------------------------------------------------------------------------
  // Numeric read/write methods via DataView
  // ---------------------------------------------------------------------------
  function getDV(buf) {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  function defineNum(name, byteCount, reader) {
    Buffer.prototype[name] = function (offset, noAssert) {
      offset = offset >>> 0;
      if (offset + byteCount > this.length) {
        throw new RangeError(
          'The value of "offset" is out of range. Attempt to access memory outside buffer bounds.'
        );
      }
      return reader(getDV(this), offset);
    };
  }

  function defineWrite(name, byteCount, writer) {
    Buffer.prototype[name] = function (value, offset, noAssert) {
      offset = offset >>> 0;
      if (offset + byteCount > this.length) {
        throw new RangeError(
          'The value of "offset" is out of range. Attempt to access memory outside buffer bounds.'
        );
      }
      writer(getDV(this), offset, value);
      return offset + byteCount;
    };
  }

  // Unsigned
  defineNum('readUInt8', 1, function (dv, o) { return dv.getUint8(o); });
  defineNum('readUInt16LE', 2, function (dv, o) { return dv.getUint16(o, true); });
  defineNum('readUInt16BE', 2, function (dv, o) { return dv.getUint16(o, false); });
  defineNum('readUInt32LE', 4, function (dv, o) { return dv.getUint32(o, true); });
  defineNum('readUInt32BE', 4, function (dv, o) { return dv.getUint32(o, false); });
  // Signed
  defineNum('readInt8', 1, function (dv, o) { return dv.getInt8(o); });
  defineNum('readInt16LE', 2, function (dv, o) { return dv.getInt16(o, true); });
  defineNum('readInt16BE', 2, function (dv, o) { return dv.getInt16(o, false); });
  defineNum('readInt32LE', 4, function (dv, o) { return dv.getInt32(o, true); });
  defineNum('readInt32BE', 4, function (dv, o) { return dv.getInt32(o, false); });
  // Float / Double
  defineNum('readFloatLE', 4, function (dv, o) { return dv.getFloat32(o, true); });
  defineNum('readFloatBE', 4, function (dv, o) { return dv.getFloat32(o, false); });
  defineNum('readDoubleLE', 8, function (dv, o) { return dv.getFloat64(o, true); });
  defineNum('readDoubleBE', 8, function (dv, o) { return dv.getFloat64(o, false); });
  // BigInt 64
  defineNum('readBigUInt64LE', 8, function (dv, o) { return dv.getBigUint64(o, true); });
  defineNum('readBigUInt64BE', 8, function (dv, o) { return dv.getBigUint64(o, false); });
  defineNum('readBigInt64LE', 8, function (dv, o) { return dv.getBigInt64(o, true); });
  defineNum('readBigInt64BE', 8, function (dv, o) { return dv.getBigInt64(o, false); });

  defineWrite('writeUInt8', 1, function (dv, o, v) { dv.setUint8(o, v & 0xff); });
  defineWrite('writeUInt16LE', 2, function (dv, o, v) { dv.setUint16(o, v & 0xffff, true); });
  defineWrite('writeUInt16BE', 2, function (dv, o, v) { dv.setUint16(o, v & 0xffff, false); });
  defineWrite('writeUInt32LE', 4, function (dv, o, v) { dv.setUint32(o, v >>> 0, true); });
  defineWrite('writeUInt32BE', 4, function (dv, o, v) { dv.setUint32(o, v >>> 0, false); });
  defineWrite('writeInt8', 1, function (dv, o, v) { dv.setInt8(o, v); });
  defineWrite('writeInt16LE', 2, function (dv, o, v) { dv.setInt16(o, v, true); });
  defineWrite('writeInt16BE', 2, function (dv, o, v) { dv.setInt16(o, v, false); });
  defineWrite('writeInt32LE', 4, function (dv, o, v) { dv.setInt32(o, v, true); });
  defineWrite('writeInt32BE', 4, function (dv, o, v) { dv.setInt32(o, v, false); });
  defineWrite('writeFloatLE', 4, function (dv, o, v) { dv.setFloat32(o, v, true); });
  defineWrite('writeFloatBE', 4, function (dv, o, v) { dv.setFloat32(o, v, false); });
  defineWrite('writeDoubleLE', 8, function (dv, o, v) { dv.setFloat64(o, v, true); });
  defineWrite('writeDoubleBE', 8, function (dv, o, v) { dv.setFloat64(o, v, false); });
  defineWrite('writeBigUInt64LE', 8, function (dv, o, v) { dv.setBigUint64(o, BigInt(v), true); });
  defineWrite('writeBigUInt64BE', 8, function (dv, o, v) { dv.setBigUint64(o, BigInt(v), false); });
  defineWrite('writeBigInt64LE', 8, function (dv, o, v) { dv.setBigInt64(o, BigInt(v), true); });
  defineWrite('writeBigInt64BE', 8, function (dv, o, v) { dv.setBigInt64(o, BigInt(v), false); });

  // Aliases (Node has these as alternate names)
  Buffer.prototype.readUintLE = null; // placeholder before var-length defs

  // Variable-length read/write (1..6 bytes)
  Buffer.prototype.readUIntLE = function (offset, byteLength) {
    offset = offset >>> 0;
    byteLength = byteLength >>> 0;
    checkVarLen(byteLength);
    boundsCheck(this, offset, byteLength);
    var val = 0;
    var mul = 1;
    for (var i = 0; i < byteLength; i++) {
      val += this[offset + i] * mul;
      mul *= 0x100;
    }
    return val;
  };

  Buffer.prototype.readUIntBE = function (offset, byteLength) {
    offset = offset >>> 0;
    byteLength = byteLength >>> 0;
    checkVarLen(byteLength);
    boundsCheck(this, offset, byteLength);
    var val = 0;
    for (var i = 0; i < byteLength; i++) {
      val = val * 0x100 + this[offset + i];
    }
    return val;
  };

  Buffer.prototype.readIntLE = function (offset, byteLength) {
    var val = this.readUIntLE(offset, byteLength);
    var max = Math.pow(2, 8 * byteLength);
    if (val >= max / 2) val -= max;
    return val;
  };

  Buffer.prototype.readIntBE = function (offset, byteLength) {
    var val = this.readUIntBE(offset, byteLength);
    var max = Math.pow(2, 8 * byteLength);
    if (val >= max / 2) val -= max;
    return val;
  };

  Buffer.prototype.writeUIntLE = function (value, offset, byteLength) {
    offset = offset >>> 0;
    byteLength = byteLength >>> 0;
    checkVarLen(byteLength);
    boundsCheck(this, offset, byteLength);
    var v = Math.floor(value);
    for (var i = 0; i < byteLength; i++) {
      this[offset + i] = v & 0xff;
      v = Math.floor(v / 0x100);
    }
    return offset + byteLength;
  };

  Buffer.prototype.writeUIntBE = function (value, offset, byteLength) {
    offset = offset >>> 0;
    byteLength = byteLength >>> 0;
    checkVarLen(byteLength);
    boundsCheck(this, offset, byteLength);
    var v = Math.floor(value);
    for (var i = byteLength - 1; i >= 0; i--) {
      this[offset + i] = v & 0xff;
      v = Math.floor(v / 0x100);
    }
    return offset + byteLength;
  };

  Buffer.prototype.writeIntLE = function (value, offset, byteLength) {
    var v = Math.floor(value);
    if (v < 0) v += Math.pow(2, 8 * byteLength);
    return this.writeUIntLE(v, offset, byteLength);
  };

  Buffer.prototype.writeIntBE = function (value, offset, byteLength) {
    var v = Math.floor(value);
    if (v < 0) v += Math.pow(2, 8 * byteLength);
    return this.writeUIntBE(v, offset, byteLength);
  };

  // Node lowercase aliases
  Buffer.prototype.readUintLE = Buffer.prototype.readUIntLE;
  Buffer.prototype.readUintBE = Buffer.prototype.readUIntBE;
  Buffer.prototype.writeUintLE = Buffer.prototype.writeUIntLE;
  Buffer.prototype.writeUintBE = Buffer.prototype.writeUIntBE;
  Buffer.prototype.readUint8 = Buffer.prototype.readUInt8;
  Buffer.prototype.readUint16LE = Buffer.prototype.readUInt16LE;
  Buffer.prototype.readUint16BE = Buffer.prototype.readUInt16BE;
  Buffer.prototype.readUint32LE = Buffer.prototype.readUInt32LE;
  Buffer.prototype.readUint32BE = Buffer.prototype.readUInt32BE;
  Buffer.prototype.writeUint8 = Buffer.prototype.writeUInt8;
  Buffer.prototype.writeUint16LE = Buffer.prototype.writeUInt16LE;
  Buffer.prototype.writeUint16BE = Buffer.prototype.writeUInt16BE;
  Buffer.prototype.writeUint32LE = Buffer.prototype.writeUInt32LE;
  Buffer.prototype.writeUint32BE = Buffer.prototype.writeUInt32BE;
  Buffer.prototype.readBigUint64LE = Buffer.prototype.readBigUInt64LE;
  Buffer.prototype.readBigUint64BE = Buffer.prototype.readBigUInt64BE;
  Buffer.prototype.writeBigUint64LE = Buffer.prototype.writeBigUInt64LE;
  Buffer.prototype.writeBigUint64BE = Buffer.prototype.writeBigUInt64BE;

  function checkVarLen(byteLength) {
    if (byteLength < 1 || byteLength > 6) {
      throw new RangeError(
        'The value of "byteLength" is out of range. It must be >= 1 and <= 6.'
      );
    }
  }

  function boundsCheck(buf, offset, byteLength) {
    if (offset + byteLength > buf.length) {
      throw new RangeError(
        'The value of "offset" is out of range. Attempt to access memory outside buffer bounds.'
      );
    }
  }

  Buffer.poolSize = 8192;

  // ---------------------------------------------------------------------------
  // TextEncoder / TextDecoder (hand-rolled, UTF-8 only)
  // ---------------------------------------------------------------------------
  class VTextEncoder {
    get encoding() {
      return 'utf-8';
    }
    encode(input) {
      if (input === undefined) input = '';
      return utf8ToBytes(String(input));
    }
    encodeInto(source, dest) {
      source = String(source);
      var written = utf8Write(source, dest, 0, dest.length);
      // Compute how many chars were read corresponding to written bytes.
      // Simple approach: re-scan.
      var read = 0;
      var bytes = 0;
      for (var i = 0; i < source.length; i++) {
        var cp = source.charCodeAt(i);
        var size;
        if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < source.length) {
          var nx = source.charCodeAt(i + 1);
          if (nx >= 0xdc00 && nx <= 0xdfff) {
            size = 4;
          } else {
            size = 3;
          }
        } else if (cp < 0x80) size = 1;
        else if (cp < 0x800) size = 2;
        else size = 3;
        if (bytes + size > written) break;
        bytes += size;
        read += size === 4 ? 2 : 1;
        if (size === 4) i++;
      }
      return { read: read, written: written };
    }
  }

  // Map a WHATWG encoding label to (canonical name, Buffer codec). UTF-8 keeps
  // the hand-rolled fast path; others go through the Buffer codecs.
  function normalizeDecoderLabel(label) {
    var enc = label === undefined ? 'utf-8' : String(label).toLowerCase().trim();
    switch (enc) {
      case 'utf-8': case 'utf8': case 'unicode-1-1-utf-8':
        return { name: 'utf-8', codec: null };
      case 'latin1': case 'iso-8859-1': case 'iso8859-1': case 'l1':
      case 'binary': case 'csisolatin1': case 'cp1252': case 'windows-1252':
        return { name: 'windows-1252', codec: 'latin1' };
      case 'ascii': case 'us-ascii': case 'cp367': case '646':
        return { name: 'windows-1252', codec: 'latin1' };
      case 'utf-16le': case 'utf16le': case 'ucs-2': case 'ucs2': case 'unicode':
        return { name: 'utf-16le', codec: 'utf16le' };
      default:
        return null;
    }
  }

  class VTextDecoder {
    constructor(label, options) {
      var resolved = normalizeDecoderLabel(label);
      if (!resolved) {
        throw new RangeError('The encoding label provided is not supported: ' + label);
      }
      this._encoding = resolved.name;
      this._codec = resolved.codec;
      this._fatal = !!(options && options.fatal);
      this._ignoreBOM = !!(options && options.ignoreBOM);
    }
    get encoding() {
      return this._encoding;
    }
    get fatal() {
      return this._fatal;
    }
    get ignoreBOM() {
      return this._ignoreBOM;
    }
    decode(input) {
      if (input === undefined) return '';
      var bytes;
      if (input instanceof Uint8Array) {
        bytes = input;
      } else if (ArrayBuffer.isView(input)) {
        bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      } else if (input instanceof ArrayBuffer) {
        bytes = new Uint8Array(input);
      } else {
        throw new TypeError('The provided value is not of type ArrayBuffer or ArrayBufferView.');
      }
      // Non-UTF-8 encodings: route through the Buffer codecs.
      if (this._codec) {
        return Buffer.from(bytes).toString(this._codec);
      }
      var start = 0;
      if (!this._ignoreBOM && bytes.length >= 3 &&
          bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        start = 3;
      }
      if (this._fatal) {
        // Strict decode: throw on invalid sequences.
        return utf8DecodeStrict(bytes, start, bytes.length);
      }
      return utf8Slice(bytes, start, bytes.length);
    }
  }

  function utf8DecodeStrict(bytes, start, end) {
    // Like utf8Slice but throws on any invalid sequence.
    var marker = {};
    var res = utf8SliceValidating(bytes, start, end, marker);
    if (res === marker) {
      throw new TypeError('The encoded data was not valid for encoding utf-8.');
    }
    return res;
  }

  function utf8SliceValidating(bytes, start, end, marker) {
    var codeUnits = [];
    var res = '';
    var i = start;
    function push(cp) {
      if (cp > 0xffff) {
        cp -= 0x10000;
        codeUnits.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      } else codeUnits.push(cp);
      if (codeUnits.length >= 0x1000) {
        res += String.fromCharCode.apply(String, codeUnits);
        codeUnits.length = 0;
      }
    }
    while (i < end) {
      var b0 = bytes[i];
      if (b0 < 0x80) { push(b0); i++; continue; }
      var extra, min, cp;
      if ((b0 & 0xe0) === 0xc0) { extra = 1; min = 0x80; cp = b0 & 0x1f; }
      else if ((b0 & 0xf0) === 0xe0) { extra = 2; min = 0x800; cp = b0 & 0x0f; }
      else if ((b0 & 0xf8) === 0xf0) { extra = 3; min = 0x10000; cp = b0 & 0x07; }
      else return marker;
      for (var k = 1; k <= extra; k++) {
        if (i + k >= end) return marker;
        var bk = bytes[i + k];
        if ((bk & 0xc0) !== 0x80) return marker;
        cp = (cp << 6) | (bk & 0x3f);
      }
      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return marker;
      push(cp);
      i += extra + 1;
    }
    if (codeUnits.length) res += String.fromCharCode.apply(String, codeUnits);
    return res;
  }

  // ---------------------------------------------------------------------------
  // Install globals
  // ---------------------------------------------------------------------------
  globalThis.Buffer = Buffer;
  if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = VTextEncoder;
  }
  if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = VTextDecoder;
  }
})();

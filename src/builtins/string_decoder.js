// node:string_decoder — incremental, encoding-aware Buffer → string decoding.
//
// The key feature: multi-byte UTF-8 (and UTF-16LE) sequences may be split
// across chunk boundaries. The decoder buffers the incomplete trailing bytes
// and emits them once the rest of the sequence arrives in a later write().

const { Buffer } = require('node:buffer');

// Normalise the user-supplied encoding name.
function normalizeEncoding(enc) {
  if (!enc) return 'utf8';
  const e = String(enc).toLowerCase();
  switch (e) {
    case 'utf8':
    case 'utf-8':
      return 'utf8';
    case 'ucs2':
    case 'ucs-2':
    case 'utf16le':
    case 'utf-16le':
      return 'utf16le';
    case 'latin1':
    case 'binary':
      return 'latin1';
    case 'ascii':
      return 'ascii';
    case 'base64':
      return 'base64';
    case 'base64url':
      return 'base64url';
    case 'hex':
      return 'hex';
    default:
      throw new Error('Unknown encoding: ' + enc);
  }
}

// A plain constructor function (not a class) on purpose: Node allows both
// `StringDecoder(enc)` and `StringDecoder.call(obj, enc)` (initializing `obj`
// in place), which a class constructor would reject.
function StringDecoder(encoding) {
  if (this == null || this === globalThis) return new StringDecoder(encoding);

  this.encoding = normalizeEncoding(encoding);

  // `lastNeed`  — how many more bytes are needed to finish the pending char.
  // `lastTotal` — total length of the pending multi-byte sequence.
  // `lastChar`  — scratch buffer holding the partial bytes seen so far.
  this.lastNeed = 0;
  this.lastTotal = 0;

  if (this.encoding === 'utf8' || this.encoding === 'utf16le') {
    this.lastChar = Buffer.allocUnsafe(4);
  } else {
    this.lastChar = Buffer.allocUnsafe(0);
  }
}

// ----- public API ---------------------------------------------------------

StringDecoder.prototype.write = function write(buf) {
  if (buf == null) return '';
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length === 0) return '';

  if (this.encoding === 'utf8') return this._writeUtf8(buf);
  if (this.encoding === 'utf16le') return this._writeUtf16(buf);
  if (this.encoding === 'base64' || this.encoding === 'base64url') {
    return this._writeBase64(buf);
  }
  // Single-byte / self-delimiting encodings: no boundary state needed.
  return buf.toString(this.encoding);
};

// Base64 encodes 3-byte groups as 4 chars: emit only complete groups per
// write (no mid-stream `=` padding) and hold the 1–2 leftover bytes until
// the next write — `end()` flushes them with proper padding.
StringDecoder.prototype._writeBase64 = function _writeBase64(buf) {
  if (this._b64rest && this._b64rest.length) {
    buf = Buffer.concat([this._b64rest, buf]);
    this._b64rest = null;
  }
  const keep = buf.length % 3;
  if (keep === 0) return buf.toString(this.encoding);
  this._b64rest = Buffer.from(buf.slice(buf.length - keep));
  return buf.slice(0, buf.length - keep).toString(this.encoding);
};

StringDecoder.prototype.end = function end(buf) {
  let out = buf && buf.length ? this.write(buf) : '';
  if (this._b64rest && this._b64rest.length) {
    out += this._b64rest.toString(this.encoding);
    this._b64rest = null;
  }
  if (this.lastNeed) {
    // Flush whatever partial bytes remain. For UTF-8 Node emits the
    // replacement character; we emit the raw partial via toString which
    // yields U+FFFD for incomplete sequences on a real Buffer.
    out += this.lastChar
      .slice(0, this.lastTotal - this.lastNeed)
      .toString(this.encoding);
    this.lastNeed = 0;
    this.lastTotal = 0;
  }
  return out;
};

// ----- UTF-8 incremental decoding -------------------------------------------

StringDecoder.prototype._writeUtf8 = function _writeUtf8(buf) {
  let result = '';
  let offset = 0;

  // First, try to complete any pending partial character from a prior write.
  if (this.lastNeed) {
    const completed = this._fillLast(buf);
    if (completed === undefined) {
      // Still incomplete — all bytes consumed, nothing to emit yet.
      return '';
    }
    result = completed;
    // `_fillLast` records how many bytes of `buf` it consumed.
    offset = this._consumed;
  }

  // Determine whether the tail of `buf` is an incomplete sequence.
  const total = buf.length;
  const incompleteStart = this._utf8CheckIncomplete(buf, offset);

  if (incompleteStart >= 0) {
    // Bytes [incompleteStart, total) form a partial char to carry over.
    if (incompleteStart < total) {
      result += buf.toString('utf8', offset, incompleteStart);
    } else {
      result += buf.toString('utf8', offset, total);
    }
    return result;
  }

  // No incomplete tail: decode everything remaining.
  result += buf.toString('utf8', offset, total);
  return result;
};

// Try to finish the pending char using the head of `buf`.
// Returns the decoded string if completed, or undefined if still partial.
StringDecoder.prototype._fillLast = function _fillLast(buf) {
  const p = this.lastTotal - this.lastNeed; // bytes already stored
  const available = Math.min(this.lastNeed, buf.length);

  // Copy the next bytes into the scratch buffer, validating continuation
  // bytes (0b10xxxxxx). An invalid byte aborts the pending sequence.
  for (let i = 0; i < available; i++) {
    const byte = buf[i];
    if ((byte & 0xc0) !== 0x80) {
      // Invalid continuation — the whole pending sequence collapses to ONE
      // replacement char. The `i` valid bytes we just absorbed belong to the
      // aborted sequence; the caller resumes decoding at the offending byte.
      this.lastNeed = 0;
      this._consumed = i;
      return '�';
    }
    this.lastChar[p + i] = byte;
  }

  if (available < this.lastNeed) {
    // Still not enough bytes; consume them all and wait for more.
    this.lastNeed -= available;
    this._consumed = buf.length;
    return undefined;
  }

  // We now have a full character.
  this._consumed = this.lastNeed;
  const str = this.lastChar.toString('utf8', 0, this.lastTotal);
  this.lastNeed = 0;
  this.lastTotal = 0;
  return str;
};

// Inspect the tail of `buf` (from `offset`) for an incomplete UTF-8 char.
// If found, stash the partial bytes and return the index where it begins.
// Returns -1 when the buffer ends on a complete boundary.
StringDecoder.prototype._utf8CheckIncomplete = function _utf8CheckIncomplete(buf, offset) {
  let i = buf.length - 1;
  if (i < offset) return -1;

  // Walk back over continuation bytes to find a lead byte.
  let nContinuation = 0;
  while (i >= offset && (buf[i] & 0xc0) === 0x80) {
    nContinuation++;
    i--;
    if (nContinuation > 3) break;
  }
  if (i < offset) {
    // The whole tail is continuation bytes (lead came earlier / already
    // emitted) — treat as complete.
    return -1;
  }

  const lead = buf[i];
  let needTotal = 0;
  if (lead >> 5 === 0x06) needTotal = 2; // 110xxxxx
  else if (lead >> 4 === 0x0e) needTotal = 3; // 1110xxxx
  else if (lead >> 3 === 0x1e) needTotal = 4; // 11110xxx
  else return -1; // ASCII or invalid lead: complete as-is.

  const have = nContinuation + 1; // continuation bytes + the lead
  if (have >= needTotal) {
    // The sequence is fully contained in this buffer.
    return -1;
  }

  // Incomplete: stash bytes [i, end) for the next write.
  this.lastTotal = needTotal;
  this.lastNeed = needTotal - have;
  let p = 0;
  for (let j = i; j < buf.length; j++) {
    this.lastChar[p++] = buf[j];
  }
  return i;
};

// ----- UTF-16LE incremental decoding ----------------------------------------
//
// Code units are 2 bytes; surrogate pairs are 4 bytes. We buffer a dangling
// odd byte (and, conservatively, a high surrogate awaiting its pair).

StringDecoder.prototype._writeUtf16 = function _writeUtf16(buf) {
  let result = '';
  let offset = 0;

  if (this.lastNeed) {
    const need = this.lastNeed;
    const take = Math.min(need, buf.length);
    const p = this.lastTotal - this.lastNeed;
    for (let i = 0; i < take; i++) this.lastChar[p + i] = buf[i];
    this.lastNeed -= take;
    offset = take;
    if (this.lastNeed > 0) return '';
    result += this.lastChar.toString('utf16le', 0, this.lastTotal);
    this.lastTotal = 0;
  }

  const remaining = buf.length - offset;
  // Carry over a trailing odd byte.
  const usable = remaining - (remaining % 2);
  const end = offset + usable;

  result += buf.toString('utf16le', offset, end);

  if (end < buf.length) {
    // One dangling byte: stash it.
    this.lastTotal = 2;
    this.lastNeed = 1;
    this.lastChar[0] = buf[end];
  }
  return result;
};

module.exports = { StringDecoder };
module.exports.default = module.exports;

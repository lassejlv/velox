'use strict';
// HPACK (RFC 7541) + HTTP/2 frame codec (RFC 7540) for velox.
// Self-contained CommonJS. Buffer is a Node-compatible global.

// ============================================================================
// FRAME CODEC (RFC 7540)
// ============================================================================

const FRAME_TYPES = {
  DATA: 0,
  HEADERS: 1,
  PRIORITY: 2,
  RST_STREAM: 3,
  SETTINGS: 4,
  PUSH_PROMISE: 5,
  PING: 6,
  GOAWAY: 7,
  WINDOW_UPDATE: 8,
  CONTINUATION: 9,
};

const FLAGS = {
  END_STREAM: 0x1,
  ACK: 0x1,
  END_HEADERS: 0x4,
  PADDED: 0x8,
  PRIORITY: 0x20,
};

const CONNECTION_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1');

// 9-byte header: Length(24) | Type(8) | Flags(8) | R(1)+StreamID(31)
function encodeFrame(type, flags, streamId, payloadBuffer) {
  const payload = payloadBuffer || Buffer.alloc(0);
  const header = Buffer.alloc(9);
  const len = payload.length;
  header[0] = (len >>> 16) & 0xff;
  header[1] = (len >>> 8) & 0xff;
  header[2] = len & 0xff;
  header[3] = type & 0xff;
  header[4] = flags & 0xff;
  // 31-bit stream id, reserved bit cleared
  header.writeUInt32BE((streamId >>> 0) & 0x7fffffff, 5);
  return Buffer.concat([header, payload]);
}

function parseFrames(buffer) {
  const frames = [];
  let off = 0;
  while (buffer.length - off >= 9) {
    const len =
      (buffer[off] << 16) | (buffer[off + 1] << 8) | buffer[off + 2];
    const total = 9 + len;
    if (buffer.length - off < total) break; // incomplete payload
    const type = buffer[off + 3];
    const flags = buffer[off + 4];
    const streamId = buffer.readUInt32BE(off + 5) & 0x7fffffff;
    const payload = buffer.slice(off + 9, off + total);
    frames.push({ type, flags, streamId, payload });
    off += total;
  }
  return { frames, rest: buffer.slice(off) };
}

// SETTINGS: sequence of 6-byte entries: Identifier(16) + Value(32)
function encodeSettings(settingsObj) {
  const keys = Object.keys(settingsObj);
  const buf = Buffer.alloc(keys.length * 6);
  let o = 0;
  for (const k of keys) {
    const id = Number(k);
    const val = settingsObj[k] >>> 0;
    buf.writeUInt16BE(id & 0xffff, o);
    buf.writeUInt32BE(val, o + 2);
    o += 6;
  }
  return buf;
}

function parseSettings(payload) {
  const obj = {};
  for (let o = 0; o + 6 <= payload.length; o += 6) {
    const id = payload.readUInt16BE(o);
    const val = payload.readUInt32BE(o + 2);
    obj[id] = val;
  }
  return obj;
}

// Padding/priority stripping helpers.
function stripPadding(payload, flags) {
  if (!(flags & FLAGS.PADDED)) return payload;
  if (payload.length < 1) return Buffer.alloc(0);
  const padLen = payload[0];
  const start = 1;
  const end = payload.length - padLen;
  if (end < start) return Buffer.alloc(0);
  return payload.slice(start, end);
}

// For a HEADERS payload: strip PADDED (lead pad-length byte + trailing pad)
// and PRIORITY (5 leading bytes), return the header block fragment.
function parseHeadersPayload(payload, flags) {
  let buf = payload;
  let padLen = 0;
  let off = 0;
  if (flags & FLAGS.PADDED) {
    padLen = buf[0];
    off = 1;
  }
  if (flags & FLAGS.PRIORITY) {
    off += 5; // E(1)+StreamDep(31) + Weight(8)
  }
  const end = buf.length - padLen;
  if (end < off) return Buffer.alloc(0);
  return buf.slice(off, end);
}

// ============================================================================
// HPACK (RFC 7541)
// ============================================================================

// --- Appendix A: Static table (index 1..61) ---
const STATIC_TABLE = [
  [':authority', ''],
  [':method', 'GET'],
  [':method', 'POST'],
  [':path', '/'],
  [':path', '/index.html'],
  [':scheme', 'http'],
  [':scheme', 'https'],
  [':status', '200'],
  [':status', '204'],
  [':status', '206'],
  [':status', '304'],
  [':status', '400'],
  [':status', '404'],
  [':status', '500'],
  ['accept-charset', ''],
  ['accept-encoding', 'gzip, deflate'],
  ['accept-language', ''],
  ['accept-ranges', ''],
  ['accept', ''],
  ['access-control-allow-origin', ''],
  ['age', ''],
  ['allow', ''],
  ['authorization', ''],
  ['cache-control', ''],
  ['content-disposition', ''],
  ['content-encoding', ''],
  ['content-language', ''],
  ['content-length', ''],
  ['content-location', ''],
  ['content-range', ''],
  ['content-type', ''],
  ['cookie', ''],
  ['date', ''],
  ['etag', ''],
  ['expect', ''],
  ['expires', ''],
  ['from', ''],
  ['host', ''],
  ['if-match', ''],
  ['if-modified-since', ''],
  ['if-none-match', ''],
  ['if-range', ''],
  ['if-unmodified-since', ''],
  ['last-modified', ''],
  ['link', ''],
  ['location', ''],
  ['max-forwards', ''],
  ['proxy-authenticate', ''],
  ['proxy-authorization', ''],
  ['range', ''],
  ['referer', ''],
  ['refresh', ''],
  ['retry-after', ''],
  ['server', ''],
  ['set-cookie', ''],
  ['strict-transport-security', ''],
  ['transfer-encoding', ''],
  ['user-agent', ''],
  ['vary', ''],
  ['via', ''],
  ['www-authenticate', ''],
];

// --- Appendix B: Huffman code table (257 entries: 0..255 + EOS@256) ---
// [code (as integer), bit length]
const HUFFMAN_TABLE = [
  [0x1ff8, 13],
  [0x7fffd8, 23],
  [0xfffffe2, 28],
  [0xfffffe3, 28],
  [0xfffffe4, 28],
  [0xfffffe5, 28],
  [0xfffffe6, 28],
  [0xfffffe7, 28],
  [0xfffffe8, 28],
  [0xffffea, 24],
  [0x3ffffffc, 30],
  [0xfffffe9, 28],
  [0xfffffea, 28],
  [0x3ffffffd, 30],
  [0xfffffeb, 28],
  [0xfffffec, 28],
  [0xfffffed, 28],
  [0xfffffee, 28],
  [0xfffffef, 28],
  [0xffffff0, 28],
  [0xffffff1, 28],
  [0xffffff2, 28],
  [0x3ffffffe, 30],
  [0xffffff3, 28],
  [0xffffff4, 28],
  [0xffffff5, 28],
  [0xffffff6, 28],
  [0xffffff7, 28],
  [0xffffff8, 28],
  [0xffffff9, 28],
  [0xffffffa, 28],
  [0xffffffb, 28],
  [0x14, 6],
  [0x3f8, 10],
  [0x3f9, 10],
  [0xffa, 12],
  [0x1ff9, 13],
  [0x15, 6],
  [0xf8, 8],
  [0x7fa, 11],
  [0x3fa, 10],
  [0x3fb, 10],
  [0xf9, 8],
  [0x7fb, 11],
  [0xfa, 8],
  [0x16, 6],
  [0x17, 6],
  [0x18, 6],
  [0x0, 5],
  [0x1, 5],
  [0x2, 5],
  [0x19, 6],
  [0x1a, 6],
  [0x1b, 6],
  [0x1c, 6],
  [0x1d, 6],
  [0x1e, 6],
  [0x1f, 6],
  [0x5c, 7],
  [0xfb, 8],
  [0x7ffc, 15],
  [0x20, 6],
  [0xffb, 12],
  [0x3fc, 10],
  [0x1ffa, 13],
  [0x21, 6],
  [0x5d, 7],
  [0x5e, 7],
  [0x5f, 7],
  [0x60, 7],
  [0x61, 7],
  [0x62, 7],
  [0x63, 7],
  [0x64, 7],
  [0x65, 7],
  [0x66, 7],
  [0x67, 7],
  [0x68, 7],
  [0x69, 7],
  [0x6a, 7],
  [0x6b, 7],
  [0x6c, 7],
  [0x6d, 7],
  [0x6e, 7],
  [0x6f, 7],
  [0x70, 7],
  [0x71, 7],
  [0x72, 7],
  [0xfc, 8],
  [0x73, 7],
  [0xfd, 8],
  [0x1ffb, 13],
  [0x7fff0, 19],
  [0x1ffc, 13],
  [0x3ffc, 14],
  [0x22, 6],
  [0x7ffd, 15],
  [0x3, 5],
  [0x23, 6],
  [0x4, 5],
  [0x24, 6],
  [0x5, 5],
  [0x25, 6],
  [0x26, 6],
  [0x27, 6],
  [0x6, 5],
  [0x74, 7],
  [0x75, 7],
  [0x28, 6],
  [0x29, 6],
  [0x2a, 6],
  [0x7, 5],
  [0x2b, 6],
  [0x76, 7],
  [0x2c, 6],
  [0x8, 5],
  [0x9, 5],
  [0x2d, 6],
  [0x77, 7],
  [0x78, 7],
  [0x79, 7],
  [0x7a, 7],
  [0x7b, 7],
  [0x7ffe, 15],
  [0x7fc, 11],
  [0x3ffd, 14],
  [0x1ffd, 13],
  [0xffffffc, 28],
  [0xfffe6, 20],
  [0x3fffd2, 22],
  [0xfffe7, 20],
  [0xfffe8, 20],
  [0x3fffd3, 22],
  [0x3fffd4, 22],
  [0x3fffd5, 22],
  [0x7fffd9, 23],
  [0x3fffd6, 22],
  [0x7fffda, 23],
  [0x7fffdb, 23],
  [0x7fffdc, 23],
  [0x7fffdd, 23],
  [0x7fffde, 23],
  [0xffffeb, 24],
  [0x7fffdf, 23],
  [0xffffec, 24],
  [0xffffed, 24],
  [0x3fffd7, 22],
  [0x7fffe0, 23],
  [0xffffee, 24],
  [0x7fffe1, 23],
  [0x7fffe2, 23],
  [0x7fffe3, 23],
  [0x7fffe4, 23],
  [0x1fffdc, 21],
  [0x3fffd8, 22],
  [0x7fffe5, 23],
  [0x3fffd9, 22],
  [0x7fffe6, 23],
  [0x7fffe7, 23],
  [0xffffef, 24],
  [0x3fffda, 22],
  [0x1fffdd, 21],
  [0xfffe9, 20],
  [0x3fffdb, 22],
  [0x3fffdc, 22],
  [0x7fffe8, 23],
  [0x7fffe9, 23],
  [0x1fffde, 21],
  [0x7fffea, 23],
  [0x3fffdd, 22],
  [0x3fffde, 22],
  [0xfffff0, 24],
  [0x1fffdf, 21],
  [0x3fffdf, 22],
  [0x7fffeb, 23],
  [0x7fffec, 23],
  [0x1fffe0, 21],
  [0x1fffe1, 21],
  [0x3fffe0, 22],
  [0x1fffe2, 21],
  [0x7fffed, 23],
  [0x3fffe1, 22],
  [0x7fffee, 23],
  [0x7fffef, 23],
  [0xfffea, 20],
  [0x3fffe2, 22],
  [0x3fffe3, 22],
  [0x3fffe4, 22],
  [0x7ffff0, 23],
  [0x3fffe5, 22],
  [0x3fffe6, 22],
  [0x7ffff1, 23],
  [0x3ffffe0, 26],
  [0x3ffffe1, 26],
  [0xfffeb, 20],
  [0x7fff1, 19],
  [0x3fffe7, 22],
  [0x7ffff2, 23],
  [0x3fffe8, 22],
  [0x1ffffec, 25],
  [0x3ffffe2, 26],
  [0x3ffffe3, 26],
  [0x3ffffe4, 26],
  [0x7ffffde, 27],
  [0x7ffffdf, 27],
  [0x3ffffe5, 26],
  [0xfffff1, 24],
  [0x1ffffed, 25],
  [0x7fff2, 19],
  [0x1fffe3, 21],
  [0x3ffffe6, 26],
  [0x7ffffe0, 27],
  [0x7ffffe1, 27],
  [0x3ffffe7, 26],
  [0x7ffffe2, 27],
  [0xfffff2, 24],
  [0x1fffe4, 21],
  [0x1fffe5, 21],
  [0x3ffffe8, 26],
  [0x3ffffe9, 26],
  [0xffffffd, 28],
  [0x7ffffe3, 27],
  [0x7ffffe4, 27],
  [0x7ffffe5, 27],
  [0xfffec, 20],
  [0xfffff3, 24],
  [0xfffed, 20],
  [0x1fffe6, 21],
  [0x3fffe9, 22],
  [0x1fffe7, 21],
  [0x1fffe8, 21],
  [0x7ffff3, 23],
  [0x3fffea, 22],
  [0x3fffeb, 22],
  [0x1ffffee, 25],
  [0x1ffffef, 25],
  [0xfffff4, 24],
  [0xfffff5, 24],
  [0x3ffffea, 26],
  [0x7ffff4, 23],
  [0x3ffffeb, 26],
  [0x7ffffe6, 27],
  [0x3ffffec, 26],
  [0x3ffffed, 26],
  [0x7ffffe7, 27],
  [0x7ffffe8, 27],
  [0x7ffffe9, 27],
  [0x7ffffea, 27],
  [0x7ffffeb, 27],
  [0xffffffe, 28],
  [0x7ffffec, 27],
  [0x7ffffed, 27],
  [0x7ffffee, 27],
  [0x7ffffef, 27],
  [0x7fffff0, 27],
  [0x3ffffee, 26],
  [0x3fffffff, 30], // 256 = EOS
];

// Build a decode trie/lookup. We'll do a simple bit-walk against a sorted
// code list using length-grouped lookup. For decode we use a per-bit-length
// map: codeLengths -> { code: symbol }.
const HUFFMAN_DECODE_BY_LEN = (() => {
  const byLen = {};
  for (let sym = 0; sym < HUFFMAN_TABLE.length; sym++) {
    const [code, len] = HUFFMAN_TABLE[sym];
    if (!byLen[len]) byLen[len] = new Map();
    byLen[len].set(code, sym);
  }
  return byLen;
})();
const HUFFMAN_LENGTHS = Object.keys(HUFFMAN_DECODE_BY_LEN)
  .map(Number)
  .sort((a, b) => a - b);
const HUFFMAN_MAX_LEN = HUFFMAN_LENGTHS[HUFFMAN_LENGTHS.length - 1];
const EOS_SYMBOL = 256;

function huffmanEncode(strBytes) {
  // strBytes: Buffer of raw octets
  const out = [];
  let cur = 0; // accumulator (use number; codes <= 30 bits, accumulate carefully)
  let nbits = 0;
  for (let i = 0; i < strBytes.length; i++) {
    const [code, len] = HUFFMAN_TABLE[strBytes[i]];
    // append `len` bits of `code` to the bitstream
    // process bit by bit to avoid >32-bit overflow issues
    for (let b = len - 1; b >= 0; b--) {
      const bit = (code >>> b) & 1;
      cur = (cur << 1) | bit;
      nbits++;
      if (nbits === 8) {
        out.push(cur & 0xff);
        cur = 0;
        nbits = 0;
      }
    }
  }
  // pad with EOS prefix (1-bits)
  if (nbits > 0) {
    const pad = 8 - nbits;
    cur = (cur << pad) | ((1 << pad) - 1);
    out.push(cur & 0xff);
  }
  return Buffer.from(out);
}

function huffmanDecode(buf) {
  const out = [];
  let code = 0;
  let len = 0;
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i];
    for (let b = 7; b >= 0; b--) {
      code = (code << 1) | ((byte >> b) & 1);
      len++;
      if (HUFFMAN_DECODE_BY_LEN[len]) {
        const m = HUFFMAN_DECODE_BY_LEN[len];
        if (m.has(code)) {
          const sym = m.get(code);
          if (sym === EOS_SYMBOL) {
            throw new Error('HPACK: EOS symbol in Huffman stream');
          }
          out.push(sym);
          code = 0;
          len = 0;
        }
      }
      if (len > HUFFMAN_MAX_LEN) {
        throw new Error('HPACK: invalid Huffman code');
      }
    }
  }
  // remaining bits must be all-ones padding, < 8 bits
  if (len >= 8) {
    throw new Error('HPACK: too much Huffman padding');
  }
  if (len > 0) {
    const allOnes = (1 << len) - 1;
    if ((code & allOnes) !== allOnes) {
      throw new Error('HPACK: invalid Huffman padding');
    }
  }
  return Buffer.from(out);
}

// --- §5.1 Integer representation ---
// encode integer `value` with N-bit prefix, prefixBits = top (8-N) bits flag.
function encodeInteger(value, prefixBits, n) {
  const maxPrefix = (1 << n) - 1;
  const out = [];
  if (value < maxPrefix) {
    out.push(prefixBits | value);
  } else {
    out.push(prefixBits | maxPrefix);
    value -= maxPrefix;
    while (value >= 128) {
      out.push((value & 0x7f) | 0x80);
      value = Math.floor(value / 128);
    }
    out.push(value);
  }
  return out;
}

// decode integer from buf at position, with N-bit prefix.
// returns { value, next }
function decodeInteger(buf, pos, n) {
  const maxPrefix = (1 << n) - 1;
  let value = buf[pos] & maxPrefix;
  pos++;
  if (value < maxPrefix) return { value, next: pos };
  let m = 0;
  let b;
  do {
    b = buf[pos];
    pos++;
    value += (b & 0x7f) * Math.pow(2, m);
    m += 7;
  } while (b & 0x80);
  return { value, next: pos };
}

// --- §5.2 String literal ---
// returns { str: Buffer, next }
function decodeString(buf, pos) {
  const huffman = (buf[pos] & 0x80) !== 0;
  const lenDec = decodeInteger(buf, pos, 7);
  const len = lenDec.value;
  let p = lenDec.next;
  const raw = buf.slice(p, p + len);
  p += len;
  const str = huffman ? huffmanDecode(raw) : raw;
  return { str, next: p };
}

function encodeString(strBytes, useHuffman) {
  if (useHuffman) {
    const enc = huffmanEncode(strBytes);
    const header = encodeInteger(enc.length, 0x80, 7);
    return Buffer.concat([Buffer.from(header), enc]);
  }
  const header = encodeInteger(strBytes.length, 0x00, 7);
  return Buffer.concat([Buffer.from(header), strBytes]);
}

// ============================================================================
// Dynamic table (shared logic)
// ============================================================================
function makeDynamicTable(maxSize) {
  return {
    entries: [], // [name, value], most-recently-added at index 0
    size: 0,
    maxSize,
  };
}

function dynEntrySize(name, value) {
  return Buffer.byteLength(name, 'latin1') + Buffer.byteLength(value, 'latin1') + 32;
}

function dynInsert(table, name, value) {
  const sz = dynEntrySize(name, value);
  // Evict until it fits (or table empties). If entry alone exceeds maxSize,
  // table is emptied and entry not added (RFC 7541 §4.4).
  dynEvictTo(table, table.maxSize - sz);
  if (sz > table.maxSize) return; // cannot fit
  table.entries.unshift([name, value]);
  table.size += sz;
}

function dynEvictTo(table, targetMax) {
  while (table.size > targetMax && table.entries.length > 0) {
    const [n, v] = table.entries.pop();
    table.size -= dynEntrySize(n, v);
  }
}

function dynSetMaxSize(table, newMax) {
  table.maxSize = newMax;
  dynEvictTo(table, newMax);
}

// Lookup by 1-based HPACK index across static + dynamic.
function tableGet(table, index) {
  if (index >= 1 && index <= STATIC_TABLE.length) {
    return STATIC_TABLE[index - 1];
  }
  const dynIdx = index - STATIC_TABLE.length - 1;
  if (dynIdx >= 0 && dynIdx < table.entries.length) {
    return table.entries[dynIdx];
  }
  throw new Error('HPACK: index out of range: ' + index);
}

// ============================================================================
// Decoder
// ============================================================================
function HpackDecoder(maxTableSize) {
  if (!(this instanceof HpackDecoder)) return new HpackDecoder(maxTableSize);
  this.table = makeDynamicTable(maxTableSize == null ? 4096 : maxTableSize);
}

HpackDecoder.prototype.decode = function decode(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const headers = [];
  let pos = 0;
  const table = this.table;

  while (pos < buf.length) {
    const b = buf[pos];
    if (b & 0x80) {
      // §6.1 Indexed Header Field
      const dec = decodeInteger(buf, pos, 7);
      pos = dec.next;
      if (dec.value === 0) throw new Error('HPACK: index 0 in indexed field');
      const [name, value] = tableGet(table, dec.value);
      headers.push([name, value]);
    } else if (b & 0x40) {
      // §6.2.1 Literal with Incremental Indexing (01 prefix, 6-bit index)
      const dec = decodeInteger(buf, pos, 6);
      pos = dec.next;
      let name;
      if (dec.value === 0) {
        const ns = decodeString(buf, pos);
        pos = ns.next;
        name = ns.str.toString('latin1');
      } else {
        name = tableGet(table, dec.value)[0];
      }
      const vs = decodeString(buf, pos);
      pos = vs.next;
      const value = vs.str.toString('latin1');
      dynInsert(table, name, value);
      headers.push([name, value]);
    } else if ((b & 0xf0) === 0x00) {
      // §6.2.2 Literal without Indexing (0000 prefix, 4-bit index)
      const dec = decodeInteger(buf, pos, 4);
      pos = dec.next;
      let name;
      if (dec.value === 0) {
        const ns = decodeString(buf, pos);
        pos = ns.next;
        name = ns.str.toString('latin1');
      } else {
        name = tableGet(table, dec.value)[0];
      }
      const vs = decodeString(buf, pos);
      pos = vs.next;
      headers.push([name, vs.str.toString('latin1')]);
    } else if ((b & 0xf0) === 0x10) {
      // §6.2.3 Literal Never Indexed (0001 prefix, 4-bit index)
      const dec = decodeInteger(buf, pos, 4);
      pos = dec.next;
      let name;
      if (dec.value === 0) {
        const ns = decodeString(buf, pos);
        pos = ns.next;
        name = ns.str.toString('latin1');
      } else {
        name = tableGet(table, dec.value)[0];
      }
      const vs = decodeString(buf, pos);
      pos = vs.next;
      headers.push([name, vs.str.toString('latin1')]);
    } else if ((b & 0xe0) === 0x20) {
      // §6.3 Dynamic Table Size Update (001 prefix, 5-bit)
      const dec = decodeInteger(buf, pos, 5);
      pos = dec.next;
      dynSetMaxSize(table, dec.value);
    } else {
      throw new Error('HPACK: unknown representation byte 0x' + b.toString(16));
    }
  }
  return headers;
};

// ============================================================================
// Encoder
// ============================================================================
function HpackEncoder(maxTableSize) {
  if (!(this instanceof HpackEncoder)) return new HpackEncoder(maxTableSize);
  this.table = makeDynamicTable(maxTableSize == null ? 4096 : maxTableSize);
  this.useHuffman = false; // raw strings (valid, simpler) per spec guidance
}

// Find a full (name,value) match or a name-only match across static+dynamic.
// Returns { index, full } where index is 1-based HPACK index, or null.
function encoderFindMatch(table, name, value) {
  let nameOnly = null;
  // static
  for (let i = 0; i < STATIC_TABLE.length; i++) {
    const [n, v] = STATIC_TABLE[i];
    if (n === name) {
      if (v === value) return { index: i + 1, full: true };
      if (nameOnly === null) nameOnly = i + 1;
    }
  }
  // dynamic
  for (let i = 0; i < table.entries.length; i++) {
    const [n, v] = table.entries[i];
    if (n === name) {
      const idx = STATIC_TABLE.length + 1 + i;
      if (v === value) return { index: idx, full: true };
      if (nameOnly === null) nameOnly = idx;
    }
  }
  if (nameOnly !== null) return { index: nameOnly, full: false };
  return null;
}

HpackEncoder.prototype.encode = function encode(headerPairs) {
  const table = this.table;
  const chunks = [];

  for (const pair of headerPairs) {
    let name = pair[0];
    let value = pair[1] == null ? '' : String(pair[1]);
    // HPACK header names are lowercase in HTTP/2.
    name = String(name).toLowerCase();

    const match = encoderFindMatch(table, name, value);

    if (match && match.full) {
      // §6.1 Indexed Header Field
      chunks.push(Buffer.from(encodeInteger(match.index, 0x80, 7)));
    } else {
      // §6.2.1 Literal with Incremental Indexing
      let idx = match ? match.index : 0;
      chunks.push(Buffer.from(encodeInteger(idx, 0x40, 6)));
      if (!match) {
        chunks.push(
          encodeString(Buffer.from(name, 'latin1'), this.useHuffman),
        );
      }
      chunks.push(
        encodeString(Buffer.from(value, 'latin1'), this.useHuffman),
      );
      dynInsert(table, name, value);
    }
  }
  return Buffer.concat(chunks);
};

// ============================================================================
// Exports
// ============================================================================
module.exports = {
  // frame codec
  FRAME_TYPES,
  FLAGS,
  CONNECTION_PREFACE,
  encodeFrame,
  parseFrames,
  encodeSettings,
  parseSettings,
  stripPadding,
  parseHeadersPayload,
  // hpack
  HpackDecoder,
  HpackEncoder,
  // low-level primitives (useful + testable)
  STATIC_TABLE,
  HUFFMAN_TABLE,
  huffmanEncode,
  huffmanDecode,
  encodeInteger,
  decodeInteger,
  encodeString,
  decodeString,
};

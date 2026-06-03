// node:buffer — re-exports the global Buffer (installed by the buffer prelude).

// Coerce a Buffer/TypedArray/DataView/ArrayBuffer into a Uint8Array view over
// the same bytes (used by isUtf8/isAscii, which only accept those inputs).
function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('The "input" argument must be an instance of ArrayBuffer, Buffer, TypedArray, or DataView.');
}

module.exports = {
  Buffer: globalThis.Buffer,
  constants: { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffff },
  kMaxLength: 0x7fffffff,
  kStringMaxLength: 0x1fffffff,
  INSPECT_MAX_BYTES: 50,
  SlowBuffer: globalThis.Buffer,
  // Validate that the bytes are well-formed UTF-8 (rejects overlong forms,
  // surrogates, out-of-range, and truncated/invalid sequences).
  isUtf8: function (input) {
    var b = asBytes(input);
    var i = 0;
    var n = b.length;
    while (i < n) {
      var b0 = b[i];
      if (b0 < 0x80) { i++; continue; }
      var extra, min, cp;
      if ((b0 & 0xe0) === 0xc0) { extra = 1; min = 0x80; cp = b0 & 0x1f; }
      else if ((b0 & 0xf0) === 0xe0) { extra = 2; min = 0x800; cp = b0 & 0x0f; }
      else if ((b0 & 0xf8) === 0xf0) { extra = 3; min = 0x10000; cp = b0 & 0x07; }
      else return false;
      for (var k = 1; k <= extra; k++) {
        if (i + k >= n) return false;
        var bk = b[i + k];
        if ((bk & 0xc0) !== 0x80) return false;
        cp = (cp << 6) | (bk & 0x3f);
      }
      if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
      i += extra + 1;
    }
    return true;
  },
  // True when every byte is in the ASCII range (0x00..0x7f).
  isAscii: function (input) {
    var b = asBytes(input);
    for (var i = 0; i < b.length; i++) {
      if (b[i] > 0x7f) return false;
    }
    return true;
  },
  // transcode(source, fromEnc, toEnc): re-encode a Buffer/Uint8Array's bytes
  // from one supported encoding to another (Node: ascii/latin1/utf8/utf16le/
  // ucs2). Decode to a JS string then re-encode through Buffer.
  transcode: function (source, fromEnc, toEnc) {
    var b = asBytes(source);
    var buf = globalThis.Buffer.from(b.buffer, b.byteOffset, b.byteLength);
    return globalThis.Buffer.from(buf.toString(fromEnc), toEnc);
  },
};

// Node re-exports the web Blob/File and base64 helpers from node:buffer; mirror
// the globals when they're present (installed by the web globals/fetch preludes).
if (typeof globalThis.Blob !== 'undefined') module.exports.Blob = globalThis.Blob;
if (typeof globalThis.File !== 'undefined') module.exports.File = globalThis.File;
if (typeof globalThis.atob !== 'undefined') module.exports.atob = globalThis.atob;
if (typeof globalThis.btoa !== 'undefined') module.exports.btoa = globalThis.btoa;

module.exports.default = module.exports;

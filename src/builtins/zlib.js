// node:zlib — compression backed by the native __velox_zlib bridge.
//
// Binary data crosses the Rust boundary as latin1 strings (one char per byte),
// so every helper converts Buffer/string <-> latin1 around the native call.
// The streaming classes are *one-shot*: they buffer all input and emit the
// full (de)compressed result on _flush — they are NOT incremental.

var stream = require('node:stream');
var Transform = stream.Transform;

// --- latin1 <-> Buffer plumbing --------------------------------------------

// Coerce a Buffer/string/TypedArray input to a latin1 string for the bridge.
function toLatin1(input) {
  if (globalThis.Buffer.isBuffer(input)) return input.toString('latin1');
  if (typeof input === 'string') return globalThis.Buffer.from(input, 'utf8').toString('latin1');
  // ArrayBuffer / TypedArray / array-like
  return globalThis.Buffer.from(input).toString('latin1');
}
function fromLatin1(latin1) {
  return globalThis.Buffer.from(latin1, 'latin1');
}

// Single entry point to the native codec; returns a Buffer.
function run(mode, input) {
  return fromLatin1(__velox_zlib(mode, toLatin1(input)));
}

// --- synchronous API -------------------------------------------------------

function gzipSync(buf) { return run('gzip', buf); }
function gunzipSync(buf) { return run('gunzip', buf); }
function deflateSync(buf) { return run('deflate', buf); }
function inflateSync(buf) { return run('inflate', buf); }
function deflateRawSync(buf) { return run('deflateRaw', buf); }
function inflateRawSync(buf) { return run('inflateRaw', buf); }
function unzipSync(buf) { return run('unzip', buf); }

function brotliCompressSync(buf) { return run('brotliCompress', buf); }
function brotliDecompressSync(buf) { return run('brotliDecompress', buf); }

// --- callback API (sync under the hood, resolved on the microtask queue) ----

// Build a Node-style `(buf[, opts], cb)` async wrapper around a sync codec.
function asyncify(syncFn) {
  return function (buf, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    queueMicrotask(function () {
      var result;
      try { result = syncFn(buf); }
      catch (e) { if (cb) cb(e); return; }
      if (cb) cb(null, result);
    });
  };
}

var gzip = asyncify(gzipSync);
var gunzip = asyncify(gunzipSync);
var deflate = asyncify(deflateSync);
var inflate = asyncify(inflateSync);
var deflateRaw = asyncify(deflateRawSync);
var inflateRaw = asyncify(inflateRawSync);
var unzip = asyncify(unzipSync);

// Promise variants (mirrors util.promisify of the callback forms).
function promisify(syncFn) {
  return function (buf) {
    return new Promise(function (resolve, reject) {
      queueMicrotask(function () {
        try { resolve(syncFn(buf)); } catch (e) { reject(e); }
      });
    });
  };
}

// --- streaming (one-shot) --------------------------------------------------

// Create a Transform that accumulates every chunk and emits the full codec
// output once the writable side ends. Not incremental — fine for whole files.
function makeTransform(syncFn) {
  return function (options) {
    var chunks = [];
    return new Transform({
      transform: function (chunk, encoding, cb) {
        chunks.push(globalThis.Buffer.isBuffer(chunk)
          ? chunk
          : globalThis.Buffer.from(chunk, encoding || 'utf8'));
        cb();
      },
      flush: function (cb) {
        var out;
        try { out = syncFn(globalThis.Buffer.concat(chunks)); }
        catch (e) { cb(e); return; }
        cb(null, out);
      },
    });
  };
}

var createGzip = makeTransform(gzipSync);
var createGunzip = makeTransform(gunzipSync);
var createDeflate = makeTransform(deflateSync);
var createInflate = makeTransform(inflateSync);
var createDeflateRaw = makeTransform(deflateRawSync);
var createInflateRaw = makeTransform(inflateRawSync);
var createUnzip = makeTransform(unzipSync);
var createBrotliCompress = makeTransform(brotliCompressSync);
var createBrotliDecompress = makeTransform(brotliDecompressSync);

// --- constants & codes -----------------------------------------------------

var constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_TREES: 6,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_MEMLEVEL: 1,
  Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_CHUNK: 16384,
  Z_MIN_CHUNK: 64,
  ZLIB_VERNUM: 0x12b0,
};

// Numeric return code -> symbolic name (and the reverse), Node-style.
var codes = {
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  '0': 'Z_OK',
  '1': 'Z_STREAM_END',
  '2': 'Z_NEED_DICT',
  '-1': 'Z_ERRNO',
  '-2': 'Z_STREAM_ERROR',
  '-3': 'Z_DATA_ERROR',
  '-4': 'Z_MEM_ERROR',
  '-5': 'Z_BUF_ERROR',
  '-6': 'Z_VERSION_ERROR',
};

// --- exports ---------------------------------------------------------------

module.exports = {
  gzipSync: gzipSync,
  gunzipSync: gunzipSync,
  deflateSync: deflateSync,
  inflateSync: inflateSync,
  deflateRawSync: deflateRawSync,
  inflateRawSync: inflateRawSync,
  unzipSync: unzipSync,
  brotliCompressSync: brotliCompressSync,
  brotliDecompressSync: brotliDecompressSync,
  createBrotliCompress: createBrotliCompress,
  createBrotliDecompress: createBrotliDecompress,

  gzip: gzip,
  gunzip: gunzip,
  deflate: deflate,
  inflate: inflate,
  deflateRaw: deflateRaw,
  inflateRaw: inflateRaw,
  unzip: unzip,
  brotliCompress: asyncify(brotliCompressSync),
  brotliDecompress: asyncify(brotliDecompressSync),

  createGzip: createGzip,
  createGunzip: createGunzip,
  createDeflate: createDeflate,
  createInflate: createInflate,
  createDeflateRaw: createDeflateRaw,
  createInflateRaw: createInflateRaw,
  createUnzip: createUnzip,

  constants: constants,
  codes: codes,

  promises: {
    gzip: promisify(gzipSync),
    gunzip: promisify(gunzipSync),
    deflate: promisify(deflateSync),
    inflate: promisify(inflateSync),
    deflateRaw: promisify(deflateRawSync),
    inflateRaw: promisify(inflateRawSync),
    unzip: promisify(unzipSync),
    brotliCompress: promisify(brotliCompressSync),
    brotliDecompress: promisify(brotliDecompressSync),
  },
};
module.exports.default = module.exports;

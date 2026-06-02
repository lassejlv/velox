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

// A Transform subclass that accumulates every chunk and emits the full codec
// output once the writable side ends. Not incremental — fine for whole files.
// These are real constructor classes (Node exposes `zlib.Inflate`/`Deflate`/…);
// libraries like pngjs do `util.inherits(MyInflate, zlib.Inflate)`.
// A stateful low-level codec handle exposing the `writeSync(flushFlag, chunk,
// inOff, inLen, outBuf, outOff, outLen) → [availInAfter, availOutAfter]` protocol
// that Node's zlib binding provides. pngjs's sync-inflate drives this directly
// (it overrides `_processChunk` and reaches into `this._handle`). We run the
// one-shot codec on first use, then dole the result out across the output
// buffers the caller hands us, growing as its loop requests more.
function makeZlibHandle(syncFn) {
  var result = null;
  var consumed = 0;
  return {
    writeSync: function (_flushFlag, chunk, inOff, inLen, outBuf, outOff, outLen) {
      if (result === null) {
        var input = inLen > 0
          ? globalThis.Buffer.from(chunk).slice(inOff, inOff + inLen)
          : globalThis.Buffer.alloc(0);
        result = syncFn(input);
        consumed = 0;
      }
      var remaining = result.length - consumed;
      var toWrite = remaining < outLen ? remaining : outLen;
      if (toWrite > 0) result.copy(outBuf, outOff, consumed, consumed + toWrite);
      consumed += toWrite;
      return [0, outLen - toWrite]; // [availInAfter, availOutAfter]
    },
    close: function () { result = null; consumed = 0; },
    reset: function () { result = null; consumed = 0; },
  };
}

function makeZlibClass(syncFn) {
  function ZlibStream(options) {
    if (!(this instanceof ZlibStream)) return new ZlibStream(options);
    Transform.call(this, options);
    this._chunks = [];
    this._zlibSync = syncFn;
    this.bytesWritten = 0;
    // Low-level binding fields some libraries (pngjs) read after calling the
    // super constructor. Harmless for the normal Transform path above.
    var chunkSize = (options && options.chunkSize) || 16384;
    this._chunkSize = chunkSize;
    this._offset = 0;
    this._outOffset = 0;
    this._buffer = globalThis.Buffer.allocUnsafe(chunkSize);
    this._outBuffer = this._buffer;
    this._maxLength = (options && options.maxLength != null) ? options.maxLength : Infinity;
    this._finishFlushFlag = 4; // Z_FINISH
    this._hadError = false;
    this._writeState = null;
    this._handle = makeZlibHandle(syncFn);
  }
  ZlibStream.prototype = Object.create(Transform.prototype);
  ZlibStream.prototype.constructor = ZlibStream;
  ZlibStream.prototype._transform = function (chunk, encoding, cb) {
    var buf = globalThis.Buffer.isBuffer(chunk)
      ? chunk
      : globalThis.Buffer.from(chunk, encoding || 'utf8');
    this._chunks.push(buf);
    this.bytesWritten += buf.length;
    cb();
  };
  ZlibStream.prototype._flush = function (cb) {
    var out;
    try { out = this._zlibSync(globalThis.Buffer.concat(this._chunks)); }
    catch (e) { cb(e); return; }
    cb(null, out);
  };
  // Node's no-op tuning methods.
  ZlibStream.prototype.params = function (level, strategy, cb) { if (cb) queueMicrotask(cb); };
  ZlibStream.prototype.reset = function () { this._chunks = []; this.bytesWritten = 0; };
  ZlibStream.prototype.flush = function (kind, cb) { if (typeof kind === 'function') { kind(); } else if (cb) cb(); };
  return ZlibStream;
}

// The class constructors (Node-named).
var Gzip = makeZlibClass(gzipSync);
var Gunzip = makeZlibClass(gunzipSync);
var Deflate = makeZlibClass(deflateSync);
var Inflate = makeZlibClass(inflateSync);
var DeflateRaw = makeZlibClass(deflateRawSync);
var InflateRaw = makeZlibClass(inflateRawSync);
var Unzip = makeZlibClass(unzipSync);
var BrotliCompress = makeZlibClass(brotliCompressSync);
var BrotliDecompress = makeZlibClass(brotliDecompressSync);

// The `create*` factories build an instance of the matching class.
function createGzip(o) { return new Gzip(o); }
function createGunzip(o) { return new Gunzip(o); }
function createDeflate(o) { return new Deflate(o); }
function createInflate(o) { return new Inflate(o); }
function createDeflateRaw(o) { return new DeflateRaw(o); }
function createInflateRaw(o) { return new InflateRaw(o); }
function createUnzip(o) { return new Unzip(o); }
function createBrotliCompress(o) { return new BrotliCompress(o); }
function createBrotliDecompress(o) { return new BrotliDecompress(o); }

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

  // Class constructors (Node exposes these; pngjs et al. subclass them).
  Gzip: Gzip,
  Gunzip: Gunzip,
  Deflate: Deflate,
  Inflate: Inflate,
  DeflateRaw: DeflateRaw,
  InflateRaw: InflateRaw,
  Unzip: Unzip,
  BrotliCompress: BrotliCompress,
  BrotliDecompress: BrotliDecompress,

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

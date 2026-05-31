// node:v8 — a pragmatic subset. The headline is `serialize`/`deserialize`,
// which implement V8's structured-clone wire format (the "ff" version envelope)
// for the JSON-ish value graph: null/bool/int/double/string/array/object/
// Map/Set/Buffer/Uint8Array/Date. This is what real Node uses for advanced
// child_process/worker IPC, so libraries like execa load and round-trip values.
// Heap-introspection functions are best-effort stubs.

var SER_VERSION = 15; // V8 serialization format version (Node 18–22)

// --- writer -----------------------------------------------------------------
function Writer() { this.bytes = []; }
Writer.prototype.u8 = function (b) { this.bytes.push(b & 0xff); };
Writer.prototype.raw = function (arr) { for (var i = 0; i < arr.length; i++) this.bytes.push(arr[i] & 0xff); };
Writer.prototype.varint = function (n) {
  // unsigned LEB128
  n = n >>> 0;
  do { var b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; this.bytes.push(b); } while (n);
};
Writer.prototype.zigzag = function (n) {
  // signed → zigzag → varint, via the same byte stream as V8's WriteVarint(zigzag)
  var zz = n < 0 ? (-n * 2 - 1) : (n * 2);
  // zz may exceed 32 bits for large ints; fall back to double in that case (handled by caller)
  this.varint(zz);
};
Writer.prototype.double = function (n) {
  var buf = globalThis.Buffer.alloc(8);
  buf.writeDoubleLE(n, 0);
  for (var i = 0; i < 8; i++) this.bytes.push(buf[i]);
};

function writeValue(w, value) {
  if (value === undefined) { w.u8(0x5f); return; }            // '_' undefined
  if (value === null) { w.u8(0x30); return; }                 // '0' null
  if (value === true) { w.u8(0x54); return; }                 // 'T'
  if (value === false) { w.u8(0x46); return; }                // 'F'
  var t = typeof value;
  if (t === 'number') {
    if (Number.isInteger(value) && Math.abs(value) < 0x40000000) { w.u8(0x49); w.zigzag(value); return; } // 'I' int32
    w.u8(0x4e); w.double(value); return;                      // 'N' double
  }
  if (t === 'string') {
    // 'c' two-byte? Node uses utf8 ('S') for one-byte, else two-byte. Use utf8 ('S').
    var sbuf = globalThis.Buffer.from(value, 'utf8');
    w.u8(0x53); w.varint(sbuf.length); w.raw(sbuf);           // 'S' utf8 string
    return;
  }
  if (t === 'bigint') {
    var neg = value < 0n; var mag = neg ? -value : value;
    var hex = mag.toString(16); if (hex.length % 2) hex = '0' + hex;
    var bytes = []; for (var i = hex.length; i > 0; i -= 2) bytes.push(parseInt(hex.slice(i - 2, i), 16));
    var bitfield = (bytes.length << 1) | (neg ? 1 : 0);
    w.u8(0x5a); w.varint(bitfield); w.raw(bytes); return;     // 'Z' BigInt
  }
  if (value instanceof Date) { w.u8(0x44); w.double(value.getTime()); return; } // 'D'
  if (globalThis.Buffer && globalThis.Buffer.isBuffer(value)) {
    w.u8(0x42); w.varint(value.length); w.raw(value); return; // 'B' our extension for Buffer (decoded back to Buffer)
  }
  if (value instanceof Uint8Array) { w.u8(0x42); w.varint(value.length); w.raw(value); return; }
  if (Array.isArray(value)) {
    w.u8(0x41); w.varint(value.length);                       // 'A' dense array
    for (var j = 0; j < value.length; j++) writeValue(w, value[j]);
    w.u8(0x24); w.varint(0); w.varint(value.length);          // '$' end + props + length
    return;
  }
  if (value instanceof Map) {
    w.u8(0x3b);                                               // ';' Map begin
    var mc = 0;
    value.forEach(function (v, k) { writeValue(w, k); writeValue(w, v); mc += 2; });
    w.u8(0x3a); w.varint(mc); return;                         // ':' Map end
  }
  if (value instanceof Set) {
    w.u8(0x27);                                               // "'" Set begin
    var sc = 0;
    value.forEach(function (v) { writeValue(w, v); sc++; });
    w.u8(0x2c); w.varint(sc); return;                         // ',' Set end
  }
  if (t === 'object') {
    var keys = Object.keys(value);
    w.u8(0x6f);                                               // 'o' object begin
    for (var k = 0; k < keys.length; k++) { writeValue(w, keys[k]); writeValue(w, value[keys[k]]); }
    w.u8(0x7b); w.varint(keys.length); return;               // '{' object end + count
  }
  // Fallback: stringify unknown.
  writeValue(w, String(value));
}

function serialize(value) {
  var w = new Writer();
  w.u8(0xff); w.varint(SER_VERSION);                          // version envelope
  writeValue(w, value);
  return globalThis.Buffer.from(w.bytes);
}

// --- reader -----------------------------------------------------------------
function Reader(buf) { this.b = buf; this.pos = 0; }
Reader.prototype.u8 = function () { return this.b[this.pos++]; };
Reader.prototype.varint = function () {
  var result = 0, shift = 0, byte;
  do { byte = this.b[this.pos++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
  return result >>> 0;
};
Reader.prototype.zigzag = function () { var n = this.varint(); return (n & 1) ? -((n + 1) >>> 1) : (n >>> 1); };
Reader.prototype.double = function () { var d = this.b.readDoubleLE(this.pos); this.pos += 8; return d; };
Reader.prototype.bytes = function (len) { var s = this.b.slice(this.pos, this.pos + len); this.pos += len; return s; };

function readValue(r) {
  var tag = r.u8();
  switch (tag) {
    case 0x5f: return undefined;
    case 0x30: return null;
    case 0x54: return true;
    case 0x46: return false;
    case 0x49: return r.zigzag();
    case 0x55: return r.varint();              // 'U' uint32 (defensive)
    case 0x4e: return r.double();
    case 0x53: return r.bytes(r.varint()).toString('utf8'); // 'S'
    case 0x44: return new Date(r.double());
    case 0x42: return r.bytes(r.varint());     // 'B' → Buffer
    case 0x5a: {                               // 'Z' BigInt
      var bitfield = r.varint(); var neg = bitfield & 1; var len = bitfield >>> 1;
      var bytes = r.bytes(len); var hex = '0x';
      for (var i = bytes.length - 1; i >= 0; i--) hex += bytes[i].toString(16).padStart(2, '0');
      var bi = BigInt(len ? hex : '0x0'); return neg ? -bi : bi;
    }
    case 0x41: {                               // 'A' dense array
      var n = r.varint(); var arr = new Array(n);
      for (var a = 0; a < n; a++) arr[a] = readValue(r);
      r.u8(); r.varint(); r.varint();          // '$' end markers
      return arr;
    }
    case 0x6f: {                               // 'o' object
      var obj = {};
      while (r.b[r.pos] !== 0x7b) { var key = readValue(r); obj[key] = readValue(r); }
      r.u8(); r.varint();                      // '{' end + count
      return obj;
    }
    case 0x3b: {                               // ';' Map
      var m = new Map();
      while (r.b[r.pos] !== 0x3a) { var mk = readValue(r); var mv = readValue(r); m.set(mk, mv); }
      r.u8(); r.varint(); return m;
    }
    case 0x27: {                               // "'" Set
      var st = new Set();
      while (r.b[r.pos] !== 0x2c) { st.add(readValue(r)); }
      r.u8(); r.varint(); return st;
    }
    default: throw new Error('v8.deserialize: unsupported tag 0x' + tag.toString(16));
  }
}

function deserialize(buf) {
  var b = globalThis.Buffer.isBuffer(buf) ? buf : globalThis.Buffer.from(buf);
  var r = new Reader(b);
  if (r.b[r.pos] === 0xff) { r.pos++; r.varint(); } // skip version envelope
  return readValue(r);
}

// Streaming wrappers Node exposes.
function DefaultSerializer() { this._w = new Writer(); }
DefaultSerializer.prototype.writeHeader = function () { this._w.u8(0xff); this._w.varint(SER_VERSION); };
DefaultSerializer.prototype.writeValue = function (v) { writeValue(this._w, v); };
DefaultSerializer.prototype.releaseBuffer = function () { return globalThis.Buffer.from(this._w.bytes); };
DefaultSerializer.prototype.writeUint32 = function (n) { this._w.u8(0x55); this._w.varint(n); };
DefaultSerializer.prototype.writeDouble = function (n) { this._w.double(n); };

function DefaultDeserializer(buf) { this._r = new Reader(globalThis.Buffer.isBuffer(buf) ? buf : globalThis.Buffer.from(buf)); }
DefaultDeserializer.prototype.readHeader = function () { if (this._r.b[this._r.pos] === 0xff) { this._r.pos++; this._r.varint(); } };
DefaultDeserializer.prototype.readValue = function () { return readValue(this._r); };

// --- heap introspection (best-effort stubs) ---------------------------------
function getHeapStatistics() {
  return {
    total_heap_size: 0, total_heap_size_executable: 0, total_physical_size: 0,
    total_available_size: 0, used_heap_size: 0, heap_size_limit: 0,
    malloced_memory: 0, peak_malloced_memory: 0, does_zap_garbage: 0,
    number_of_native_contexts: 0, number_of_detached_contexts: 0,
    total_global_handles_size: 0, used_global_handles_size: 0, external_memory: 0,
  };
}
function getHeapSpaceStatistics() { return []; }
function getHeapCodeStatistics() { return { code_and_metadata_size: 0, bytecode_and_metadata_size: 0, external_script_source_size: 0 }; }
function setFlagsFromString() {}
function writeHeapSnapshot() { throw new Error('v8.writeHeapSnapshot is not supported in velox'); }
function getHeapSnapshot() { throw new Error('v8.getHeapSnapshot is not supported in velox'); }
function takeCoverage() {}
function stopCoverage() {}
function setHeapSnapshotNearHeapLimit() {}

module.exports = {
  serialize: serialize,
  deserialize: deserialize,
  Serializer: DefaultSerializer,
  Deserializer: DefaultDeserializer,
  DefaultSerializer: DefaultSerializer,
  DefaultDeserializer: DefaultDeserializer,
  getHeapStatistics: getHeapStatistics,
  getHeapSpaceStatistics: getHeapSpaceStatistics,
  getHeapCodeStatistics: getHeapCodeStatistics,
  setFlagsFromString: setFlagsFromString,
  writeHeapSnapshot: writeHeapSnapshot,
  getHeapSnapshot: getHeapSnapshot,
  takeCoverage: takeCoverage,
  stopCoverage: stopCoverage,
  setHeapSnapshotNearHeapLimit: setHeapSnapshotNearHeapLimit,
  cachedDataVersionTag: function () { return 0; },
  promiseHooks: { createHook: function () { return function () {}; }, onInit: function () {}, onSettled: function () {}, onBefore: function () {}, onAfter: function () {} },
  serdes: {},
};
module.exports.default = module.exports;

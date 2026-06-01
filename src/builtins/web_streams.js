// WHATWG Streams (ReadableStream / WritableStream / TransformStream) — a
// pragmatic implementation covering the surface modern packages use (undici,
// node-fetch, the Fetch API). Not byte-stream/BYOB or full backpressure-spec,
// but supports controllers, readers/writers, async iteration, tee, and piping.
(function () {
  'use strict';
  var g = globalThis;
  if (typeof g.ReadableStream !== 'undefined') return;

  function makePromise() {
    var resolve, reject;
    var p = new Promise(function (res, rej) { resolve = res; reject = rej; });
    return { promise: p, resolve: resolve, reject: reject };
  }

  // --- ReadableStream ------------------------------------------------------
  function ReadableStream(underlyingSource, strategy) {
    underlyingSource = underlyingSource || {};
    this._queue = [];
    this._closed = false;
    this._errored = null;
    this._reader = null;
    this._pullScheduled = false;
    this._readRequests = [];
    this._source = underlyingSource;
    this._pulling = false;
    var self = this;
    this._controller = {
      get desiredSize() { return self._closed ? null : 1 - self._queue.length; },
      enqueue: function (chunk) {
        if (self._closed || self._errored) return;
        if (self._readRequests.length > 0) {
          self._readRequests.shift().resolve({ value: chunk, done: false });
        } else {
          self._queue.push(chunk);
        }
      },
      close: function () {
        self._closed = true;
        while (self._readRequests.length) self._readRequests.shift().resolve({ value: undefined, done: true });
      },
      error: function (e) {
        self._errored = e || new Error('stream error');
        while (self._readRequests.length) self._readRequests.shift().reject(self._errored);
      },
    };
    try {
      var r = underlyingSource.start && underlyingSource.start(this._controller);
      Promise.resolve(r).then(function () { self._maybePull(); }, function (e) { self._controller.error(e); });
    } catch (e) { this._controller.error(e); }
  }
  ReadableStream.prototype._maybePull = function () {
    var self = this;
    if (this._closed || this._errored || this._pulling) return;
    if (typeof this._source.pull !== 'function') return;
    if (this._queue.length > 0) return;
    this._pulling = true;
    try {
      Promise.resolve(this._source.pull(this._controller)).then(
        function () { self._pulling = false; if (self._readRequests.length && self._queue.length === 0) self._maybePull(); },
        function (e) { self._pulling = false; self._controller.error(e); }
      );
    } catch (e) { this._pulling = false; this._controller.error(e); }
  };
  ReadableStream.prototype._read = function () {
    var self = this;
    if (this._queue.length > 0) {
      var chunk = this._queue.shift();
      this._maybePull();
      return Promise.resolve({ value: chunk, done: false });
    }
    if (this._errored) return Promise.reject(this._errored);
    if (this._closed) return Promise.resolve({ value: undefined, done: true });
    var d = makePromise();
    this._readRequests.push(d);
    this._maybePull();
    return d.promise;
  };
  ReadableStream.prototype.getReader = function (opts) {
    if (this._reader) throw new TypeError('ReadableStream is locked');
    var self = this;
    this._reader = {
      read: function () { return self._read(); },
      releaseLock: function () { self._reader = null; },
      cancel: function (reason) { return self.cancel(reason); },
      closed: Promise.resolve(),
    };
    return this._reader;
  };
  ReadableStream.prototype.cancel = function (reason) {
    this._closed = true;
    this._queue = [];
    try { if (this._source.cancel) this._source.cancel(reason); } catch (e) {}
    return Promise.resolve();
  };
  Object.defineProperty(ReadableStream.prototype, 'locked', { get: function () { return this._reader !== null; } });
  ReadableStream.prototype[Symbol.asyncIterator] = function () {
    var reader = this.getReader();
    return {
      next: function () { return reader.read(); },
      return: function (v) { reader.releaseLock(); return Promise.resolve({ value: v, done: true }); },
      [Symbol.asyncIterator]: function () { return this; },
    };
  };
  ReadableStream.prototype.values = ReadableStream.prototype[Symbol.asyncIterator];
  ReadableStream.prototype.pipeTo = function (dest, options) {
    var reader = this.getReader();
    var writer = dest.getWriter();
    return new Promise(function (resolve, reject) {
      (function pump() {
        reader.read().then(function (r) {
          if (r.done) { writer.close().then(resolve, reject); return; }
          writer.write(r.value).then(pump, reject);
        }, reject);
      })();
    });
  };
  ReadableStream.prototype.pipeThrough = function (transform, options) {
    this.pipeTo(transform.writable, options);
    return transform.readable;
  };
  ReadableStream.prototype.tee = function () {
    var reader = this.getReader();
    var q1 = [], q2 = [];
    var s1, s2;
    function pump() {
      reader.read().then(function (r) {
        if (r.done) { s1._controller.close(); s2._controller.close(); return; }
        s1._controller.enqueue(r.value); s2._controller.enqueue(r.value); pump();
      });
    }
    s1 = new ReadableStream({ start: function () {} });
    s2 = new ReadableStream({ start: function () { pump(); } });
    return [s1, s2];
  };
  ReadableStream.from = function (iterable) {
    var iter = iterable[Symbol.asyncIterator] ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
    return new ReadableStream({
      pull: function (c) {
        return Promise.resolve(iter.next()).then(function (r) {
          if (r.done) c.close(); else c.enqueue(r.value);
        });
      },
    });
  };

  // --- WritableStream ------------------------------------------------------
  function WritableStream(underlyingSink, strategy) {
    underlyingSink = underlyingSink || {};
    this._sink = underlyingSink;
    this._writer = null;
    this._closed = false;
    this._errored = null;
    var self = this;
    this._controller = { error: function (e) { self._errored = e; }, signal: undefined };
    try { if (underlyingSink.start) underlyingSink.start(this._controller); } catch (e) { this._errored = e; }
  }
  WritableStream.prototype.getWriter = function () {
    if (this._writer) throw new TypeError('WritableStream is locked');
    var self = this;
    this._writer = {
      write: function (chunk) {
        if (self._errored) return Promise.reject(self._errored);
        try { return Promise.resolve(self._sink.write ? self._sink.write(chunk, self._controller) : undefined); }
        catch (e) { return Promise.reject(e); }
      },
      close: function () {
        self._closed = true;
        try { return Promise.resolve(self._sink.close ? self._sink.close() : undefined); }
        catch (e) { return Promise.reject(e); }
      },
      abort: function (reason) {
        try { return Promise.resolve(self._sink.abort ? self._sink.abort(reason) : undefined); }
        catch (e) { return Promise.reject(e); }
      },
      releaseLock: function () { self._writer = null; },
      get desiredSize() { return 1; },
      ready: Promise.resolve(),
      closed: Promise.resolve(),
    };
    return this._writer;
  };
  WritableStream.prototype.abort = function (reason) { var w = this.getWriter(); return w.abort(reason); };
  WritableStream.prototype.close = function () { var w = this._writer || this.getWriter(); return w.close(); };
  Object.defineProperty(WritableStream.prototype, 'locked', { get: function () { return this._writer !== null; } });

  // --- TransformStream -----------------------------------------------------
  function TransformStream(transformer, writableStrategy, readableStrategy) {
    transformer = transformer || {};
    var readableController;
    this.readable = new ReadableStream({ start: function (c) { readableController = c; } });
    var self = this;
    var tController = {
      enqueue: function (chunk) { readableController.enqueue(chunk); },
      terminate: function () { readableController.close(); },
      error: function (e) { readableController.error(e); },
    };
    this.writable = new WritableStream({
      write: function (chunk) {
        if (transformer.transform) return Promise.resolve(transformer.transform(chunk, tController));
        tController.enqueue(chunk);
      },
      close: function () {
        var r = transformer.flush ? Promise.resolve(transformer.flush(tController)) : Promise.resolve();
        return r.then(function () { readableController.close(); });
      },
      abort: function (e) { readableController.error(e); },
    });
    try { if (transformer.start) transformer.start(tController); } catch (e) {}
  }

  function ByteLengthQueuingStrategy(opts) { this.highWaterMark = opts && opts.highWaterMark; }
  ByteLengthQueuingStrategy.prototype.size = function (chunk) { return chunk && chunk.byteLength || 0; };
  function CountQueuingStrategy(opts) { this.highWaterMark = opts && opts.highWaterMark; }
  CountQueuingStrategy.prototype.size = function () { return 1; };

  g.ReadableStream = ReadableStream;
  g.WritableStream = WritableStream;
  g.TransformStream = TransformStream;
  g.ByteLengthQueuingStrategy = ByteLengthQueuingStrategy;
  g.CountQueuingStrategy = CountQueuingStrategy;

  // TextEncoderStream / TextDecoderStream — TransformStreams over the global
  // TextEncoder/TextDecoder (the latter buffers split multibyte sequences via
  // its `{ stream: true }` support).
  function TextEncoderStream() {
    var enc = new TextEncoder();
    var ts = new TransformStream({
      transform: function (chunk, controller) {
        controller.enqueue(enc.encode(typeof chunk === 'string' ? chunk : String(chunk)));
      },
    });
    Object.defineProperty(this, 'readable', { value: ts.readable, enumerable: true });
    Object.defineProperty(this, 'writable', { value: ts.writable, enumerable: true });
    Object.defineProperty(this, 'encoding', { value: 'utf-8', enumerable: true });
  }
  function TextDecoderStream(label, options) {
    var dec = new TextDecoder(label || 'utf-8', options);
    var ts = new TransformStream({
      transform: function (chunk, controller) {
        var s = dec.decode(chunk, { stream: true });
        if (s) controller.enqueue(s);
      },
      flush: function (controller) {
        var s = dec.decode();
        if (s) controller.enqueue(s);
      },
    });
    Object.defineProperty(this, 'readable', { value: ts.readable, enumerable: true });
    Object.defineProperty(this, 'writable', { value: ts.writable, enumerable: true });
    Object.defineProperty(this, 'encoding', { value: dec.encoding, enumerable: true });
    Object.defineProperty(this, 'fatal', { value: dec.fatal, enumerable: true });
    Object.defineProperty(this, 'ignoreBOM', { value: dec.ignoreBOM, enumerable: true });
  }
  if (typeof g.TextEncoderStream === 'undefined') g.TextEncoderStream = TextEncoderStream;
  if (typeof g.TextDecoderStream === 'undefined') g.TextDecoderStream = TextDecoderStream;

  // CompressionStream / DecompressionStream — WHATWG TransformStreams backed by
  // node:zlib's streaming codecs. `format` is "gzip" | "deflate" | "deflate-raw".
  function zlibCodec(format, compress) {
    var zlib = require('node:zlib');
    if (format === 'gzip') return compress ? zlib.createGzip() : zlib.createGunzip();
    if (format === 'deflate') return compress ? zlib.createDeflate() : zlib.createInflate();
    if (format === 'deflate-raw') return compress ? zlib.createDeflateRaw() : zlib.createInflateRaw();
    throw new TypeError("Unsupported compression format: '" + format + "'");
  }
  function bridgeCodec(z, self) {
    var controller = null;
    z.on('data', function (d) {
      if (controller) controller.enqueue(new Uint8Array(d)); // copy out of the Buffer pool
    });
    var ts = new TransformStream({
      start: function (c) { controller = c; },
      transform: function (chunk, c) {
        controller = c;
        return new Promise(function (resolve, reject) {
          var buf = ArrayBuffer.isView(chunk)
            ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
            : Buffer.from(chunk);
          z.write(buf, function (err) { err ? reject(err) : resolve(); });
        });
      },
      flush: function (c) {
        controller = c;
        return new Promise(function (resolve, reject) {
          z.on('end', function () { resolve(); });
          z.on('error', reject);
          z.end();
        });
      },
    });
    Object.defineProperty(self, 'readable', { value: ts.readable, enumerable: true });
    Object.defineProperty(self, 'writable', { value: ts.writable, enumerable: true });
  }
  function CompressionStream(format) { bridgeCodec(zlibCodec(format, true), this); }
  function DecompressionStream(format) { bridgeCodec(zlibCodec(format, false), this); }
  if (typeof g.CompressionStream === 'undefined') g.CompressionStream = CompressionStream;
  if (typeof g.DecompressionStream === 'undefined') g.DecompressionStream = DecompressionStream;
})();

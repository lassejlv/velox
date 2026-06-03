// node:stream — a compact, practical subset of Node's streams for velox on
// bare JavaScriptCore. Implements Stream/Readable/Writable/Duplex/Transform/
// PassThrough plus pipeline() and finished().
//
// This file is a CommonJS module body wrapped by the runtime as:
//   __modules['node:stream'] = async function (module, exports, require) { ... }
// so it uses module.exports / exports and require() (no ESM syntax).

var EventEmitter = require('node:events');
var bufferMod = require('node:buffer');
var BufferImpl = (bufferMod && bufferMod.Buffer) || (typeof Buffer !== 'undefined' ? Buffer : null);

// ---------------------------------------------------------------------------
// Small async helpers. Node guarantees certain emissions (end/finish/error)
// are asynchronous; we use process.nextTick when available, else queueMicrotask.
// ---------------------------------------------------------------------------
var nextTick =
  (typeof process !== 'undefined' && process && typeof process.nextTick === 'function')
    ? function (fn, a, b, c) { process.nextTick(fn, a, b, c); }
    : (typeof queueMicrotask === 'function')
      ? function (fn, a, b, c) { queueMicrotask(function () { fn(a, b, c); }); }
      : function (fn, a, b, c) { Promise.resolve().then(function () { fn(a, b, c); }); };

function once(fn) {
  var called = false;
  return function () {
    if (called) return;
    called = true;
    return fn.apply(this, arguments);
  };
}

// Simple prototype inheritance helper (keeps EventEmitter's prototype chain).
function inherits(ctor, superCtor) {
  ctor.super_ = superCtor;
  ctor.prototype = Object.create(superCtor.prototype, {
    constructor: { value: ctor, enumerable: false, writable: true, configurable: true },
  });
}

// Coerce a chunk to the on-wire form depending on objectMode/encoding.
function toBufferOrString(chunk, encoding) {
  if (typeof chunk === 'string') {
    return BufferImpl ? BufferImpl.from(chunk, encoding || 'utf8') : chunk;
  }
  return chunk;
}

// ---------------------------------------------------------------------------
// Stream — the legacy base. Just an EventEmitter with a classic .pipe().
// ---------------------------------------------------------------------------
function Stream(opts) {
  EventEmitter.call(this);
}
inherits(Stream, EventEmitter);

// Legacy pipe (used when something is only a base Stream). Readable overrides
// this with the modern flowing implementation.
Stream.prototype.pipe = function (dest, options) {
  var source = this;
  function ondata(chunk) {
    if (dest.writable && dest.write(chunk) === false && source.pause) source.pause();
  }
  source.on('data', ondata);
  function ondrain() { if (source.readable && source.resume) source.resume(); }
  dest.on('drain', ondrain);

  if (!dest._isStdio && (!options || options.end !== false)) {
    source.on('end', onend);
  }
  var didOnEnd = false;
  function onend() {
    if (didOnEnd) return;
    didOnEnd = true;
    if (dest.end) dest.end();
  }
  function onerror(er) {
    cleanup();
    if (EventEmitter.listenerCount ? source.listenerCount('error') === 0 : true) throw er;
  }
  source.on('error', onerror);
  dest.on('error', onerror);
  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);
    source.removeListener('end', onend);
    source.removeListener('error', onerror);
    dest.removeListener('error', onerror);
    source.removeListener('end', cleanup);
    dest.removeListener('close', cleanup);
  }
  source.on('end', cleanup);
  dest.on('close', cleanup);
  dest.emit('pipe', source);
  return dest;
};

// ===========================================================================
// Readable
// ===========================================================================
function ReadableState(options, stream) {
  options = options || {};
  // The readable half honors `readableObjectMode` too — Duplex/Transform set
  // only that to make their output side object-mode (e.g. split2 emits string
  // lines via `readableObjectMode: true`). Without this, pushed strings/objects
  // get coerced to Buffers.
  this.objectMode = !!(options.objectMode || options.readableObjectMode);
  this.highWaterMark = options.highWaterMark != null
    ? options.highWaterMark
    : (this.objectMode ? 16 : 16 * 1024);
  this.buffer = [];            // queued chunks (paused mode / pre-flow)
  this.length = 0;             // bytes (or items in objectMode) buffered
  this.flowing = null;         // null = not decided, true/false otherwise
  this.ended = false;          // push(null) seen
  this.endEmitted = false;     // 'end' emitted
  this.reading = false;        // a _read() is in flight
  this.sync = true;            // inside the initial read() call
  this.needReadable = false;
  this.emittedReadable = false;
  this.readableListening = false;
  this.resumeScheduled = false;
  this.destroyed = false;
  this.errored = null;
  this.closeEmitted = false;
  this.emitClose = options.emitClose !== false;
  this.defaultEncoding = options.defaultEncoding || 'utf8';
  this.encoding = options.encoding || null;
  this.readingMore = false;
  this.dataEmitted = false;
  this.pipes = [];
}

function Readable(options) {
  if (!(this instanceof Readable)) return new Readable(options);
  Stream.call(this, options);
  this._readableState = new ReadableState(options, this);
  this.readable = true;
  if (options) {
    if (typeof options.read === 'function') this._read = options.read;
    if (typeof options.destroy === 'function') this._destroy = options.destroy;
  }
}
inherits(Readable, Stream);

// Standard Node Readable state getters libraries inspect (got, undici, etc.).
Object.defineProperties(Readable.prototype, {
  readableEnded: { configurable: true, get: function () { return this._readableState ? this._readableState.endEmitted : false; } },
  readableLength: { configurable: true, get: function () { return this._readableState ? this._readableState.length : 0; } },
  readableFlowing: {
    configurable: true,
    get: function () { return this._readableState ? this._readableState.flowing : null; },
    set: function (v) { if (this._readableState) this._readableState.flowing = v; },
  },
  readableHighWaterMark: { configurable: true, get: function () { return this._readableState ? this._readableState.highWaterMark : 16384; } },
  readableObjectMode: { configurable: true, get: function () { return !!(this._readableState && this._readableState.objectMode); } },
  // `destroyed` — true once destroy() has run (libraries check this; e.g. got).
  destroyed: {
    configurable: true,
    get: function () { return !!(this._readableState && this._readableState.destroyed); },
    set: function (v) { if (this._readableState) this._readableState.destroyed = v; },
  },
});

Readable.prototype._read = function () {
  // Default no-op; push-based sources override or just call push() externally.
};

// Decode a buffered chunk for delivery according to encoding settings.
function decodeChunk(state, chunk) {
  if (state.objectMode) return chunk;
  if (state.encoding && chunk != null && typeof chunk !== 'string') {
    // chunk is a Buffer-like; convert to string in the requested encoding.
    if (BufferImpl && typeof chunk.toString === 'function') {
      return chunk.toString(state.encoding);
    }
  }
  return chunk;
}

// push(chunk) — feed data into the readable. push(null) signals EOF.
Readable.prototype.push = function (chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, false);
};
// unshift — put a chunk back at the front of the queue.
Readable.prototype.unshift = function (chunk, encoding) {
  return readableAddChunk(this, chunk, encoding, true);
};

function readableAddChunk(stream, chunk, encoding, addToFront) {
  var state = stream._readableState;
  if (chunk === null) {
    state.reading = false;
    onEofChunk(stream, state);
    return false;
  }
  if (state.ended) return false;
  if (state.destroyed) return false;

  if (!state.objectMode) {
    if (typeof chunk === 'string') {
      chunk = BufferImpl ? BufferImpl.from(chunk, encoding || state.defaultEncoding) : chunk;
    }
  }

  state.reading = false;
  if (addToFront) {
    state.buffer.unshift(chunk);
  } else {
    state.buffer.push(chunk);
  }
  state.length += chunkLength(state, chunk);

  emitReadable(stream);
  // Node only emits 'data' synchronously on push when a 'data' listener is
  // attached; otherwise the chunk stays buffered. A consumer that resume()d but
  // hasn't yet attached its 'data' listener in the same tick (e.g. got piping a
  // response) would otherwise lose synchronously-pushed data. Defer the flow so
  // the buffered chunk drains once the listener attaches / on the next tick.
  if (state.flowing) {
    if (stream.listenerCount('data') > 0) flow(stream);
    else scheduleFlow(stream);
  }
  return state.length < state.highWaterMark;
}

// Ensure buffered data in a flowing stream gets drained on the next tick even
// if no 'data' listener was attached yet (mirrors resume()'s deferred flow).
function scheduleFlow(stream) {
  var state = stream._readableState;
  if (state.flowing && !state.resumeScheduled) {
    state.resumeScheduled = true;
    nextTick(resume_, stream, state);
  }
}

function chunkLength(state, chunk) {
  if (state.objectMode) return 1;
  if (chunk == null) return 0;
  if (typeof chunk === 'string') return chunk.length;
  if (chunk.length != null) return chunk.length;
  return 1;
}

function onEofChunk(stream, state) {
  if (state.ended) return;
  state.ended = true;
  // In flowing mode, drive the flow loop so any remaining buffer drains and
  // 'end' is emitted now — `flow()` isn't otherwise re-entered after EOF, so
  // consumers using 'data'+'end' (e.g. raw-body / express.json) would hang.
  if (state.flowing) {
    // Same rule as readableAddChunk: only drain synchronously if a 'data'
    // listener is present, else defer so a same-tick listener still sees it.
    if (stream.listenerCount('data') > 0) flow(stream);
    else scheduleFlow(stream);
  } else {
    state.needReadable = false;
    emitReadable(stream);
  }
}

// Schedule a 'readable' event and try to flow.
function emitReadable(stream) {
  var state = stream._readableState;
  if (!state.emittedReadable) {
    state.emittedReadable = true;
    nextTick(emitReadable_, stream);
  }
}
function emitReadable_(stream) {
  var state = stream._readableState;
  // Always clear the latch so a subsequent push (including EOF) can re-arm.
  state.emittedReadable = false;
  if (!state.destroyed && state.readableListening && (state.length || state.ended)) {
    stream.emit('readable');
  }
  flow(stream);
}

// Pull the next chunk (or `n` bytes) from the buffer.
Readable.prototype.read = function (n) {
  var state = this._readableState;

  if (state.length === 0 && state.ended) {
    endReadable(this);
    return null;
  }

  // Try to top up by calling _read once if nothing is buffered.
  if (state.length === 0 && !state.ended && !state.reading) {
    state.reading = true;
    var self = this;
    state.sync = true;
    try {
      this._read(state.highWaterMark);
    } catch (err) {
      errorOrDestroy(self, err);
    }
    state.sync = false;
  }

  var ret = fromList(n, state);
  if (ret !== null) {
    state.dataEmitted = true;
    this.emit('data', ret);
  } else if (state.length === 0 && state.ended) {
    endReadable(this);
  }
  return ret;
};

// Remove up to n bytes/items from the buffered list and return them.
function fromList(n, state) {
  if (state.length === 0) return null;
  var ret;
  if (state.objectMode) {
    ret = state.buffer.shift();
    state.length -= 1;
    return decodeChunk(state, ret);
  }
  if (n == null || n >= state.length) {
    // Return everything currently buffered, concatenated.
    if (state.encoding) {
      ret = state.buffer.join ? '' : '';
      // join decoded strings/buffers
      var parts = [];
      while (state.buffer.length) {
        var c = state.buffer.shift();
        parts.push(typeof c === 'string' ? c : (c.toString ? c.toString(state.encoding) : c));
      }
      ret = parts.join('');
    } else if (BufferImpl) {
      ret = state.buffer.length === 1 ? state.buffer.shift() : BufferImpl.concat(state.buffer);
      state.buffer = [];
    } else {
      ret = state.buffer.shift();
    }
    state.length = 0;
    return decodeChunk(state, ret);
  }
  // Partial read of *exactly* n bytes (buffer mode). Consume whole chunks until
  // the boundary, then slice the straddling chunk and leave its tail at the
  // front of the queue for the next read — byte-precise readers (cbor's
  // binary-parse-stream, which pulls one byte at a time) depend on this.
  var collected = [];
  var got = 0;
  while (got < n && state.buffer.length) {
    var piece = state.buffer[0];
    var need = n - got;
    if (piece.length <= need) {
      collected.push(piece);
      got += piece.length;
      state.buffer.shift();
    } else {
      collected.push(piece.slice(0, need));
      state.buffer[0] = piece.slice(need);
      got += need;
    }
  }
  state.length -= got;
  if (BufferImpl) ret = collected.length === 1 ? collected[0] : BufferImpl.concat(collected);
  else ret = collected.join('');
  return decodeChunk(state, ret);
}

Readable.prototype.setEncoding = function (enc) {
  this._readableState.encoding = enc;
  return this;
};

Readable.prototype.pause = function () {
  var state = this._readableState;
  if (state.flowing !== false) {
    state.flowing = false;
    this.emit('pause');
  }
  return this;
};

Readable.prototype.resume = function () {
  var state = this._readableState;
  if (!state.flowing) {
    // Node: resume() does NOT switch to flowing while a 'readable' listener is
    // active (the consumer drives reads via read()/'readable'). Matching this is
    // what lets clients like got — which add a 'readable' listener and then call
    // resume() — keep buffering body data for read() instead of losing it as
    // 'data' events with no 'data' listener.
    state.flowing = !state.readableListening;
    if (!state.resumeScheduled) {
      state.resumeScheduled = true;
      nextTick(resume_, this, state);
    }
  }
  return this;
};
function resume_(stream, state) {
  state.resumeScheduled = false;
  stream.emit('resume');
  flow(stream);
}

Readable.prototype.isPaused = function () {
  return this._readableState.flowing === false;
};

// Collect every chunk into an array (consumes the stream via async iteration).
Readable.prototype.toArray = function () {
  var self = this;
  return (async function () {
    var out = [];
    for await (var chunk of self) out.push(chunk);
    return out;
  })();
};

// Ask the underlying source for more data by invoking _read() once, guarded so
// we never re-enter while a read is already in flight or after EOF.
function maybeReadMore(stream) {
  var state = stream._readableState;
  if (state.reading || state.ended || state.destroyed) return;
  if (state.length >= state.highWaterMark) return;
  state.reading = true;
  try {
    stream._read(state.highWaterMark);
  } catch (err) {
    state.reading = false;
    errorOrDestroy(stream, err);
  }
}

// In flowing mode, repeatedly drain buffered chunks and emit 'data', pulling
// more from the source via _read() as needed, until paused or EOF.
function flow(stream) {
  var state = stream._readableState;
  if (!state.flowing) return;
  while (state.flowing && state.buffer.length) {
    var chunk = fromList(null, state);
    if (chunk === null) break;
    state.dataEmitted = true;
    stream.emit('data', chunk);
    // Top up the buffer for the next iteration (sources push synchronously or
    // asynchronously; async pushes re-enter flow via emitReadable/push).
    if (state.flowing && state.buffer.length === 0 && !state.ended) {
      maybeReadMore(stream);
    }
  }
  if (state.flowing && state.buffer.length === 0 && state.ended) {
    endReadable(stream);
  } else if (state.flowing && state.buffer.length === 0 && !state.ended) {
    // Nothing buffered yet — kick the source so data (or EOF) arrives later.
    maybeReadMore(stream);
  }
}

// 'data' listeners switch the stream into flowing mode.
var _origOn = Readable.prototype.on = function (ev, fn) {
  var res = EventEmitter.prototype.on.call(this, ev, fn);
  var state = this._readableState;
  if (ev === 'data') {
    if (state.flowing !== false) this.resume();
  } else if (ev === 'readable') {
    state.readableListening = true;
    // A 'readable' listener means the consumer pulls via read(); leave flowing
    // mode (unless a 'data' listener also wants it) so pushed data is buffered
    // for read() instead of being emitted as lost 'data' events. Mirrors Node's
    // updateReadableListening. Fixes got, which resume()s the response (flowing)
    // and then adds a 'readable' listener + reads via response.read().
    if (this.listenerCount('data') === 0) state.flowing = false;
    if ((state.length || state.ended) && !state.emittedReadable) {
      emitReadable(this);
    }
  }
  return res;
};
Readable.prototype.addListener = Readable.prototype.on;

// Emit 'end' exactly once, after the buffer is fully consumed.
function endReadable(stream) {
  var state = stream._readableState;
  if (!state.endEmitted && state.length === 0) {
    state.endEmitted = true;
    stream.readable = false;
    nextTick(function () {
      if (!state.closeEmitted) {
        stream.emit('end');
        // Modern streams auto-destroy after 'end' and emit 'close' (unless
        // emitClose is disabled or the stream is also a still-writable Duplex).
        if (state.emitClose !== false && !stream._writableState) {
          nextTick(function () {
            if (!state.closeEmitted) {
              state.closeEmitted = true;
              state.destroyed = true;
              stream.emit('close');
            }
          });
        }
      }
    });
  }
}

// Modern flowing pipe. Returns dest for chaining.
Readable.prototype.pipe = function (dest, options) {
  var source = this;
  var state = source._readableState;
  state.pipes.push(dest);
  var doEnd = !options || options.end !== false;

  function ondata(chunk) {
    var ret = dest.write(chunk);
    if (ret === false) {
      source.pause();
    }
  }
  source.on('data', ondata);

  function ondrain() {
    source.resume();
  }
  dest.on('drain', ondrain);

  function onend() {
    if (doEnd && dest.end) dest.end();
  }
  source.on('end', onend);

  function onerror(er) {
    cleanup();
    if (dest.listenerCount && dest.listenerCount('error') === 0) {
      errorOrDestroy(dest, er);
    }
  }
  source.on('error', onsrcerror);
  function onsrcerror(er) {
    cleanup();
    if (dest.destroy) dest.destroy(er);
  }
  dest.on('error', onerror);

  function cleanup() {
    source.removeListener('data', ondata);
    dest.removeListener('drain', ondrain);
    source.removeListener('end', onend);
    source.removeListener('error', onsrcerror);
    dest.removeListener('error', onerror);
    var idx = state.pipes.indexOf(dest);
    if (idx !== -1) state.pipes.splice(idx, 1);
  }
  dest.once('close', cleanup);
  dest.once('finish', cleanup);

  dest.emit('pipe', source);
  source.resume();
  return dest;
};

Readable.prototype.unpipe = function (dest) {
  var state = this._readableState;
  if (state.pipes.length === 0) return this;
  if (!dest) {
    var pipes = state.pipes.slice();
    state.pipes = [];
    for (var i = 0; i < pipes.length; i++) pipes[i].emit('unpipe', this);
    return this;
  }
  var idx = state.pipes.indexOf(dest);
  if (idx !== -1) {
    state.pipes.splice(idx, 1);
    dest.emit('unpipe', this);
  }
  return this;
};

Readable.prototype.destroy = function (err) {
  return destroy(this, err);
};
Readable.prototype._destroy = function (err, cb) { cb(err); };

// Async iteration: for await (const chunk of readable) { ... }
Readable.prototype[Symbol.asyncIterator] = function () {
  var stream = this;
  var state = stream._readableState;
  var error = null;
  var ended = false;
  var pending = []; // queued chunks not yet pulled by the iterator
  var resolveNext = null;
  var rejectNext = null;

  function cleanup() {
    stream.removeListener('data', onData);
    stream.removeListener('end', onEnd);
    stream.removeListener('error', onError);
    stream.removeListener('close', onEnd);
  }
  function onData(chunk) {
    if (resolveNext) {
      var r = resolveNext; resolveNext = rejectNext = null;
      r({ value: chunk, done: false });
    } else {
      pending.push(chunk);
      stream.pause();
    }
  }
  function onEnd() {
    ended = true;
    if (resolveNext) {
      var r = resolveNext; resolveNext = rejectNext = null;
      cleanup();
      r({ value: undefined, done: true });
    }
  }
  function onError(err) {
    error = err;
    if (rejectNext) {
      var rj = rejectNext; resolveNext = rejectNext = null;
      cleanup();
      rj(err);
    }
  }
  stream.on('data', onData);
  stream.on('end', onEnd);
  stream.on('close', onEnd);
  stream.on('error', onError);

  return {
    next: function () {
      if (pending.length) {
        var v = pending.shift();
        stream.resume();
        return Promise.resolve({ value: v, done: false });
      }
      if (error) { cleanup(); return Promise.reject(error); }
      if (ended) { cleanup(); return Promise.resolve({ value: undefined, done: true }); }
      return new Promise(function (resolve, reject) {
        resolveNext = resolve;
        rejectNext = reject;
        stream.resume();
      });
    },
    return: function (value) {
      cleanup();
      if (stream.destroy) stream.destroy();
      return Promise.resolve({ value: value, done: true });
    },
    throw: function (err) {
      cleanup();
      if (stream.destroy) stream.destroy(err);
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]: function () { return this; },
  };
};

// Readable.from(iterable | asyncIterable) — build a readable that pulls from it.
Readable.from = function (iterable, opts) {
  opts = opts || {};
  if (opts.objectMode === undefined) opts.objectMode = true;
  var r = new Readable(opts);
  var iterator;
  if (iterable && typeof iterable[Symbol.asyncIterator] === 'function') {
    iterator = iterable[Symbol.asyncIterator]();
  } else if (iterable && typeof iterable[Symbol.iterator] === 'function') {
    iterator = iterable[Symbol.iterator]();
  } else {
    throw new TypeError('Readable.from requires an iterable');
  }
  var reading = false;
  // Each _read() pulls exactly one item from the iterator and pushes it. The
  // readable state machine calls _read again whenever it wants more, so we do
  // not self-loop here (that keeps backpressure honest for async iterators).
  r._read = function () {
    if (reading) return;
    reading = true;
    Promise.resolve(iterator.next()).then(function (res) {
      reading = false;
      if (r._readableState.destroyed) return;
      if (res.done) {
        r.push(null);
      } else {
        r.push(res.value);
      }
    }, function (err) {
      reading = false;
      errorOrDestroy(r, err);
    });
  };
  return r;
};

// Static stream-state predicates (Node 16.8+). @hono/node-server probes
// `Readable.isDisturbed(req)` before reading a request body; others check
// isErrored/isReadable. Duck-type via the readable state, with a fallback for
// foreign stream objects.
Readable.isDisturbed = function (stream) {
  if (!stream) return false;
  var s = stream._readableState;
  if (s) return !!(s.dataEmitted || s.endEmitted || s.destroyed);
  return !!(stream.readableDidRead || stream.destroyed);
};
Readable.isErrored = function (stream) {
  if (!stream) return false;
  var s = stream._readableState;
  return !!(s ? s.errored : stream.errored);
};
Readable.isReadable = function (stream) {
  if (!stream) return false;
  var s = stream._readableState;
  if (s) return !!(stream.readable && !s.endEmitted && !s.destroyed);
  return !!stream.readable;
};

// ===========================================================================
// Writable
// ===========================================================================
function WritableState(options, stream) {
  options = options || {};
  // Symmetric to ReadableState: the writable half honors `writableObjectMode`.
  this.objectMode = !!(options.objectMode || options.writableObjectMode);
  this.highWaterMark = options.highWaterMark != null
    ? options.highWaterMark
    : (this.objectMode ? 16 : 16 * 1024);
  this.length = 0;             // bytes buffered + in-flight
  this.writing = false;        // a _write() is in flight
  this.corked = 0;
  this.buffered = [];          // queued writes while writing/corked
  this.needDrain = false;
  this.ending = false;         // end() called
  this.ended = false;          // end() processing done
  this.finished = false;       // 'finish' emitted
  this.destroyed = false;
  this.errored = null;
  this.defaultEncoding = options.defaultEncoding || 'utf8';
  this.closeEmitted = false;
  this.emitClose = options.emitClose !== false;
  this.prefinished = false;
}

function Writable(options) {
  if (!(this instanceof Writable) && !(this instanceof Duplex)) return new Writable(options);
  Stream.call(this, options);
  this._writableState = new WritableState(options, this);
  this.writable = true;
  if (options) {
    if (typeof options.write === 'function') this._write = options.write;
    if (typeof options.writev === 'function') this._writev = options.writev;
    if (typeof options.final === 'function') this._final = options.final;
    if (typeof options.destroy === 'function') this._destroy = options.destroy;
  }
}
inherits(Writable, Stream);

Writable.prototype._write = function (chunk, encoding, cb) {
  cb(new Error('_write() is not implemented'));
};
Writable.prototype._destroy = function (err, cb) { cb(err); };

Writable.prototype.write = function (chunk, encoding, cb) {
  if (typeof encoding === 'function') { cb = encoding; encoding = null; }
  var state = this._writableState;

  if (state.ending || state.ended) {
    var er = new Error('write after end');
    nextTick(function () { if (cb) cb(er); });
    errorOrDestroy(this, er);
    return false;
  }
  if (state.destroyed) {
    if (cb) nextTick(cb, new Error('Cannot call write after a stream was destroyed'));
    return false;
  }

  if (!state.objectMode) {
    chunk = toBufferOrString(chunk, encoding || state.defaultEncoding);
  }

  var len = state.objectMode ? 1 : (chunk && chunk.length != null ? chunk.length : 0);
  state.length += len;
  var ret = state.length < state.highWaterMark;
  if (!ret) state.needDrain = true;

  if (state.writing || state.corked) {
    state.buffered.push({ chunk: chunk, encoding: encoding, callback: cb, len: len });
  } else {
    doWrite(this, state, chunk, encoding, len, cb);
  }
  return ret;
};

function doWrite(stream, state, chunk, encoding, len, cb) {
  state.writing = true;
  var finished = false;
  stream._write(chunk, encoding, function (err) {
    if (finished) return; // guard against double-callback
    finished = true;
    state.writing = false;
    state.length -= len;
    if (cb) cb(err);
    if (err) {
      errorOrDestroy(stream, err);
      return;
    }
    afterWrite(stream, state);
  });
}

function afterWrite(stream, state) {
  // Drain queued writes (respecting cork).
  if (state.buffered.length && !state.corked) {
    var entry = state.buffered.shift();
    doWrite(stream, state, entry.chunk, entry.encoding, entry.len, entry.callback);
    return;
  }
  // Emit 'drain' when buffer empties after backpressure.
  if (state.needDrain && state.length === 0 && !state.writing) {
    state.needDrain = false;
    stream.emit('drain');
  }
  // If end() was requested and everything flushed, finish up.
  if (state.ending && state.length === 0 && state.buffered.length === 0 && !state.writing) {
    finishMaybe(stream, state);
  }
}

Writable.prototype.cork = function () {
  this._writableState.corked++;
};

Writable.prototype.uncork = function () {
  var state = this._writableState;
  if (state.corked) {
    state.corked--;
    if (!state.corked && !state.writing && state.buffered.length) {
      var entry = state.buffered.shift();
      doWrite(this, state, entry.chunk, entry.encoding, entry.len, entry.callback);
    }
  }
};

Writable.prototype.end = function (chunk, encoding, cb) {
  if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = null; }
  else if (typeof encoding === 'function') { cb = encoding; encoding = null; }
  var state = this._writableState;

  if (chunk !== null && chunk !== undefined) {
    this.write(chunk, encoding);
  }
  if (cb) {
    if (state.finished) nextTick(cb);
    else this.once('finish', cb);
  }
  if (!state.ending) {
    state.ending = true;
    finishMaybe(this, state);
  }
  return this;
};

// When the write buffer is empty and end() was called, run _final then 'finish'.
// 'prefinish' fires first (Transform uses it to run _flush / EOF its read side).
function finishMaybe(stream, state) {
  if (state.finished) return;
  if (state.length !== 0 || state.writing || state.buffered.length !== 0) return;
  if (!state.ending) return;
  if (state.prefinished) return;
  state.prefinished = true;

  function doFinish() {
    state.ended = true;
    if (!state.finished) {
      state.finished = true;
      stream.writable = false;
      stream.emit('finish');
      // Modern writables auto-destroy after 'finish' and emit 'close' — but a
      // Duplex whose readable side hasn't ended yet must wait (its readable
      // end-path emits the single shared 'close').
      if (state.emitClose && !state.closeEmitted) {
        var rState = stream._readableState;
        if (!rState || rState.endEmitted || rState.closeEmitted) {
          nextTick(function () {
            if (!state.closeEmitted) {
              state.closeEmitted = true;
              state.destroyed = true;
              stream.emit('close');
            }
          });
        }
      }
    }
  }

  nextTick(function () {
    stream.emit('prefinish');
    if (typeof stream._final === 'function') {
      stream._final(function (err) {
        if (err) { errorOrDestroy(stream, err); return; }
        doFinish();
      });
    } else {
      doFinish();
    }
  });
}

Writable.prototype.destroy = function (err) {
  return destroy(this, err);
};

// ===========================================================================
// Shared destroy logic (used by Readable, Writable, Duplex).
// ===========================================================================
function destroy(stream, err) {
  var rState = stream._readableState;
  var wState = stream._writableState;
  if ((rState && rState.destroyed) || (wState && wState.destroyed)) {
    return stream;
  }
  if (rState) rState.destroyed = true;
  if (wState) wState.destroyed = true;
  stream.readable = false;
  stream.writable = false;

  var cb = function (er) {
    if (er) {
      errorEmit(stream, er);
    }
    if (rState) rState.closeEmitted = true;
    if (wState) wState.closeEmitted = true;
    nextTick(function () { stream.emit('close'); });
  };

  if (typeof stream._destroy === 'function') {
    stream._destroy(err || null, cb);
  } else {
    cb(err);
  }
  return stream;
}

function errorEmit(stream, err) {
  nextTick(function () { stream.emit('error', err); });
}

// errorOrDestroy — emit 'error' (and destroy if applicable).
function errorOrDestroy(stream, err) {
  var rState = stream._readableState;
  var wState = stream._writableState;
  if ((rState && rState.destroyed) || (wState && wState.destroyed)) return;
  if (rState) rState.errored = err;
  if (wState) wState.errored = err;
  destroy(stream, err);
}

// ===========================================================================
// Duplex — readable + writable. Inherits Readable; mixes in Writable.
// ===========================================================================
function Duplex(options) {
  if (!(this instanceof Duplex)) return new Duplex(options);
  Readable.call(this, options);
  Writable.call(this, options);
  this.allowHalfOpen = options && options.allowHalfOpen !== undefined
    ? options.allowHalfOpen : true;

  // When the writable side finishes and we don't allow half-open, end readable.
  var self = this;
  this.once('finish', function () {
    if (!self.allowHalfOpen) {
      // nothing buffered to read => push EOF
      if (!self._readableState.ended) self.push(null);
    }
  });
}
inherits(Duplex, Readable);

// Mix Writable's own prototype methods onto Duplex (Readable already on chain).
(function mixinWritable() {
  var keys = Object.getOwnPropertyNames(Writable.prototype);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    if (k === 'constructor') continue;
    if (Duplex.prototype[k] === undefined) {
      Duplex.prototype[k] = Writable.prototype[k];
    }
  }
})();
// destroy on a Duplex must tear down both halves; use the shared destroy.
Duplex.prototype.destroy = function (err) { return destroy(this, err); };
Duplex.prototype._destroy = function (err, cb) { cb(err); };

// --- Web Streams interop (Readable/Writable/Duplex .fromWeb/.toWeb) ---------
// Bridge WHATWG ReadableStream/WritableStream <-> Node streams. Used by
// libraries like execa (Duplex.fromWeb over a TransformStream).
Readable.fromWeb = function (readableStream, options) {
  options = options || {};
  var reader = readableStream.getReader();
  var r = new Readable({
    objectMode: options.objectMode,
    highWaterMark: options.highWaterMark,
    read: function () {
      var self = this;
      reader.read().then(function (res) {
        if (res.done) self.push(null);
        else self.push(res.value);
      }, function (err) { self.destroy(err); });
    },
    destroy: function (err, cb) {
      reader.cancel(err).then(function () { cb(err); }, function () { cb(err); });
    },
  });
  return r;
};
Writable.fromWeb = function (writableStream, options) {
  options = options || {};
  var writer = writableStream.getWriter();
  return new Writable({
    objectMode: options.objectMode,
    highWaterMark: options.highWaterMark,
    write: function (chunk, enc, cb) { writer.write(chunk).then(function () { cb(); }, cb); },
    final: function (cb) { writer.close().then(function () { cb(); }, cb); },
    destroy: function (err, cb) { writer.abort(err).then(function () { cb(err); }, function () { cb(err); }); },
  });
};
Duplex.fromWeb = function (pair, options) {
  options = options || {};
  var reader = pair.readable.getReader();
  var writer = pair.writable.getWriter();
  var d = new Duplex({
    objectMode: options.objectMode,
    highWaterMark: options.highWaterMark,
    allowHalfOpen: options.allowHalfOpen,
    write: function (chunk, enc, cb) { writer.write(chunk).then(function () { cb(); }, cb); },
    final: function (cb) { writer.close().then(function () { cb(); }, cb); },
    read: function () {
      var self = this;
      reader.read().then(function (res) {
        if (res.done) self.push(null);
        else self.push(res.value);
      }, function (err) { self.destroy(err); });
    },
    destroy: function (err, cb) {
      Promise.all([
        reader.cancel(err).catch(function () {}),
        writer.abort(err).catch(function () {}),
      ]).then(function () { cb(err); });
    },
  });
  return d;
};
// Convert a Node Readable into a WHATWG ReadableStream.
Readable.prototype.toWeb = function () {
  var stream = this;
  return new globalThis.ReadableStream({
    start: function (controller) {
      stream.on('data', function (chunk) { controller.enqueue(chunk); });
      stream.on('end', function () { try { controller.close(); } catch (e) {} });
      stream.on('error', function (err) { controller.error(err); });
    },
    cancel: function () { stream.destroy(); },
  });
};
Writable.prototype.toWeb = function () {
  var stream = this;
  return new globalThis.WritableStream({
    write: function (chunk) { return new Promise(function (res, rej) { stream.write(chunk, function (e) { e ? rej(e) : res(); }); }); },
    close: function () { return new Promise(function (res) { stream.end(res); }); },
    abort: function (err) { stream.destroy(err); },
  });
};

// --- Static .toWeb forms (Node exposes these as static methods too) ---------
// `Readable.toWeb(nodeReadable)` converts a Node Readable into a WHATWG
// ReadableStream. Data/end/error are wired through; pause/resume drives basic
// backpressure (we resume only when the web consumer pulls).
Readable.toWeb = function (nodeReadable, options) {
  return new globalThis.ReadableStream({
    start: function (controller) {
      nodeReadable.on('data', function (chunk) {
        controller.enqueue(
          (chunk instanceof Uint8Array) ? chunk
            : (BufferImpl ? BufferImpl.from(chunk) : chunk)
        );
        // Backpressure: if the web side's queue is full, pause the Node side.
        if (controller.desiredSize != null && controller.desiredSize <= 0) {
          if (nodeReadable.pause) nodeReadable.pause();
        }
      });
      nodeReadable.on('end', function () { try { controller.close(); } catch (e) {} });
      nodeReadable.on('error', function (err) { controller.error(err); });
    },
    pull: function () {
      if (nodeReadable.resume) nodeReadable.resume();
    },
    cancel: function () {
      if (nodeReadable.destroy) nodeReadable.destroy();
    },
  });
};
// `Writable.toWeb(nodeWritable)` -> WHATWG WritableStream.
Writable.toWeb = function (nodeWritable) {
  return new globalThis.WritableStream({
    write: function (chunk) { return new Promise(function (res, rej) { nodeWritable.write(chunk, function (e) { e ? rej(e) : res(); }); }); },
    close: function () { return new Promise(function (res) { nodeWritable.end(res); }); },
    abort: function (err) { if (nodeWritable.destroy) nodeWritable.destroy(err); },
  });
};
// `Duplex.toWeb(nodeDuplex)` -> `{ readable, writable }` pair of web streams.
Duplex.toWeb = function (nodeDuplex) {
  return {
    readable: Readable.toWeb(nodeDuplex),
    writable: Writable.toWeb(nodeDuplex),
  };
};

// --- Duplex.from(source) ----------------------------------------------------
// Build a Duplex from various sources, matching Node's Duplex.from:
//   - an async-generator function or a function returning an async iterable
//     -> readable side yields from it (writable side is a no-op sink),
//   - a `{ readable, writable }` pair (two streams) -> composed into one Duplex,
//   - a Readable -> readable side is it (writable side is a no-op sink),
//   - an async iterable / array -> like Readable.from but as a Duplex,
//   - a Promise -> resolve, then treat the result.
Duplex.from = function (source) {
  // Promise: defer until it resolves, bridging through a PassThrough so the
  // returned object is synchronously a Duplex.
  if (source && typeof source.then === 'function') {
    var holder = new PassThrough({ objectMode: true });
    Promise.resolve(source).then(function (resolved) {
      var inner = Duplex.from(resolved);
      // Pipe the resolved duplex's readable side into the holder.
      if (inner && inner.on) {
        inner.on('data', function (c) { holder.push(c); });
        inner.on('end', function () { holder.push(null); });
        inner.on('error', function (e) { errorOrDestroy(holder, e); });
      } else {
        holder.push(null);
      }
    }, function (err) { errorOrDestroy(holder, err); });
    return holder;
  }

  // `{ readable, writable }` pair -> compose into one Duplex. Delegate to the
  // existing compose() which already pipelines a writable feed into a readable
  // drain (here the two halves are independent streams).
  if (source && (source.readable || source.writable) &&
      typeof source !== 'function' &&
      (isStreamLike(source.readable) || isStreamLike(source.writable))) {
    return duplexFromPair(source.writable, source.readable);
  }

  // Function: call it. An async-generator function (or any function returning
  // an async iterable) drives the readable side; the writable side is a sink.
  if (typeof source === 'function') {
    var produced = source();
    return Duplex.from(produced);
  }

  // A Node Readable (or Duplex) -> readable side is it; writable side is a sink.
  if (source && source._readableState && typeof source.pipe === 'function') {
    return duplexFromPair(null, source);
  }

  // An async iterable / sync iterable / array -> like Readable.from, as Duplex.
  if (source && (typeof source[Symbol.asyncIterator] === 'function' ||
                 typeof source[Symbol.iterator] === 'function')) {
    return duplexFromReadable(Readable.from(source));
  }

  throw new TypeError('Duplex.from: unsupported source');
};

function isStreamLike(x) {
  return !!(x && (x._readableState || x._writableState ||
    typeof x.pipe === 'function' || typeof x.write === 'function' ||
    typeof x.getReader === 'function' || typeof x.getWriter === 'function'));
}

// Duplex whose readable side mirrors `readable` and whose writable side is a
// no-op sink (used for the Readable / async-iterable cases).
function duplexFromReadable(readable) {
  var d = new Duplex({ objectMode: true });
  d._read = function () {};
  d._write = function (chunk, enc, cb) { cb(); }; // sink
  d._final = function (cb) { cb(); };
  readable.on('data', function (c) { d.push(c); });
  readable.on('end', function () { d.push(null); });
  readable.on('error', function (e) { errorOrDestroy(d, e); });
  return d;
}

// Compose a `{ writable, readable }` pair into one Duplex: writes go to the
// `writable` stream, reads come from the `readable` stream. Either may be a
// Node stream or a WHATWG web stream (coerced via fromWeb).
function duplexFromPair(writable, readable) {
  if (writable && typeof writable.getWriter === 'function') {
    writable = Writable.fromWeb(writable);
  }
  if (readable && typeof readable.getReader === 'function') {
    readable = Readable.fromWeb(readable);
  }
  var d = new Duplex({ objectMode: true });
  d._read = function () {};
  d._write = function (chunk, enc, cb) {
    if (!writable) { cb(); return; }
    if (writable.write(chunk) === false) writable.once('drain', cb);
    else cb();
  };
  d._final = function (cb) {
    if (writable && writable.end) writable.end();
    cb();
  };
  if (readable) {
    readable.on('data', function (c) { d.push(c); });
    readable.on('end', function () { d.push(null); });
    readable.on('error', function (e) { errorOrDestroy(d, e); });
  } else {
    // No readable side: EOF the readable half immediately.
    d.push(null);
  }
  if (writable) {
    writable.on('error', function (e) { errorOrDestroy(d, e); });
  }
  return d;
};

// ===========================================================================
// Transform — Duplex where writes pass through _transform into the readable.
// ===========================================================================
function Transform(options) {
  if (!(this instanceof Transform)) return new Transform(options);
  Duplex.call(this, options);

  this._transformState = {
    transforming: false,
    writecb: null,
  };

  if (options) {
    if (typeof options.transform === 'function') this._transform = options.transform;
    if (typeof options.flush === 'function') this._flush = options.flush;
  }

}
inherits(Transform, Duplex);

// The writable side's _final runs the optional _flush, pushes any trailing
// data, then EOFs the readable side with push(null). Running this from _final
// guarantees ordering: prefinish -> flush -> 'finish' on the writable side, and
// the readable side's 'end' follows once buffered output is consumed.
Transform.prototype._final = function (cb) {
  var self = this;
  if (typeof this._flush === 'function') {
    this._flush(function (err, data) {
      if (err) { cb(err); return; }
      if (data != null) self.push(data);
      self.push(null);
      cb();
    });
  } else {
    this.push(null);
    cb();
  }
};

Transform.prototype._transform = function (chunk, encoding, cb) {
  cb(null, chunk); // identity by default
};
Transform.prototype._flush = undefined;

// The writable side of a Transform feeds _transform; pushed data flows to read.
Transform.prototype._write = function (chunk, encoding, cb) {
  var ts = this._transformState;
  var self = this;
  ts.transforming = true;
  ts.writecb = cb;
  this._transform(chunk, encoding, function (err, val) {
    ts.transforming = false;
    var wcb = ts.writecb;
    ts.writecb = null;
    if (err) { if (wcb) wcb(err); return; }
    if (val != null) self.push(val);
    if (wcb) wcb();
  });
};

// Transform uses the standard Writable.end() path; finishMaybe emits
// 'prefinish' which our _final hooks for _flush + readable-side EOF.

// Provide a no-op _read; data arrives via push() from _transform.
Transform.prototype._read = function () {};

// ===========================================================================
// PassThrough — identity Transform.
// ===========================================================================
function PassThrough(options) {
  if (!(this instanceof PassThrough)) return new PassThrough(options);
  Transform.call(this, options);
}
inherits(PassThrough, Transform);
PassThrough.prototype._transform = function (chunk, encoding, cb) {
  cb(null, chunk);
};

// ===========================================================================
// finished(stream, [opts], cb) — call cb when the stream ends/finishes/errors.
// ===========================================================================
function finished(stream, opts, callback) {
  if (typeof opts === 'function') { callback = opts; opts = {}; }
  opts = opts || {};
  var cb = once(callback);

  var writableFinished = false;
  var readableEnded = false;

  var wState = stream._writableState;
  var rState = stream._readableState;
  var isWritable = !!wState && opts.writable !== false;
  var isReadable = !!rState && opts.readable !== false;

  function onfinish() {
    writableFinished = true;
    check();
  }
  function onend() {
    readableEnded = true;
    check();
  }
  function onerror(err) {
    cleanup();
    cb(err);
  }
  function onclose() {
    cleanup();
    // If neither side completed, surface a premature close error.
    var wDone = !isWritable || writableFinished || (wState && wState.finished);
    var rDone = !isReadable || readableEnded || (rState && rState.endEmitted);
    if (wDone && rDone) cb(null);
    else cb(makePrematureClose());
  }
  function check() {
    var wDone = !isWritable || writableFinished || (wState && wState.finished);
    var rDone = !isReadable || readableEnded || (rState && rState.endEmitted);
    if (wDone && rDone) {
      cleanup();
      cb(null);
    }
  }
  function cleanup() {
    stream.removeListener('finish', onfinish);
    stream.removeListener('end', onend);
    stream.removeListener('error', onerror);
    stream.removeListener('close', onclose);
  }

  if (isWritable) stream.on('finish', onfinish);
  if (isReadable) stream.on('end', onend);
  stream.on('error', onerror);
  stream.on('close', onclose);

  // Already-done fast path.
  if ((wState && wState.finished) || (rState && rState.endEmitted)) {
    nextTick(check);
  }

  return function () { cleanup(); };
}

function makePrematureClose() {
  var e = new Error('Premature close');
  e.code = 'ERR_STREAM_PREMATURE_CLOSE';
  return e;
}

// ===========================================================================
// pipeline(...streams, [cb]) — chain streams, propagate errors/cleanup.
// ===========================================================================
function pipeline() {
  var streams = Array.prototype.slice.call(arguments);
  var callback;
  if (typeof streams[streams.length - 1] === 'function') {
    callback = streams.pop();
  }
  callback = once(callback || function () {});

  if (streams.length < 2) {
    nextTick(callback, new TypeError('pipeline requires at least 2 streams'));
    return streams[streams.length - 1];
  }

  var last = streams[streams.length - 1];
  var finishCount = 0;
  var error = null;
  var destroys = [];

  function onComplete(err) {
    if (err && !error) {
      error = err;
      // Destroy all the others.
      for (var i = 0; i < destroys.length; i++) destroys[i](err);
      callback(err);
      return;
    }
    finishCount--;
    if (finishCount <= 0) {
      callback(error || null);
    }
  }

  // Wire each adjacent pair with .pipe and watch completion via finished().
  for (var i = 0; i < streams.length; i++) {
    var stream = streams[i];
    var reading = i < streams.length - 1;
    var writing = i > 0;

    (function (stream, reading, writing) {
      destroys.push(function (err) {
        if (stream.destroy) stream.destroy(err);
      });
      finishCount++;
      finished(stream, { readable: reading, writable: writing }, function (err) {
        onComplete(err);
      });
    })(stream, reading, writing);

    if (i < streams.length - 1) {
      streams[i].pipe(streams[i + 1]);
    }
  }

  return last;
}

// ===========================================================================
// Exports
// ===========================================================================
Stream.Stream = Stream;
Stream.Readable = Readable;
Stream.Writable = Writable;
Stream.Duplex = Duplex;
Stream.Transform = Transform;
Stream.PassThrough = PassThrough;
Stream.pipeline = pipeline;
Stream.finished = finished;
Stream.compose = compose;

// Promise-based variants.
function pipelinePromise() {
  var args = Array.prototype.slice.call(arguments);
  return new Promise(function (resolve, reject) {
    args.push(function (err, val) {
      if (err) reject(err);
      else resolve(val);
    });
    pipeline.apply(null, args);
  });
}
function finishedPromise(stream, opts) {
  return new Promise(function (resolve, reject) {
    finished(stream, opts || {}, function (err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

// ===========================================================================
// compose(...streams) — chain streams/functions into a single Duplex whose
// writable side feeds the first stage and whose readable side is the last
// stage. Each argument may be a stream object (Readable/Writable/Duplex/
// Transform) or an async-generator function `(source) => asyncIterable` that
// transforms the previous stage's output into the next stage's input. The
// returned Duplex pipelines all stages together (errors propagate via the
// shared pipeline()).
// ===========================================================================

// Turn one compose() argument into a Duplex-ish stream. A function argument
// becomes a Transform: its writable side is buffered into an async iterable
// that's handed to the generator, and the generator's yielded values feed the
// Duplex's readable side via Readable.from.
function composeStageFromFunction(fn) {
  // Source: an async iterable that yields each chunk written to `input` and
  // completes when the writable side ends. A small promise-based queue bridges
  // the (push-based) writable callbacks to the (pull-based) async iterator.
  var queue = [];
  var pendingResolve = null;
  var ended = false;
  var errored = null;

  function pushChunk(chunk) {
    if (pendingResolve) {
      var r = pendingResolve;
      pendingResolve = null;
      r({ value: chunk, done: false });
    } else {
      queue.push(chunk);
    }
  }
  function finish() {
    ended = true;
    if (pendingResolve) {
      var r = pendingResolve;
      pendingResolve = null;
      r({ value: undefined, done: true });
    }
  }

  var source = {};
  source[Symbol.asyncIterator] = function () {
    return {
      next: function () {
        if (errored) return Promise.reject(errored);
        if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
        if (ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise(function (resolve) { pendingResolve = resolve; });
      },
    };
  };

  // The generator's output is a readable; the writable half collects input.
  var out = Readable.from(fn(source));
  var stage = new Duplex({ objectMode: true });
  stage._write = function (chunk, enc, cb) { pushChunk(chunk); cb(); };
  stage._final = function (cb) { finish(); cb(); };
  stage._read = function () {};
  // Forward the generator output to the Duplex's readable side.
  out.on('data', function (chunk) { stage.push(chunk); });
  out.on('end', function () { stage.push(null); });
  out.on('error', function (err) { errored = err; errorOrDestroy(stage, err); });
  return stage;
}

function composeStage(arg) {
  if (typeof arg === 'function') return composeStageFromFunction(arg);
  return arg; // already a stream object — use as-is.
}

function compose() {
  var args = Array.prototype.slice.call(arguments);
  if (args.length === 0) {
    throw new TypeError('compose requires at least one stream');
  }

  var stages = args.map(composeStage);

  // Entry writable: feeds the first stage. Exit readable: the last stage.
  var entry = new PassThrough({ objectMode: true });
  var exit = new PassThrough({ objectMode: true });

  // Pipeline every stage between the entry (writable feed) and exit (readable
  // drain): pipeline(entry, ...stages, exit).
  var chain = [entry].concat(stages).concat([exit]);
  pipeline.apply(null, chain.concat([function (err) {
    if (err) errorOrDestroy(result, err);
  }]));

  // The public Duplex: writes go to `entry`, reads come from `exit`.
  var result = new Duplex({ objectMode: true });
  result._write = function (chunk, enc, cb) {
    if (!entry.write(chunk)) entry.once('drain', cb);
    else cb();
  };
  result._final = function (cb) { entry.end(); cb(); };
  result._read = function () {};
  exit.on('data', function (chunk) { result.push(chunk); });
  exit.on('end', function () { result.push(null); });
  exit.on('error', function (err) { errorOrDestroy(result, err); });
  return result;
}

module.exports = Stream;
module.exports.Stream = Stream;
module.exports.Readable = Readable;
module.exports.Writable = Writable;
module.exports.Duplex = Duplex;
module.exports.Transform = Transform;
module.exports.PassThrough = PassThrough;
module.exports.pipeline = pipeline;
module.exports.finished = finished;
module.exports.compose = compose;
module.exports.promises = { pipeline: pipelinePromise, finished: finishedPromise };

// Stream state predicates (Node 16+). undici and other libraries use
// `stream.isDisturbed(body)` to decide whether a body can still be consumed.
function isDisturbed(stream) {
  if (!stream) return false;
  var rs = stream._readableState;
  return !!(stream.readableDidRead || stream.readableAborted || stream.bytesRead > 0 || (rs && (rs.dataEmitted || rs.endEmitted)) || stream.writableEnded);
}
function isErrored(stream) {
  if (!stream) return false;
  return !!(stream.errored || (stream._readableState && stream._readableState.errored) || (stream._writableState && stream._writableState.errored));
}
function isReadable(stream) {
  if (!stream || stream.readable === false) return false;
  var rs = stream._readableState;
  if (rs) return !rs.destroyed && !rs.errored && !rs.endEmitted;
  return typeof stream.read === 'function' && stream.readable !== false;
}
function isWritable(stream) {
  if (!stream || stream.writable === false) return false;
  var ws = stream._writableState;
  if (ws) return !ws.destroyed && !ws.errored && !ws.ending && !ws.ended;
  return typeof stream.write === 'function' && stream.writable !== false;
}
// addAbortSignal(signal, stream) — destroy the stream when the signal aborts.
function addAbortSignal(signal, stream) {
  if (!signal) return stream;
  var onAbort = function () {
    try { stream.destroy(signal.reason || new Error('The operation was aborted')); } catch (e) {}
  };
  if (signal.aborted) { onAbort(); return stream; }
  if (typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
  return stream;
}
module.exports.addAbortSignal = addAbortSignal;
exports.addAbortSignal = addAbortSignal;
module.exports.isDisturbed = isDisturbed;
module.exports.isErrored = isErrored;
module.exports.isReadable = isReadable;
module.exports.isWritable = isWritable;
exports.isDisturbed = isDisturbed;
exports.isErrored = isErrored;
exports.isReadable = isReadable;
exports.isWritable = isWritable;

// Node's `stream` module re-exports EventEmitter (Stream's base class); some
// libraries do `class X extends require('stream').EventEmitter` (e.g. node-cron).
module.exports.EventEmitter = EventEmitter;
exports.EventEmitter = EventEmitter;

// Default highWaterMark accessors (Node 19+). Byte mode: 64 KiB; objectMode: 16.
var defaultHWM = 64 * 1024;
var defaultHWMObject = 16;
function getDefaultHighWaterMark(objectMode) { return objectMode ? defaultHWMObject : defaultHWM; }
function setDefaultHighWaterMark(objectMode, value) { if (objectMode) defaultHWMObject = value; else defaultHWM = value; }
module.exports.getDefaultHighWaterMark = getDefaultHighWaterMark;
module.exports.setDefaultHighWaterMark = setDefaultHighWaterMark;
exports.getDefaultHighWaterMark = getDefaultHighWaterMark;
exports.setDefaultHighWaterMark = setDefaultHighWaterMark;

// Named exports on `exports` too (some bundlers read these).
exports.Stream = Stream;
exports.Readable = Readable;
exports.Writable = Writable;
exports.Duplex = Duplex;
exports.Transform = Transform;
exports.PassThrough = PassThrough;
exports.pipeline = pipeline;
exports.finished = finished;
exports.compose = compose;

module.exports.default = module.exports;

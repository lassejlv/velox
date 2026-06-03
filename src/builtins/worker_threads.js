// node:worker_threads — real OS-thread workers backed by native hooks. Each
// Worker runs its entry on its own thread with an independent JSContext + event
// loop; messages cross as JSON (structured-clone-ish) over native channels.

var EventEmitter = require('events').EventEmitter;

var isWorker = !!globalThis.__velox_is_worker;

// Structured(ish) clone that transfers SharedArrayBuffers by *reference*: a SAB
// becomes `{__velox_sab_ref: id}` (its shared region id), retained across the
// in-flight transfer and revived on the other thread over the same memory.
function serialize(value) {
  return JSON.stringify(value, function (key, v) {
    if (v && typeof v === 'object' && v.__velox_shared_id !== undefined &&
        typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer) {
      if (typeof __velox_shared_retain === 'function') __velox_shared_retain(v.__velox_shared_id);
      return { __velox_sab_ref: v.__velox_shared_id };
    }
    return v;
  });
}
function deserialize(json) {
  if (json === undefined) return undefined;
  return JSON.parse(json, function (key, v) {
    if (v && typeof v === 'object' && v.__velox_sab_ref !== undefined) {
      var id = v.__velox_sab_ref;
      var buf = (typeof SharedArrayBuffer !== 'undefined' && SharedArrayBuffer.__veloxRevive)
        ? SharedArrayBuffer.__veloxRevive(id) : null;
      if (typeof __velox_shared_release === 'function') __velox_shared_release(id);
      return buf;
    }
    return v;
  });
}

// --- main-thread side: the Worker class ------------------------------------

var workers = new Map();

function Worker(filename, options) {
  EventEmitter.call(this);
  options = options || {};
  var isFile = !options.eval;
  var source = String(filename);
  // The worker-data payload carries an envelope: the user's workerData plus
  // the stdio flags, so the worker side knows to wire its process streams.
  var stdio = {
    stdin: !!options.stdin,
    stdout: !!options.stdout,
    stderr: !!options.stderr,
  };
  var dataJson = serialize({
    __velox_env: { stdio: stdio },
    data: options.workerData === undefined ? null : options.workerData,
  });
  this.threadId = __velox_spawn_worker(source, isFile, dataJson);
  this._exited = false;

  // worker.stdout/stderr: Readables fed by internal stdio envelopes from the
  // worker; worker.stdin: a Writable whose chunks cross as base64 envelopes.
  var stream = require('node:stream');
  var self = this;
  this.stdout = stdio.stdout ? new stream.Readable({ read: function () {} }) : null;
  this.stderr = stdio.stderr ? new stream.Readable({ read: function () {} }) : null;
  this.stdin = stdio.stdin
    ? new stream.Writable({
        write: function (chunk, enc, cb) {
          var buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, enc);
          self.postMessage({ __velox_stdio: 'stdin', data: buf.toString('base64') });
          cb();
        },
        final: function (cb) {
          self.postMessage({ __velox_stdio: 'stdin_end' });
          cb();
        },
      })
    : null;
  workers.set(this.threadId, this);
}
Worker.prototype = Object.create(EventEmitter.prototype);
Worker.prototype.constructor = Worker;
Worker.prototype.postMessage = function (value) {
  __velox_worker_post(this.threadId, serialize(value === undefined ? null : value));
};
Worker.prototype.terminate = function () {
  __velox_worker_terminate(this.threadId);
  return Promise.resolve(0);
};
Worker.prototype.ref = function () { return this; };
Worker.prototype.unref = function () { return this; };

// Native → JS bridge for worker → main events.
globalThis.__velox_worker_dispatch = function (id, type, json) {
  var w = workers.get(id);
  if (!w) return;
  if (type === 'message') {
    var v; try { v = deserialize(json); } catch (e) { v = json; }
    // Internal stdio envelope from the worker's patched process streams.
    if (v && typeof v === 'object' && v.__velox_stdio) {
      var dest = v.__velox_stdio === 'stderr' ? w.stderr : w.stdout;
      if (dest) dest.push(Buffer.from(v.data || '', 'base64'));
      return;
    }
    w.emit('message', v);
  } else if (type === 'error') {
    var msg; try { msg = JSON.parse(json); } catch (e) { msg = json; }
    w.emit('error', msg instanceof Error ? msg : new Error(String(msg)));
  } else if (type === 'exit') {
    if (w._exited) return;
    w._exited = true;
    workers.delete(id);
    if (w.stdout) w.stdout.push(null);
    if (w.stderr) w.stderr.push(null);
    w.emit('exit', parseInt(json, 10) || 0);
  }
};

// --- worker-thread side: parentPort + workerData ---------------------------

var parentPort = null;
var workerData;

if (isWorker) {
  var raw = globalThis.__velox_worker_data_json;
  var workerEnv = null;
  try { workerData = raw === undefined ? undefined : deserialize(raw); } catch (e) { workerData = undefined; }
  // Unwrap the parent's envelope ({ __velox_env, data }) when present.
  if (workerData && typeof workerData === 'object' && workerData.__velox_env) {
    workerEnv = workerData.__velox_env;
    workerData = workerData.data;
  }

  parentPort = new EventEmitter();
  var msgListeners = 0;
  function bumpKeepAlive(delta) {
    var before = msgListeners;
    msgListeners += delta;
    if (before === 0 && msgListeners > 0) __velox_worker_keepalive(true);
    else if (before > 0 && msgListeners <= 0) __velox_worker_keepalive(false);
  }
  var _on = EventEmitter.prototype.on;
  parentPort.on = parentPort.addListener = function (ev, fn) {
    _on.call(this, ev, fn);
    if (ev === 'message') bumpKeepAlive(1);
    return this;
  };
  var _once = EventEmitter.prototype.once;
  parentPort.once = function (ev, fn) {
    _once.call(this, ev, fn);
    if (ev === 'message') bumpKeepAlive(1);
    return this;
  };
  var _removeListener = EventEmitter.prototype.removeListener;
  parentPort.removeListener = parentPort.off = function (ev, fn) {
    _removeListener.call(this, ev, fn);
    if (ev === 'message') bumpKeepAlive(-1);
    return this;
  };
  parentPort.postMessage = function (value) {
    __velox_parent_post(serialize(value === undefined ? null : value));
  };
  parentPort.close = function () { msgListeners = 0; __velox_worker_keepalive(false); };
  parentPort.start = function () {};
  parentPort.ref = function () {};
  parentPort.unref = function () {};

  // Native → JS bridge for main → worker messages.
  globalThis.__velox_parent_dispatch = function (type, json) {
    if (type === 'message') {
      var v; try { v = deserialize(json); } catch (e) { v = json; }
      // Internal stdio envelope: parent feeding this worker's stdin.
      if (v && typeof v === 'object' && v.__velox_stdio) {
        if (workerStdin) {
          if (v.__velox_stdio === 'stdin') workerStdin.push(Buffer.from(v.data || '', 'base64'));
          else if (v.__velox_stdio === 'stdin_end') {
            workerStdin.push(null);
            __velox_worker_keepalive(false);
          }
        }
        return;
      }
      parentPort.emit('message', v);
    }
  };

  // Wire the worker's process streams per the parent's stdio flags: stdout/
  // stderr writes become envelopes back to the parent (console output rides
  // along, since its sink honors a replaced `write`); stdin becomes a real
  // Readable fed by parent envelopes. Keep the loop alive while stdin is open.
  var workerStdin = null;
  if (workerEnv && workerEnv.stdio) {
    var streamMod = require('node:stream');
    if (workerEnv.stdio.stdout && process.stdout) {
      process.stdout.write = function (chunk, enc, cb) {
        var buf = Buffer.isBuffer(chunk) ? chunk
          : Buffer.from(String(chunk), typeof enc === 'string' ? enc : 'utf8');
        __velox_parent_post(serialize({ __velox_stdio: 'stdout', data: buf.toString('base64') }));
        if (typeof enc === 'function') enc();
        else if (typeof cb === 'function') cb();
        return true;
      };
    }
    if (workerEnv.stdio.stderr && process.stderr) {
      process.stderr.write = function (chunk, enc, cb) {
        var buf = Buffer.isBuffer(chunk) ? chunk
          : Buffer.from(String(chunk), typeof enc === 'string' ? enc : 'utf8');
        __velox_parent_post(serialize({ __velox_stdio: 'stderr', data: buf.toString('base64') }));
        if (typeof enc === 'function') enc();
        else if (typeof cb === 'function') cb();
        return true;
      };
    }
    if (workerEnv.stdio.stdin) {
      workerStdin = new streamMod.Readable({ read: function () {} });
      try { process.stdin = workerStdin; } catch (e) {}
      __velox_worker_keepalive(true);
    }
  }
}

// --- MessageChannel / MessagePort (same-thread, in-process) ----------------

function MessagePort() { EventEmitter.call(this); this._other = null; this._closed = false; }
MessagePort.prototype = Object.create(EventEmitter.prototype);
MessagePort.prototype.postMessage = function (value) {
  // Posting on a closed channel is a silent no-op (Node drops the message).
  if (this._closed) return;
  var other = this._other;
  if (other && !other._closed) queueMicrotask(function () { if (!other._closed) other.emit('message', value); });
};
MessagePort.prototype.start = function () {};
// Closing either port closes the whole channel; 'close' fires on both ports
// asynchronously, and an optional callback observes this port's close.
MessagePort.prototype.close = function (cb) {
  if (typeof cb === 'function') this.once('close', cb);
  if (this._closed) return;
  var self = this, other = this._other;
  this._closed = true;
  if (other) other._closed = true;
  queueMicrotask(function () {
    self.emit('close');
    if (other) other.emit('close');
  });
};
MessagePort.prototype.ref = function () {};
MessagePort.prototype.unref = function () {};
// DOM-style handler property (Node's MessagePort supports both styles).
Object.defineProperty(MessagePort.prototype, 'onmessage', {
  configurable: true,
  get: function () { return this._onmessage || null; },
  set: function (fn) {
    if (this._onmessage) this.removeListener('message', this._onmessage);
    this._onmessage = typeof fn === 'function' ? fn : null;
    if (this._onmessage) this.on('message', this._onmessage);
  },
});

function MessageChannel() {
  this.port1 = new MessagePort();
  this.port2 = new MessagePort();
  this.port1._other = this.port2;
  this.port2._other = this.port1;
}

module.exports = {
  Worker: Worker,
  isMainThread: !isWorker,
  parentPort: parentPort,
  workerData: workerData,
  threadId: isWorker ? 1 : 0,
  MessageChannel: MessageChannel,
  MessagePort: MessagePort,
  // velox runs each worker in a separate context; SharedArrayBuffer isn't shared
  // across them, but the symbols exist for feature detection.
  markAsUntransferable: function () {},
  isMarkedAsUntransferable: function () { return false; },
  // Node 22.6+: mark an object so structuredClone/postMessage refuses to clone
  // it. velox doesn't enforce the constraint, but the symbol must exist —
  // undici (Node's fetch, pulled in by cheerio/etc.) calls it at load time.
  markAsUncloneable: function () {},
  moveMessagePortToContext: function (port) {
    if (port && port._closed) {
      var e = new Error('Cannot send data on closed MessagePort');
      e.code = 'ERR_CLOSED_MESSAGE_PORT';
      throw e;
    }
    return port;
  },
  receiveMessageOnPort: function () { return undefined; },
  setEnvironmentData: function () {},
  getEnvironmentData: function () { return undefined; },
  BroadcastChannel: typeof globalThis.BroadcastChannel !== 'undefined' ? globalThis.BroadcastChannel : undefined,
  // Sentinel for `new Worker(file, { env: SHARE_ENV })` — share the parent's
  // process.env with the worker. velox workers already inherit env, so this is
  // just the recognizable symbol Node exposes.
  SHARE_ENV: Symbol.for('nodejs.worker_threads.SHARE_ENV'),
};
module.exports.default = module.exports;

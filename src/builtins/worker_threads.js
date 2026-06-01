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
  var dataJson = serialize(options.workerData === undefined ? null : options.workerData);
  this.threadId = __velox_spawn_worker(source, isFile, dataJson);
  this._exited = false;
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
    w.emit('message', v);
  } else if (type === 'error') {
    var msg; try { msg = JSON.parse(json); } catch (e) { msg = json; }
    w.emit('error', msg instanceof Error ? msg : new Error(String(msg)));
  } else if (type === 'exit') {
    if (w._exited) return;
    w._exited = true;
    workers.delete(id);
    w.emit('exit', parseInt(json, 10) || 0);
  }
};

// --- worker-thread side: parentPort + workerData ---------------------------

var parentPort = null;
var workerData;

if (isWorker) {
  var raw = globalThis.__velox_worker_data_json;
  try { workerData = raw === undefined ? undefined : deserialize(raw); } catch (e) { workerData = undefined; }

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
      parentPort.emit('message', v);
    }
  };
}

// --- MessageChannel / MessagePort (same-thread, in-process) ----------------

function MessagePort() { EventEmitter.call(this); this._other = null; }
MessagePort.prototype = Object.create(EventEmitter.prototype);
MessagePort.prototype.postMessage = function (value) {
  var other = this._other;
  if (other) queueMicrotask(function () { other.emit('message', value); });
};
MessagePort.prototype.start = function () {};
MessagePort.prototype.close = function () { this.emit('close'); };
MessagePort.prototype.ref = function () {};
MessagePort.prototype.unref = function () {};

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
  moveMessagePortToContext: function (port) { return port; },
  receiveMessageOnPort: function () { return undefined; },
  setEnvironmentData: function () {},
  getEnvironmentData: function () { return undefined; },
  BroadcastChannel: typeof globalThis.BroadcastChannel !== 'undefined' ? globalThis.BroadcastChannel : undefined,
};
module.exports.default = module.exports;

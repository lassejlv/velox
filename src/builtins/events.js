// node:events — a compact EventEmitter.

// Same symbol shape as Node (tests locate it by description).
var kCapture = Symbol('kCapture');

function EventEmitter(opts) {
  if (!this._events) this._events = Object.create(null);
  if (opts !== undefined && opts !== null && opts.captureRejections !== undefined) {
    validateCaptureRejections(opts.captureRejections, 'options.captureRejections');
    this[kCapture] = opts.captureRejections;
  }
  // Domain integration (mirrors Node's EE constructor): an emitter created
  // while a domain is active is owned by it. `_getDomain` is installed by
  // node:domain on first require, so this is a no-op until domains are used.
  if (EventEmitter._getDomain) {
    var d = EventEmitter._getDomain();
    // Non-enumerable, as in Node — `domain` must not surface in Object.keys.
    if (d) Object.defineProperty(this, 'domain', { value: d, writable: true, enumerable: false, configurable: true });
  }
}

function validateCaptureRejections(value, name) {
  if (typeof value !== 'boolean') {
    throw require('node:util')._veloxErr.errInvalidArgType(
      'The "' + name + '" property must be of type boolean.', value);
  }
}
EventEmitter.EventEmitter = EventEmitter;
EventEmitter.defaultMaxListeners = 10;

EventEmitter.prototype.setMaxListeners = function (n) { this._maxListeners = n; return this; };
EventEmitter.prototype.getMaxListeners = function () {
  return this._maxListeners == null ? EventEmitter.defaultMaxListeners : this._maxListeners;
};

function listeners(self, type) {
  if (!self._events) self._events = Object.create(null);
  return self._events[type] || (self._events[type] = []);
}

// Emit `newListener` (with the *original* listener) before adding, as Node does.
function emitNewListener(self, type, listener) {
  if (self._events && self._events.newListener && type !== 'newListener') {
    self.emit('newListener', type, listener.listener || listener);
  }
}

EventEmitter.prototype.on = function (type, listener) {
  emitNewListener(this, type, listener);
  listeners(this, type).push(listener);
  return this;
};
EventEmitter.prototype.addListener = EventEmitter.prototype.on;

EventEmitter.prototype.prependListener = function (type, listener) {
  emitNewListener(this, type, listener);
  listeners(this, type).unshift(listener);
  return this;
};

EventEmitter.prototype.once = function (type, listener) {
  var self = this;
  function wrap() {
    self.removeListener(type, wrap);
    return listener.apply(this, arguments);
  }
  wrap.listener = listener;
  return this.on(type, wrap);
};

EventEmitter.prototype.prependOnceListener = function (type, listener) {
  var self = this;
  function wrap() {
    self.removeListener(type, wrap);
    return listener.apply(this, arguments);
  }
  wrap.listener = listener;
  return this.prependListener(type, wrap);
};

EventEmitter.prototype.removeListener = function (type, listener) {
  var list = this._events && this._events[type];
  if (!list) return this;
  for (var i = list.length - 1; i >= 0; i--) {
    if (list[i] === listener || list[i].listener === listener) {
      list.splice(i, 1);
      if (this._events.removeListener) this.emit('removeListener', type, listener);
      break;
    }
  }
  return this;
};
EventEmitter.prototype.off = EventEmitter.prototype.removeListener;

EventEmitter.prototype.removeAllListeners = function (type) {
  if (!this._events) return this;
  if (type === undefined) this._events = Object.create(null);
  else delete this._events[type];
  return this;
};

EventEmitter.prototype.emit = function (type) {
  var list = this._events && this._events[type];
  var args = Array.prototype.slice.call(arguments, 1);
  if (!list || list.length === 0) {
    if (type === 'error') {
      var err = args[0];
      // An emitter owned by a domain routes unhandled errors there instead of
      // throwing (Node's domain semantics; `domain` is set by node:domain).
      if (this.domain && this !== this.domain && typeof this.domain.emit === 'function') {
        if (err instanceof Error) {
          err.domainEmitter = this;
          // Non-enumerable, as in Node (must not surface in JSON/deepEqual).
          try {
            Object.defineProperty(err, 'domain', { value: this.domain, writable: true, enumerable: false, configurable: true });
          } catch (e) { err.domain = this.domain; }
          err.domainThrown = false;
        }
        this.domain.emit('error', err);
        return false;
      }
      throw err instanceof Error ? err : new Error('Unhandled "error" event');
    }
    return false;
  }
  var copy = list.slice();
  // captureRejections (per-instance flag, falling back to the static default):
  // a listener returning a rejected promise routes the reason to the emitter's
  // [Symbol.for('nodejs.rejection')] method, or failing that its 'error' event.
  var capture = this[kCapture] !== undefined
    ? this[kCapture]
    : EventEmitter._defaultCaptureRejections;
  for (var i = 0; i < copy.length; i++) {
    var result = copy[i].apply(this, args);
    if (capture && result && typeof result.then === 'function') {
      addRejectionHandler(this, result, type, args);
    }
  }
  return true;
};

function addRejectionHandler(ee, promise, type, args) {
  promise.then(undefined, function (err) {
    process.nextTick(function () {
      var sym = EventEmitter.captureRejectionSymbol;
      if (typeof ee[sym] === 'function') {
        ee[sym].apply(ee, [err, type].concat(args));
      } else {
        // Temporarily disable capture to avoid recursing on a rejecting
        // 'error' listener (Node does the same dance).
        var prev = ee[kCapture];
        ee[kCapture] = false;
        try { ee.emit('error', err); } finally { ee[kCapture] = prev; }
      }
    });
  });
}

EventEmitter.prototype.listeners = function (type) {
  return (this._events && this._events[type] ? this._events[type] : []).slice();
};
EventEmitter.prototype.rawListeners = EventEmitter.prototype.listeners;
EventEmitter.prototype.listenerCount = function (type) {
  return this._events && this._events[type] ? this._events[type].length : 0;
};
EventEmitter.prototype.eventNames = function () {
  return this._events ? Object.keys(this._events) : [];
};

EventEmitter.once = function (emitter, name) {
  return new Promise(function (resolve, reject) {
    emitter.once(name, function () { resolve(Array.prototype.slice.call(arguments)); });
    if (name !== 'error') emitter.once('error', reject);
  });
};

// Static `EventEmitter.listenerCount(emitter, type)` (legacy but widely used).
EventEmitter.listenerCount = function (emitter, type) {
  return typeof emitter.listenerCount === 'function'
    ? emitter.listenerCount(type)
    : (emitter._events && emitter._events[type] ? emitter._events[type].length : 0);
};

// Module-level `events.setMaxListeners(n, ...targets)` (Node 15+). Applies to
// EventEmitters and EventTargets (e.g. AbortSignal); tolerant of either.
function setMaxListeners(n) {
  if (n === undefined) n = EventEmitter.defaultMaxListeners;
  for (var i = 1; i < arguments.length; i++) {
    var t = arguments[i];
    if (!t) continue;
    if (typeof t.setMaxListeners === 'function') { try { t.setMaxListeners(n); } catch (e) {} }
    else { try { t._maxListeners = n; } catch (e) {} }
  }
}
function getEventListeners(target, type) {
  if (target && typeof target.listeners === 'function') return target.listeners(type);
  if (target && target._events && target._events[type]) return target._events[type].slice();
  // Web EventTarget (the velox shim keeps a `_listeners` Map of {listener}).
  if (target && target._listeners && typeof target._listeners.get === 'function') {
    var list = target._listeners.get(String(type));
    if (list) return list.map(function (entry) { return entry.listener; });
  }
  return [];
}
// `events.addAbortListener(signal, listener)` → returns a Disposable-ish handle.
function addAbortListener(signal, listener) {
  if (signal && signal.aborted) { queueMicrotask(function () { listener({ target: signal }); }); }
  else if (signal && typeof signal.addEventListener === 'function') { signal.addEventListener('abort', listener, { once: true }); }
  return { remove: function () { if (signal && signal.removeEventListener) signal.removeEventListener('abort', listener); } };
}

// `events.on(emitter, eventName, options)` → async iterator yielding the event
// argument arrays. Supports `{ signal }` for abort. (`highWaterMark` is ignored;
// velox buffers unboundedly.) Mirrors Node's behaviour closely enough for
// libraries like execa that iterate `on(stream, 'data', {signal})`.
function on(emitter, event, options) {
  options = options || {};
  var signal = options.signal;
  var unconsumed = [];   // event arg-arrays awaiting a consumer
  var queued = [];       // { resolve, reject } awaiting an event
  var finished = false;
  var error = null;

  function eventHandler() {
    var args = Array.prototype.slice.call(arguments);
    if (queued.length) queued.shift().resolve({ value: args, done: false });
    else unconsumed.push(args);
  }
  function errorHandler(err) {
    error = err; finished = true;
    if (queued.length) { queued.shift().reject(err); }
    cleanup();
  }
  function cleanup() {
    emitter.removeListener(event, eventHandler);
    if (event !== 'error') emitter.removeListener('error', errorHandler);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  function onAbort() {
    var err = (signal && signal.reason) || new Error('The operation was aborted');
    if (!err.name) err.name = 'AbortError';
    finished = true;
    cleanup();
    while (queued.length) queued.shift().reject(err);
    // After abort, surface done on subsequent pulls.
    error = null;
  }

  emitter.on(event, eventHandler);
  if (event !== 'error') emitter.on('error', errorHandler);
  if (signal) {
    if (signal.aborted) { queueMicrotask(onAbort); }
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  var iterator = {
    next: function () {
      if (unconsumed.length) return Promise.resolve({ value: unconsumed.shift(), done: false });
      if (error) { var e = error; error = null; return Promise.reject(e); }
      if (finished) return Promise.resolve({ value: undefined, done: true });
      return new Promise(function (resolve, reject) { queued.push({ resolve: resolve, reject: reject }); });
    },
    'return': function () { finished = true; cleanup(); return Promise.resolve({ value: undefined, done: true }); },
    'throw': function (err) { finished = true; cleanup(); return Promise.reject(err); },
  };
  iterator[Symbol.asyncIterator] = function () { return this; };
  return iterator;
}

// EventEmitterAsyncResource — an EventEmitter whose handlers run inside an
// AsyncResource scope. Worker-pool libraries (tinypool) `extends` it, so it must
// be a real constructor. Backed by velox's async_hooks AsyncResource.
function EventEmitterAsyncResource(options) {
  options = options || {};
  EventEmitter.call(this, options);
  var AsyncResource = require('node:async_hooks').AsyncResource;
  var name = options.name
    || (this.constructor && this.constructor.name)
    || 'EventEmitterAsyncResource';
  var resource = new AsyncResource(String(name), {
    triggerAsyncId: options.triggerAsyncId,
    requireManualDestroy: options.requireManualDestroy,
  });
  Object.defineProperty(this, 'asyncResource', { value: resource, enumerable: false, configurable: true });
}
EventEmitterAsyncResource.prototype = Object.create(EventEmitter.prototype);
EventEmitterAsyncResource.prototype.constructor = EventEmitterAsyncResource;
EventEmitterAsyncResource.prototype.emit = function () {
  var self = this, args = arguments;
  return this.asyncResource.runInAsyncScope(function () {
    return EventEmitter.prototype.emit.apply(self, args);
  });
};
EventEmitterAsyncResource.prototype.emitDestroy = function () {
  return this.asyncResource.emitDestroy();
};
Object.defineProperty(EventEmitterAsyncResource.prototype, 'asyncId', {
  configurable: true, get: function () { return this.asyncResource.asyncId(); },
});
Object.defineProperty(EventEmitterAsyncResource.prototype, 'triggerAsyncId', {
  configurable: true, get: function () { return this.asyncResource.triggerAsyncId(); },
});

EventEmitter.on = on;
EventEmitter.EventEmitterAsyncResource = EventEmitterAsyncResource;
EventEmitter.setMaxListeners = setMaxListeners;
EventEmitter.getEventListeners = getEventListeners;
EventEmitter.addAbortListener = addAbortListener;
EventEmitter.usingDomains = false;
EventEmitter.errorMonitor = Symbol('events.errorMonitor');
EventEmitter.captureRejectionSymbol = Symbol.for('nodejs.rejection');
// Static default for captureRejections, validated like Node's accessor.
EventEmitter._defaultCaptureRejections = false;
Object.defineProperty(EventEmitter, 'captureRejections', {
  enumerable: true,
  configurable: true,
  get: function () { return EventEmitter._defaultCaptureRejections; },
  set: function (value) {
    validateCaptureRejections(value, 'EventEmitter.captureRejections');
    EventEmitter._defaultCaptureRejections = value;
  },
});

module.exports = EventEmitter;
module.exports.EventEmitter = EventEmitter;
module.exports.on = on;
module.exports.setMaxListeners = setMaxListeners;
module.exports.getEventListeners = getEventListeners;
module.exports.addAbortListener = addAbortListener;
module.exports.once = EventEmitter.once;
module.exports.listenerCount = EventEmitter.listenerCount;
module.exports.errorMonitor = EventEmitter.errorMonitor;
module.exports.captureRejectionSymbol = EventEmitter.captureRejectionSymbol;
module.exports.EventEmitterAsyncResource = EventEmitterAsyncResource;
module.exports.default = EventEmitter;

// node:events — a compact EventEmitter.

function EventEmitter() {
  if (!this._events) this._events = Object.create(null);
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
      throw err instanceof Error ? err : new Error('Unhandled "error" event');
    }
    return false;
  }
  var copy = list.slice();
  for (var i = 0; i < copy.length; i++) copy[i].apply(this, args);
  return true;
};

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

module.exports = EventEmitter;
module.exports.EventEmitter = EventEmitter;

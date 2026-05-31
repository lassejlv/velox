// node:diagnostics_channel — named publish/subscribe channels used by fastify,
// pino, undici, etc. A pragmatic implementation of the standard surface.

var channels = new Map();

function Channel(name) {
  this.name = name;
  this._subscribers = [];
}
Channel.prototype.subscribe = function (onMessage) {
  this._subscribers.push(onMessage);
};
Channel.prototype.unsubscribe = function (onMessage) {
  var i = this._subscribers.indexOf(onMessage);
  if (i === -1) return false;
  this._subscribers.splice(i, 1);
  return true;
};
Object.defineProperty(Channel.prototype, 'hasSubscribers', {
  get: function () { return this._subscribers.length > 0; },
});
Channel.prototype.publish = function (message) {
  var name = this.name;
  this._subscribers.slice().forEach(function (fn) {
    try { fn(message, name); } catch (e) { if (globalThis.process) process.emit('error', e); }
  });
};
// bindStore/runStores are AsyncLocalStorage integrations — accept and no-op the
// store wiring (channels still publish), enough for libraries that call them.
Channel.prototype.bindStore = function (store, transform) { this._store = store; this._transform = transform; };
Channel.prototype.unbindStore = function () { this._store = null; return true; };
Channel.prototype.runStores = function (message, fn, thisArg) {
  this.publish(message);
  var args = Array.prototype.slice.call(arguments, 3);
  if (this._store && typeof this._store.run === 'function') {
    var ctx = this._transform ? this._transform(message) : message;
    return this._store.run(ctx, function () { return fn.apply(thisArg, args); });
  }
  return fn.apply(thisArg, args);
};

function channel(name) {
  var existing = channels.get(name);
  if (existing) return existing;
  var c = new Channel(name);
  channels.set(name, c);
  return c;
}
function hasSubscribers(name) {
  var c = channels.get(name);
  return !!(c && c.hasSubscribers);
}
function subscribe(name, onMessage) { channel(name).subscribe(onMessage); }
function unsubscribe(name, onMessage) {
  var c = channels.get(name);
  return c ? c.unsubscribe(onMessage) : false;
}

// TracingChannel — groups start/end/asyncStart/asyncEnd/error sub-channels.
function TracingChannel(nameOrChannels) {
  var base = typeof nameOrChannels === 'string' ? nameOrChannels : null;
  function sub(suffix, provided) { return provided || channel(base ? 'tracing:' + base + ':' + suffix : suffix); }
  var ch = typeof nameOrChannels === 'object' ? nameOrChannels : {};
  this.start = sub('start', ch.start);
  this.end = sub('end', ch.end);
  this.asyncStart = sub('asyncStart', ch.asyncStart);
  this.asyncEnd = sub('asyncEnd', ch.asyncEnd);
  this.error = sub('error', ch.error);
}
TracingChannel.prototype.subscribe = function (handlers) {
  for (var k in handlers) if (this[k] && this[k].subscribe) this[k].subscribe(handlers[k]);
};
TracingChannel.prototype.unsubscribe = function (handlers) {
  var ok = true;
  for (var k in handlers) if (this[k] && this[k].unsubscribe) ok = this[k].unsubscribe(handlers[k]) && ok;
  return ok;
};
TracingChannel.prototype.traceSync = function (fn, ctx, thisArg) {
  ctx = ctx || {};
  this.start.publish(ctx);
  try { var result = fn.apply(thisArg, Array.prototype.slice.call(arguments, 3)); ctx.result = result; return result; }
  catch (e) { ctx.error = e; this.error.publish(ctx); throw e; }
  finally { this.end.publish(ctx); }
};
TracingChannel.prototype.tracePromise = function (fn, ctx, thisArg) {
  ctx = ctx || {};
  var self = this;
  this.start.publish(ctx);
  var p;
  try { p = fn.apply(thisArg, Array.prototype.slice.call(arguments, 3)); }
  catch (e) { ctx.error = e; this.error.publish(ctx); this.end.publish(ctx); throw e; }
  this.end.publish(ctx);
  self.asyncStart.publish(ctx);
  return Promise.resolve(p).then(
    function (v) { ctx.result = v; self.asyncEnd.publish(ctx); return v; },
    function (e) { ctx.error = e; self.error.publish(ctx); self.asyncEnd.publish(ctx); throw e; }
  );
};
TracingChannel.prototype.traceCallback = function (fn, position, ctx, thisArg) {
  ctx = ctx || {};
  this.start.publish(ctx);
  return fn.apply(thisArg, Array.prototype.slice.call(arguments, 4));
};
function tracingChannel(nameOrChannels) { return new TracingChannel(nameOrChannels); }

module.exports = {
  channel: channel,
  hasSubscribers: hasSubscribers,
  subscribe: subscribe,
  unsubscribe: unsubscribe,
  tracingChannel: tracingChannel,
  Channel: Channel,
  TracingChannel: TracingChannel,
};
module.exports.default = module.exports;

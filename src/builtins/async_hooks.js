// node:async_hooks — AsyncLocalStorage with context propagation across async
// boundaries. JSC has no async_hooks, so we propagate by capturing the active
// context frame when a continuation is *scheduled* (Promise.then — which `await`
// uses internally — plus queueMicrotask/timers/nextTick) and restoring it when
// the continuation *runs*. This is the standard engine-less ALS technique and
// covers await/.then/.catch/.finally, setTimeout/Interval/Immediate, microtasks,
// and process.nextTick.

// The active context: a Map of AsyncLocalStorage instance -> store value.
// Frames are immutable (run/enterWith create a new Map), so a captured frame
// reference stays valid even after the active frame moves on.
var currentFrame = new Map();

function snapshot() { return currentFrame; }
function withFrame(frame, fn, self, args) {
  var prev = currentFrame;
  currentFrame = frame;
  try { return fn.apply(self, args); }
  finally { currentFrame = prev; }
}
// Wrap a callback so it runs under the frame active when it was scheduled.
function bindFrame(fn) {
  if (typeof fn !== 'function') return fn;
  var frame = currentFrame;
  return function () { return withFrame(frame, fn, this, arguments); };
}

var nextAsyncId = 1;

class AsyncLocalStorage {
  constructor() { this._enabled = true; }
  run(store, callback) {
    var args = Array.prototype.slice.call(arguments, 2);
    var frame = new Map(currentFrame);
    frame.set(this, store);
    return withFrame(frame, callback, undefined, args);
  }
  // Like run(), but without a callback: mutates the active frame for the rest of
  // the current (async-propagated) execution.
  enterWith(store) {
    var frame = new Map(currentFrame);
    frame.set(this, store);
    currentFrame = frame;
  }
  exit(callback) {
    var args = Array.prototype.slice.call(arguments, 1);
    var frame = new Map(currentFrame);
    frame.delete(this);
    return withFrame(frame, callback, undefined, args);
  }
  getStore() { return currentFrame.get(this); }
  disable() { this._enabled = false; }
  static bind(fn) { var bound = bindFrame(fn); return bound; }
  static snapshot() { var frame = currentFrame; return function (cb) { var a = Array.prototype.slice.call(arguments, 1); return withFrame(frame, cb, undefined, a); }; }
}

// AsyncResource — runInAsyncScope replays the frame captured at construction.
class AsyncResource {
  constructor(type, opts) { this.type = type; this._frame = currentFrame; this._asyncId = nextAsyncId++; }
  runInAsyncScope(fn, thisArg) {
    var args = Array.prototype.slice.call(arguments, 2);
    return withFrame(this._frame, fn, thisArg, args);
  }
  bind(fn) { var bound = bindFrame(fn); return bound; }
  emitDestroy() { return this; }
  asyncId() { return this._asyncId; }
  triggerAsyncId() { return 0; }
  static bind(fn) { return bindFrame(fn); }
}

function executionAsyncId() { return 0; }
function triggerAsyncId() { return 0; }
function executionAsyncResource() { return {}; }
// createHook is a no-op shim (we don't surface init/before/after/destroy), but
// the API exists for feature detection.
function createHook() {
  var hook = { enable: function () { return hook; }, disable: function () { return hook; } };
  return hook;
}

// --- one-time global patching of the async primitives ----------------------
(function patchAsyncPrimitives() {
  var g = globalThis;
  if (g.__velox_als_patched) return;
  g.__velox_als_patched = true;

  // Promise.prototype.then is the key: `await x` desugars to x.then(cont).
  var _then = Promise.prototype.then;
  Promise.prototype.then = function (onF, onR) {
    return _then.call(this,
      typeof onF === 'function' ? bindFrame(onF) : onF,
      typeof onR === 'function' ? bindFrame(onR) : onR);
  };

  if (typeof g.queueMicrotask === 'function') {
    var _qm = g.queueMicrotask;
    g.queueMicrotask = function (cb) { return _qm.call(this, bindFrame(cb)); };
  }

  // Timers (the global setters are velox's Timeout-wrapping versions).
  ['setTimeout', 'setInterval', 'setImmediate'].forEach(function (name) {
    var orig = g[name];
    if (typeof orig !== 'function') return;
    g[name] = function (cb) {
      var args = Array.prototype.slice.call(arguments, 1);
      return orig.apply(this, [bindFrame(cb)].concat(args));
    };
  });

  if (g.process && typeof g.process.nextTick === 'function') {
    var _nt = g.process.nextTick;
    g.process.nextTick = function (cb) {
      var args = Array.prototype.slice.call(arguments, 1);
      return _nt.apply(this, [bindFrame(cb)].concat(args));
    };
  }
})();

module.exports = {
  AsyncLocalStorage: AsyncLocalStorage,
  AsyncResource: AsyncResource,
  executionAsyncId: executionAsyncId,
  triggerAsyncId: triggerAsyncId,
  executionAsyncResource: executionAsyncResource,
  createHook: createHook,
};
module.exports.default = module.exports;

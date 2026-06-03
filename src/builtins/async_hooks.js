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

// --- createHook: init/destroy events for explicit AsyncResources -----------
// velox can't observe JSC-internal resources (promises, timers at the engine
// level), but user-created AsyncResources — the API surface packages actually
// hook — fire init at construction and destroy via emitDestroy().
var activeHooks = [];

function emitInit(asyncId, type, triggerAsyncId, resource) {
  for (var i = 0; i < activeHooks.length; i++) {
    var cb = activeHooks[i].init;
    if (typeof cb === 'function') {
      try { cb.call(activeHooks[i], asyncId, type, triggerAsyncId, resource); } catch (e) {}
    }
  }
}

// Destroys are queued and drained at lower priority than nextTick/microtasks
// (Node fires them from a later loop turn). A chained-microtask fallback also
// drains them after sustained microtask-only execution (long await chains),
// which is how Node behaves once a lot of queued items build up.
var destroyQueue = [];
var destroyScheduled = false;
function drainDestroys() {
  destroyScheduled = false;
  var q = destroyQueue;
  destroyQueue = [];
  for (var i = 0; i < q.length; i++) {
    for (var j = 0; j < activeHooks.length; j++) {
      var cb = activeHooks[j].destroy;
      if (typeof cb === 'function') {
        try { cb.call(activeHooks[j], q[i]); } catch (e) {}
      }
    }
  }
}
function scheduleDestroyDrain() {
  if (destroyScheduled) return;
  destroyScheduled = true;
  if (typeof setImmediate === 'function') setImmediate(function () { if (destroyScheduled) drainDestroys(); });
  else setTimeout(function () { if (destroyScheduled) drainDestroys(); }, 0);
  // Microtask-chain fallback: tick along the microtask queue and drain once
  // enough turns have passed without reaching a macrotask boundary.
  var ticks = 0;
  function tickDrain() {
    if (!destroyScheduled) return;
    if (++ticks >= 8192) { drainDestroys(); return; }
    queueMicrotask(tickDrain);
  }
  queueMicrotask(tickDrain);
}

// AsyncResource — runInAsyncScope replays the frame captured at construction.
class AsyncResource {
  constructor(type, opts) {
    this.type = type;
    this._frame = currentFrame;
    this._asyncId = nextAsyncId++;
    if (activeHooks.length) emitInit(this._asyncId, String(type), 0, this);
  }
  runInAsyncScope(fn, thisArg) {
    var args = Array.prototype.slice.call(arguments, 2);
    return withFrame(this._frame, fn, thisArg, args);
  }
  bind(fn) { var bound = bindFrame(fn); return bound; }
  emitDestroy() {
    if (activeHooks.length) {
      destroyQueue.push(this._asyncId);
      scheduleDestroyDrain();
    }
    return this;
  }
  asyncId() { return this._asyncId; }
  triggerAsyncId() { return 0; }
  static bind(fn) { return bindFrame(fn); }
}

function executionAsyncId() { return 0; }
function triggerAsyncId() { return 0; }
function executionAsyncResource() { return {}; }
// createHook surfaces init/destroy for explicit AsyncResources (see above).
// before/after/promiseResolve need engine-level hooks JSC doesn't expose.
function createHook(callbacks) {
  callbacks = callbacks || {};
  var hook = {
    init: callbacks.init,
    destroy: callbacks.destroy,
    before: callbacks.before,
    after: callbacks.after,
    enable: function () {
      if (activeHooks.indexOf(hook) === -1) activeHooks.push(hook);
      return hook;
    },
    disable: function () {
      var i = activeHooks.indexOf(hook);
      if (i !== -1) activeHooks.splice(i, 1);
      return hook;
    },
  };
  return hook;
}

// net.js calls this when a socket write goes asynchronous (bytes queued in the
// reactor): with hooks active it allocates a WRITEWRAP resource, firing init —
// and destroy once it drains. Installed here so programs that never touch
// async_hooks pay nothing.
Object.defineProperty(globalThis, '__velox_write_wrap_init', {
  value: function () {
    if (!activeHooks.length) return null;
    var res = new AsyncResource('WRITEWRAP');
    res.emitDestroy();
    return res;
  },
  writable: true, enumerable: false, configurable: true,
});

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

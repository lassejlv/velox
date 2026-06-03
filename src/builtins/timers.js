// node:timers — the callback timer API (same as the globals).
module.exports = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
  queueMicrotask: globalThis.queueMicrotask,
};

// Legacy idle-timer API (deprecated in Node but still shipped): `enroll` arms
// an object with an idle timeout, `active`/`_unrefActive` (re)start it, firing
// `item._onTimeout()` on expiry; `unenroll` cancels.
function scheduleIdle(item, unref) {
  if (item._idleTimeout === undefined || item._idleTimeout < 0) return;
  if (item._idleTimer) clearTimeout(item._idleTimer);
  var t = setTimeout(function () {
    item._idleTimer = null;
    if (typeof item._onTimeout === "function") item._onTimeout();
  }, item._idleTimeout);
  if (unref && t && typeof t.unref === "function") t.unref();
  item._idleTimer = t;
}
module.exports.enroll = function enroll(item, msecs) {
  item._idleTimeout = msecs;
};
module.exports.unenroll = function unenroll(item) {
  if (item._idleTimer) {
    clearTimeout(item._idleTimer);
    item._idleTimer = null;
  }
  item._idleTimeout = -1;
};
module.exports.active = function active(item) {
  scheduleIdle(item, false);
};
module.exports._unrefActive = function _unrefActive(item) {
  scheduleIdle(item, true);
};

module.exports.promises = require("node:timers/promises");
module.exports.default = module.exports;

// node:inspector — the V8 Inspector protocol API. velox has no inspector backend
// (no debug protocol over JSC's C API), so this is a surface-compatible stub:
// the module, Session, and open/close/url exist so code that requires it loads,
// but Session.post reports that the inspector is unavailable rather than hanging.

var EventEmitter = require('node:events');

function Session() { EventEmitter.call(this); this._connected = false; }
Session.prototype = Object.create(EventEmitter.prototype);
Session.prototype.constructor = Session;
Session.prototype.connect = function () { this._connected = true; };
Session.prototype.connectToMainThread = function () { this._connected = true; };
Session.prototype.disconnect = function () { this._connected = false; };
Session.prototype.post = function (method, params, callback) {
  if (typeof params === 'function') { callback = params; params = undefined; }
  var err = new Error('The inspector is not available in velox');
  err.code = 'ERR_INSPECTOR_NOT_AVAILABLE';
  if (typeof callback === 'function') Promise.resolve().then(function () { callback(err); });
};

function open() {} // no-op: no inspector to open
function close() {}
function url() { return undefined; }
function waitForDebugger() {}

module.exports = {
  Session: Session,
  open: open,
  close: close,
  url: url,
  waitForDebugger: waitForDebugger,
  console: globalThis.console,
};
module.exports.default = module.exports;

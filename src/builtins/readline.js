// node:readline — minimal stub. Enough to import and construct; there is no
// interactive stdin, so prompts resolve to an empty string.

function Interface(options) {
  this.options = options || {};
  this.terminal = false;
}
Interface.prototype.question = function (query, cb) {
  var p = globalThis.process;
  if (query && p && p.stdout) p.stdout.write(String(query));
  if (typeof cb === 'function') Promise.resolve().then(function () { cb(''); });
};
Interface.prototype.prompt = function () {};
Interface.prototype.write = function () {};
Interface.prototype.close = function () {};
Interface.prototype.pause = function () { return this; };
Interface.prototype.resume = function () { return this; };
Interface.prototype.on = function () { return this; };
Interface.prototype.once = function () { return this; };
Interface.prototype.off = function () { return this; };

exports.Interface = Interface;
exports.createInterface = function (options) { return new Interface(options); };
exports.clearLine = function () { return true; };
exports.clearScreenDown = function () { return true; };
exports.cursorTo = function () { return true; };
exports.moveCursor = function () { return true; };
exports.emitKeypressEvents = function () {};

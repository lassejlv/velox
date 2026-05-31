// node:console — re-exports the global console (which velox installs at startup)
// plus a `Console` constructor. `require('node:console')` is used by undici, etc.
var c = globalThis.console;
module.exports = c;
module.exports.Console = c && c.Console ? c.Console : function Console() { return globalThis.console; };
module.exports.default = c;

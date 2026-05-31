// node:module — createRequire + builtin-module introspection. velox resolves
// modules at bundle time, so `createRequire(...)` returns a require bound to the
// runtime builtin loader (covers the common case: createRequire then requiring
// `node:*` builtins). Relative requires through it aren't bundled.

var BUILTINS = [
  'assert', 'async_hooks', 'buffer', 'child_process', 'crypto', 'diagnostics_channel',
  'dns', 'events', 'fs', 'http', 'https', 'net', 'os', 'path', 'perf_hooks', 'process',
  'querystring', 'readline', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url',
  'util', 'vm', 'worker_threads', 'zlib',
];

function loaderRequire(id) {
  if (typeof globalThis.__velox_builtin_require === 'function') return globalThis.__velox_builtin_require(id);
  if (typeof require === 'function') return require(id);
  throw new Error("Cannot find module '" + id + "'");
}

function createRequire(filename) {
  var req = function require(id) { return loaderRequire(id); };
  req.resolve = function (id) { return id; };
  req.resolve.paths = function () { return null; };
  req.cache = {};
  req.extensions = {};
  req.main = undefined;
  return req;
}

function isBuiltin(name) {
  return BUILTINS.indexOf(String(name).replace(/^node:/, '')) !== -1;
}

function Module(id, parent) {
  this.id = id || '';
  this.exports = {};
  this.parent = parent || null;
  this.filename = null;
  this.loaded = false;
  this.children = [];
  this.paths = [];
}
Module.createRequire = createRequire;
Module.builtinModules = BUILTINS.slice();
Module.isBuiltin = isBuiltin;
Module._resolveFilename = function (request) { return request; };
Module._load = function (request) { return loaderRequire(request); };
Module._cache = {};
Module.syncBuiltinESMExports = function () {};
Module.wrap = function (script) { return '(function (exports, require, module, __filename, __dirname) { ' + script + '\n});'; };
Module.runMain = function () {};
Module.prototype.require = function (id) { return loaderRequire(id); };

module.exports = Module;
module.exports.Module = Module;
module.exports.createRequire = createRequire;
module.exports.builtinModules = BUILTINS.slice();
module.exports.isBuiltin = isBuiltin;
module.exports.default = Module;

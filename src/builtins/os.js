// node:os — a subset backed by the global `process`.

var process = globalThis.process || { env: {}, platform: 'darwin', arch: 'arm64' };

var _info = null;
function info() {
  if (_info) return _info;
  try { _info = JSON.parse(__velox_os_info()); } catch (e) { _info = {}; }
  return _info;
}

exports.EOL = '\n';
exports.devNull = '/dev/null';
exports.platform = function () { return process.platform || 'darwin'; };
exports.arch = function () { return info().arch || process.arch || 'arm64'; };
exports.machine = function () { return info().arch || process.arch || 'arm64'; };
exports.type = function () {
  var p = exports.platform();
  return p === 'darwin' ? 'Darwin' : p === 'win32' ? 'Windows_NT' : 'Linux';
};
exports.release = function () { return ''; };
exports.version = function () { return ''; };
exports.hostname = function () { return info().hostname || 'localhost'; };
exports.homedir = function () {
  var e = process.env || {};
  return e.HOME || e.USERPROFILE || '/';
};
exports.tmpdir = function () {
  var e = process.env || {};
  return e.TMPDIR || e.TMP || e.TEMP || '/tmp';
};
exports.endianness = function () { return 'LE'; };
exports.cpus = function () {
  var n = info().cpus || 1;
  var arr = [];
  for (var i = 0; i < n; i++) {
    arr.push({ model: 'cpu', speed: 0, times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } });
  }
  return arr;
};
exports.totalmem = function () { return info().totalmem || 0; };
exports.freemem = function () { return info().totalmem || 0; };
exports.uptime = function () { return typeof __velox_hrtime_ns === 'function' ? __velox_hrtime_ns() / 1e9 : 0; };
exports.loadavg = function () { return info().loadavg || [0, 0, 0]; };
exports.networkInterfaces = function () { return {}; };
exports.availableParallelism = function () { return info().cpus || 1; };
exports.userInfo = function () {
  return { username: '', homedir: exports.homedir(), shell: null, uid: -1, gid: -1 };
};
exports.constants = { signals: {}, errno: {}, priority: {} };

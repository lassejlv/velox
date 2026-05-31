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
// Darwin (macOS) signal numbers — velox is macOS-only.
var signals = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGIOT: 6,
  SIGBUS: 10, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 30, SIGSEGV: 11, SIGUSR2: 31,
  SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 20, SIGCONT: 19, SIGSTOP: 17,
  SIGTSTP: 18, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 16, SIGXCPU: 24, SIGXFSZ: 25,
  SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 23, SIGINFO: 29, SIGSYS: 12,
};
// Darwin errno numbers (common subset).
var errno = {
  E2BIG: 7, EACCES: 13, EADDRINUSE: 48, EADDRNOTAVAIL: 49, EAGAIN: 35, EBADF: 9,
  EBUSY: 16, ECANCELED: 89, ECONNABORTED: 53, ECONNREFUSED: 61, ECONNRESET: 54,
  EEXIST: 17, EFAULT: 14, EFBIG: 27, EHOSTUNREACH: 65, EINTR: 4, EINVAL: 22,
  EIO: 5, EISDIR: 21, ELOOP: 62, EMFILE: 24, EMLINK: 31, ENAMETOOLONG: 63,
  ENFILE: 23, ENODEV: 19, ENOENT: 2, ENOMEM: 12, ENOSPC: 28, ENOTDIR: 20,
  ENOTEMPTY: 66, ENOTSOCK: 38, ENOTTY: 25, ENXIO: 6, EPERM: 1, EPIPE: 32,
  EROFS: 30, ESPIPE: 29, ESRCH: 3, ETIMEDOUT: 60, EXDEV: 18,
};
exports.constants = {
  signals: signals,
  errno: errno,
  priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 },
  UV_UDP_REUSEADDR: 4,
};

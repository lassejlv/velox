// node:fs — synchronous ops backed by native primitives; async/promise
// variants run the same sync op and resolve on the microtask queue (fs work is
// not truly threaded yet). File bytes cross the boundary as latin1 strings.

function toBuffer(latin1) {
  return globalThis.Buffer.from(latin1, 'latin1');
}
// Map a numeric fd (0/1/2 and others) to its /dev path so fs can read stdin etc.
function fsPath(p) {
  if (typeof p === 'number') {
    if (p === 0) return '/dev/stdin';
    if (p === 1) return '/dev/stdout';
    if (p === 2) return '/dev/stderr';
    return '/dev/fd/' + p;
  }
  return String(p);
}
function encOf(options) {
  if (typeof options === 'string') return options;
  return options && options.encoding ? options.encoding : null;
}

function Stats(o) {
  this._type = o._type;
  this.size = o.size;
  this.mode = o.mode;
  this.mtimeMs = o.mtimeMs;
  this.atimeMs = o.atimeMs;
  this.ctimeMs = o.ctimeMs;
  this.birthtimeMs = o.birthtimeMs;
  this.mtime = new Date(o.mtimeMs);
  this.atime = new Date(o.atimeMs);
  this.ctime = new Date(o.ctimeMs);
  this.birthtime = new Date(o.birthtimeMs);
  this.blksize = 4096;
  this.blocks = Math.ceil(o.size / 512);
  this.dev = 0; this.ino = 0; this.nlink = 1; this.uid = 0; this.gid = 0; this.rdev = 0;
}
Stats.prototype.isFile = function () { return this._type === 'file'; };
Stats.prototype.isDirectory = function () { return this._type === 'dir'; };
Stats.prototype.isSymbolicLink = function () { return this._type === 'symlink'; };
Stats.prototype.isBlockDevice = function () { return false; };
Stats.prototype.isCharacterDevice = function () { return false; };
Stats.prototype.isFIFO = function () { return false; };
Stats.prototype.isSocket = function () { return false; };

function Dirent(name, type, parentPath) {
  this.name = name;
  this._type = type;
  this.parentPath = parentPath || '';
  this.path = this.parentPath; // deprecated Node alias
}
Dirent.prototype.isFile = function () { return this._type === 'file'; };
Dirent.prototype.isDirectory = function () { return this._type === 'dir'; };
Dirent.prototype.isSymbolicLink = function () { return this._type === 'symlink'; };
Dirent.prototype.isBlockDevice = function () { return false; };
Dirent.prototype.isCharacterDevice = function () { return false; };
Dirent.prototype.isFIFO = function () { return false; };
Dirent.prototype.isSocket = function () { return false; };

// Build a Dirent for `name` under directory `dir`, resolving its type via lstat.
function direntFor(dir, name) {
  var t = 'other';
  try { t = JSON.parse(__velox_stat(fsPath(dir) + '/' + name, false))._type; } catch (e) {}
  return new Dirent(name, t, String(dir));
}

// --- synchronous API -------------------------------------------------------

function readFileSync(p, options) {
  var buf = toBuffer(__velox_read_file(fsPath(p)));
  var enc = encOf(options);
  return enc ? buf.toString(enc) : buf;
}
function writeFileSync(p, data, options) {
  var buf = globalThis.Buffer.isBuffer(data)
    ? data
    : globalThis.Buffer.from(String(data), encOf(options) || 'utf8');
  __velox_write_file(fsPath(p), buf.toString('latin1'), false);
}
function appendFileSync(p, data, options) {
  var buf = globalThis.Buffer.isBuffer(data)
    ? data
    : globalThis.Buffer.from(String(data), encOf(options) || 'utf8');
  __velox_write_file(fsPath(p), buf.toString('latin1'), true);
}
function existsSync(p) {
  try { return __velox_exists(fsPath(p)); } catch (e) { return false; }
}
function statSync(p) { return new Stats(JSON.parse(__velox_stat(fsPath(p), true))); }
function lstatSync(p) { return new Stats(JSON.parse(__velox_stat(fsPath(p), false))); }
function readdirSync(p, options) {
  var names = JSON.parse(__velox_readdir(String(p)));
  if (options && options.withFileTypes) {
    return names.map(function (n) { return direntFor(p, n); });
  }
  return names;
}
function mkdirSync(p, options) {
  __velox_mkdir(String(p), !!(options && typeof options === 'object' && options.recursive));
}
function rmSync(p, options) {
  __velox_rm(String(p), !!(options && options.recursive), !!(options && options.force));
}
function rmdirSync(p, options) {
  __velox_rm(String(p), !!(options && options.recursive), false);
}
function unlinkSync(p) { __velox_rm(String(p), false, false); }
function renameSync(a, b) { __velox_rename(String(a), String(b)); }
function realpathSync(p) { return __velox_realpath(String(p)); }
function accessSync(p) { if (!__velox_exists(fsPath(p))) { throw globalThis.__velox_fs_error('ENOENT', 'ENOENT: no such file or directory, access \'' + p + '\''); } }
function copyFileSync(src, dest) { writeFileSync(dest, readFileSync(src)); }
function randSuffix() {
  var s = '';
  for (var i = 0; i < 6; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[(Math.random() * 36) | 0];
  return s;
}
function mkdtempSync(prefix, options) {
  for (var attempt = 0; attempt < 100; attempt++) {
    var dir = String(prefix) + randSuffix();
    if (!existsSync(dir)) { mkdirSync(dir); return dir; }
  }
  throw globalThis.__velox_fs_error('EEXIST', 'EEXIST: could not create unique temp dir');
}
function realpathSyncNative(p) { return __velox_realpath(String(p)); }
realpathSync.native = realpathSyncNative;

// --- file descriptors (synthetic table, read-modify-write backed) ----------
// velox has no real fd table, so openSync hands out synthetic descriptors (>=100
// to avoid clashing with stdio 0/1/2) and read/write operate on the path.

var fdTable = {};
var nextFd = 100;
function openSync(p, flags, mode) {
  flags = flags === undefined ? 'r' : String(flags);
  var path = fsPath(p);
  var exists = existsSync(path);
  if (flags[0] === 'r' && !exists) {
    throw globalThis.__velox_fs_error('ENOENT', "ENOENT: no such file or directory, open '" + p + "'");
  }
  if (flags[0] === 'w' || (flags[0] === 'a' && !exists)) {
    if (flags[0] === 'w' || !exists) __velox_write_file(path, '', false); // create/truncate
  }
  var append = flags[0] === 'a';
  var fd = nextFd++;
  fdTable[fd] = { path: path, flags: flags, pos: append ? (exists ? fileLen(path) : 0) : 0, append: append };
  return fd;
}
function fileLen(path) {
  try { return Buffer.from(__velox_read_file(path), 'latin1').length; } catch (e) { return 0; }
}
function fdEntry(fd) {
  if (typeof fd !== 'number' || !fdTable[fd]) {
    throw globalThis.__velox_fs_error('EBADF', 'EBADF: bad file descriptor');
  }
  return fdTable[fd];
}
function closeSync(fd) { delete fdTable[fd]; }
function readSync(fd, buffer, offset, length, position) {
  var e = fdEntry(fd);
  offset = offset || 0;
  length = length === undefined ? buffer.length - offset : length;
  var data = Buffer.from(__velox_read_file(e.path), 'latin1');
  var pos = (position === null || position === undefined) ? e.pos : position;
  var slice = data.subarray(pos, pos + length);
  slice.copy(buffer, offset);
  if (position === null || position === undefined) e.pos += slice.length;
  return slice.length;
}
function writeSync(fd, data, a, b, c) {
  var e = fdEntry(fd);
  var buf, position;
  if (typeof data === 'string') {
    // writeSync(fd, string[, position[, encoding]])
    var enc = typeof b === 'string' ? b : 'utf8';
    buf = Buffer.from(data, enc);
    position = typeof a === 'number' ? a : null;
  } else {
    // writeSync(fd, buffer[, offset[, length[, position]]])
    var off = a || 0;
    var len = b === undefined ? data.length - off : b;
    buf = Buffer.from(data.subarray(off, off + len));
    position = typeof c === 'number' ? c : null;
  }
  var cur = Buffer.from(__velox_read_file(e.path), 'latin1');
  var at = e.append ? cur.length : (position === null || position === undefined ? e.pos : position);
  var end = at + buf.length;
  var out = Buffer.alloc(Math.max(cur.length, end));
  cur.copy(out, 0);
  buf.copy(out, at);
  __velox_write_file(e.path, out.toString('latin1'), false);
  if (position === null || position === undefined) e.pos = at + buf.length;
  return buf.length;
}
function fstatSync(fd) { return statSync(fdEntry(fd).path); }
function ftruncateSync(fd, len) {
  var e = fdEntry(fd);
  len = len || 0;
  var cur = Buffer.from(__velox_read_file(e.path), 'latin1');
  var out = cur.subarray(0, len);
  __velox_write_file(e.path, out.toString('latin1'), false);
}
function truncateSync(p, len) {
  len = len || 0;
  var cur = Buffer.from(__velox_read_file(fsPath(p)), 'latin1');
  __velox_write_file(fsPath(p), cur.subarray(0, len).toString('latin1'), false);
}
function fsyncSync() {} // no-op: writes are already synchronous to disk
function fdatasyncSync() {}

// --- read/write streams (sync-backed) --------------------------------------

function createReadStream(p, options) {
  var stream = require('stream');
  var enc = encOf(options);
  var start = (options && typeof options.start === 'number') ? options.start : 0;
  var end = (options && typeof options.end === 'number') ? options.end : undefined;
  var highWaterMark = (options && options.highWaterMark) || 64 * 1024;
  var buf;
  try {
    buf = readFileSync(fsPath(p));
    if (start || end !== undefined) buf = buf.subarray(start, end === undefined ? buf.length : end + 1);
  } catch (e) {
    var errEarly = new stream.Readable({ read: function () {} });
    Promise.resolve().then(function () { errEarly.emit('error', e); });
    return errEarly;
  }
  var pos = 0;
  var r = new stream.Readable({
    read: function (n) {
      if (pos >= buf.length) { this.push(null); return; }
      var size = Math.min(n || highWaterMark, buf.length - pos);
      var chunk = buf.subarray(pos, pos + size);
      pos += size;
      this.push(enc ? chunk.toString(enc) : chunk);
    },
  });
  Promise.resolve().then(function () { r.emit('open', 0); r.emit('ready'); });
  return r;
}

function createWriteStream(p, options) {
  var stream = require('stream');
  var flags = (options && options.flags) || 'w';
  var enc = encOf(options) || 'utf8';
  var append = flags.indexOf('a') !== -1;
  if (!append) writeFileSync(fsPath(p), ''); // truncate up front
  var bytesWritten = 0;
  var w = new stream.Writable({
    write: function (chunk, encoding, cb) {
      var b = globalThis.Buffer.isBuffer(chunk) ? chunk : globalThis.Buffer.from(String(chunk), enc);
      try { __velox_write_file(fsPath(p), b.toString('latin1'), true); bytesWritten += b.length; cb(); }
      catch (e) { cb(e); }
    },
  });
  w.path = p;
  Object.defineProperty(w, 'bytesWritten', { get: function () { return bytesWritten; } });
  Promise.resolve().then(function () { w.emit('open', 0); w.emit('ready'); });
  return w;
}

// --- watchers (poll-based; Node's watchFile is polling too) ----------------

function FSWatcher() { this._timer = null; this._listeners = []; }
FSWatcher.prototype = Object.create(require('events').EventEmitter.prototype);
FSWatcher.prototype.close = function () { if (this._timer) { clearInterval(this._timer); this._timer = null; } this.emit('close'); };
FSWatcher.prototype.ref = function () { return this; };
FSWatcher.prototype.unref = function () { return this; };

function watch(filename, options, listener) {
  if (typeof options === 'function') { listener = options; options = undefined; }
  var interval = (options && options.interval) || 100;
  var w = new FSWatcher();
  if (listener) w.on('change', listener);
  var prev = null;
  try { prev = JSON.parse(__velox_stat(fsPath(filename), false)); } catch (e) {}
  w._timer = setInterval(function () {
    var cur = null;
    try { cur = JSON.parse(__velox_stat(fsPath(filename), false)); } catch (e) {}
    if (!cur && prev) { w.emit('change', 'rename', String(filename)); prev = null; return; }
    if (cur && (!prev || cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size)) {
      w.emit('change', 'change', String(filename));
    }
    prev = cur;
  }, interval);
  if (w._timer && w._timer.unref) w._timer.unref();
  return w;
}

function watchFile(filename, options, listener) {
  if (typeof options === 'function') { listener = options; options = undefined; }
  var interval = (options && options.interval) || 5007;
  var w = new FSWatcher();
  var prev = null;
  try { prev = JSON.parse(__velox_stat(fsPath(filename), false)); } catch (e) {}
  w._timer = setInterval(function () {
    var cur = null;
    try { cur = JSON.parse(__velox_stat(fsPath(filename), false)); } catch (e) {}
    var curStat = new Stats(cur || { _type: 'file', size: 0, mode: 0, mtimeMs: 0, atimeMs: 0, ctimeMs: 0, birthtimeMs: 0 });
    var prevStat = new Stats(prev || { _type: 'file', size: 0, mode: 0, mtimeMs: 0, atimeMs: 0, ctimeMs: 0, birthtimeMs: 0 });
    if (!prev || !cur || cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) {
      listener && listener(curStat, prevStat);
    }
    prev = cur;
  }, interval);
  w._filename = String(filename);
  if (!watchFile._watchers) watchFile._watchers = [];
  watchFile._watchers.push(w);
  return w;
}
function unwatchFile(filename) {
  if (!watchFile._watchers) return;
  var fn = String(filename);
  watchFile._watchers = watchFile._watchers.filter(function (w) {
    if (w._filename === fn) { w.close(); return false; }
    return true;
  });
}

// --- true async readFile/writeFile (run on a worker thread) ----------------

var fsTokens = {};
var fsNextToken = 1;
globalThis.__velox_fs_done = function (token, code, message, data) {
  var handler = fsTokens[token];
  if (!handler) return;
  delete fsTokens[token];
  if (code) handler(globalThis.__velox_fs_error(code, message), null);
  else handler(null, data);
};

function readFile(p, options, cb) {
  if (typeof options === 'function') { cb = options; options = undefined; }
  var enc = encOf(options);
  var token = fsNextToken++;
  fsTokens[token] = function (err, latin1) {
    if (err) return cb && cb(err);
    var buf = toBuffer(latin1);
    cb && cb(null, enc ? buf.toString(enc) : buf);
  };
  __velox_read_file_async(token, fsPath(p));
}
function writeFile(p, data, options, cb) {
  if (typeof options === 'function') { cb = options; options = undefined; }
  var buf = globalThis.Buffer.isBuffer(data)
    ? data
    : globalThis.Buffer.from(String(data), encOf(options) || 'utf8');
  var token = fsNextToken++;
  fsTokens[token] = function (err) { cb && cb(err || null); };
  __velox_write_file_async(token, fsPath(p), buf.toString('latin1'), false);
}

// Off-thread metadata ops (stat/lstat/readdir/realpath). Result is UTF-8 text.
function fsOpAsync(op, p, cb, transform) {
  var token = fsNextToken++;
  fsTokens[token] = function (err, latin1) {
    if (err) return cb && cb(err);
    var text = globalThis.Buffer.from(latin1, 'latin1').toString('utf8');
    cb && cb(null, transform ? transform(text) : text);
  };
  __velox_fs_op_async(token, op, fsPath(p));
}
// Off-thread mutation ops (mkdir/rmdir/rm/unlink/rename/copyFile). `arg2` is a
// dest path (rename/copyFile) or a flags string ("r" recursive, "f" force).
function fsMutAsync(op, p, arg2, cb) {
  var token = fsNextToken++;
  fsTokens[token] = function (err) { cb && cb(err || null); };
  __velox_fs_op_async(token, op, fsPath(p), arg2 == null ? '' : String(arg2));
}
function mkdirAsync(p, options, cb) {
  if (typeof options === 'function') { cb = options; options = undefined; }
  fsMutAsync('mkdir', p, (options && options.recursive) ? 'r' : '', cb);
}
function rmAsync(p, options, cb) {
  if (typeof options === 'function') { cb = options; options = undefined; }
  var flags = ((options && options.recursive) ? 'r' : '') + ((options && options.force) ? 'f' : '');
  fsMutAsync('rm', p, flags, cb);
}
function rmdirAsync(p, options, cb) {
  if (typeof options === 'function') { cb = options; options = undefined; }
  fsMutAsync('rmdir', p, (options && options.recursive) ? 'r' : '', cb);
}
function unlinkAsync(p, cb) { fsMutAsync('unlink', p, '', cb); }
function renameAsync(a, b, cb) { fsMutAsync('rename', a, fsPath(b), cb); }
function copyFileAsync(src, dest, mode, cb) {
  if (typeof mode === 'function') { cb = mode; }
  fsMutAsync('copyFile', src, fsPath(dest), cb);
}
function statAsync(p, options, cb) {
  if (typeof options === 'function') { cb = options; }
  fsOpAsync('stat', p, cb, function (t) { return new Stats(JSON.parse(t)); });
}
function lstatAsync(p, options, cb) {
  if (typeof options === 'function') { cb = options; }
  fsOpAsync('lstat', p, cb, function (t) { return new Stats(JSON.parse(t)); });
}
function readdirAsync(p, options, cb) {
  if (typeof options === 'function') { cb = options; options = undefined; }
  fsOpAsync('readdir', p, cb, function (t) {
    var names = JSON.parse(t);
    if (options && options.withFileTypes) {
      return names.map(function (n) { return direntFor(p, n); });
    }
    return names;
  });
}
function realpathAsync(p, options, cb) {
  if (typeof options === 'function') { cb = options; }
  fsOpAsync('realpath', p, cb);
}

// --- callback API (sync under the hood, called back asynchronously) --------

function callbackify(syncFn, hasResult) {
  return function () {
    var args = Array.prototype.slice.call(arguments);
    var cb = args.pop();
    if (typeof cb !== 'function') { cb = undefined; }
    Promise.resolve().then(function () {
      var value;
      try { value = syncFn.apply(null, args); }
      catch (e) { if (cb) cb(e); return; }
      if (cb) hasResult ? cb(null, value) : cb(null);
    });
  };
}
function promisify(syncFn) {
  return function () {
    var args = arguments;
    return new Promise(function (resolve, reject) {
      try { resolve(syncFn.apply(null, args)); } catch (e) { reject(e); }
    });
  };
}

var constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0x200, O_EXCL: 0x800,
  O_TRUNC: 0x400, O_APPEND: 8,
  COPYFILE_EXCL: 1,
};

var promises = {
  readFile: function (p, o) { return new Promise(function (res, rej) { readFile(p, o, function (e, d) { e ? rej(e) : res(d); }); }); },
  writeFile: function (p, d, o) { return new Promise(function (res, rej) { writeFile(p, d, o, function (e) { e ? rej(e) : res(); }); }); },
  appendFile: promisify(appendFileSync),
  stat: function (p, o) { return new Promise(function (res, rej) { statAsync(p, o, function (e, d) { e ? rej(e) : res(d); }); }); },
  lstat: function (p, o) { return new Promise(function (res, rej) { lstatAsync(p, o, function (e, d) { e ? rej(e) : res(d); }); }); },
  readdir: function (p, o) { return new Promise(function (res, rej) { readdirAsync(p, o, function (e, d) { e ? rej(e) : res(d); }); }); },
  // Mutation ops now run off-thread (see fsMutAsync) rather than sync-backed.
  mkdir: function (p, o) { return new Promise(function (res, rej) { mkdirAsync(p, o, function (e) { e ? rej(e) : res(undefined); }); }); },
  rm: function (p, o) { return new Promise(function (res, rej) { rmAsync(p, o, function (e) { e ? rej(e) : res(); }); }); },
  rmdir: function (p, o) { return new Promise(function (res, rej) { rmdirAsync(p, o, function (e) { e ? rej(e) : res(); }); }); },
  unlink: function (p) { return new Promise(function (res, rej) { unlinkAsync(p, function (e) { e ? rej(e) : res(); }); }); },
  rename: function (a, b) { return new Promise(function (res, rej) { renameAsync(a, b, function (e) { e ? rej(e) : res(); }); }); },
  copyFile: function (s, d, m) { return new Promise(function (res, rej) { copyFileAsync(s, d, m, function (e) { e ? rej(e) : res(); }); }); },
  realpath: promisify(realpathSync),
  access: promisify(accessSync),
  mkdtemp: promisify(mkdtempSync),
};

module.exports = {
  readFileSync: readFileSync,
  writeFileSync: writeFileSync,
  appendFileSync: appendFileSync,
  existsSync: existsSync,
  statSync: statSync,
  lstatSync: lstatSync,
  readdirSync: readdirSync,
  mkdirSync: mkdirSync,
  rmSync: rmSync,
  rmdirSync: rmdirSync,
  unlinkSync: unlinkSync,
  renameSync: renameSync,
  realpathSync: realpathSync,
  accessSync: accessSync,
  copyFileSync: copyFileSync,
  mkdtempSync: mkdtempSync,
  mkdtemp: callbackify(mkdtempSync, true),
  openSync: openSync,
  closeSync: closeSync,
  readSync: readSync,
  writeSync: writeSync,
  fstatSync: fstatSync,
  ftruncateSync: ftruncateSync,
  truncateSync: truncateSync,
  fsyncSync: fsyncSync,
  fdatasyncSync: fdatasyncSync,
  open: callbackify(openSync, true),
  close: callbackify(closeSync, false),
  fstat: callbackify(fstatSync, true),
  ftruncate: callbackify(ftruncateSync, false),
  truncate: callbackify(truncateSync, false),
  createReadStream: createReadStream,
  createWriteStream: createWriteStream,
  watch: watch,
  watchFile: watchFile,
  unwatchFile: unwatchFile,
  FSWatcher: FSWatcher,
  readFile: readFile,
  writeFile: writeFile,
  appendFile: callbackify(appendFileSync, false),
  exists: function (p, cb) { Promise.resolve().then(function () { cb(existsSync(p)); }); },
  stat: statAsync,
  lstat: lstatAsync,
  readdir: readdirAsync,
  mkdir: mkdirAsync,
  rm: rmAsync,
  rmdir: rmdirAsync,
  unlink: function (p, cb) { unlinkAsync(p, cb); },
  rename: function (a, b, cb) { renameAsync(a, b, cb); },
  realpath: callbackify(realpathSync, true),
  access: callbackify(accessSync, false),
  copyFile: copyFileAsync,
  Stats: Stats,
  Dirent: Dirent,
  constants: constants,
  promises: promises,
};
module.exports.default = module.exports;

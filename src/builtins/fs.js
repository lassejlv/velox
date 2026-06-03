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
  // Node's fs accepts a `file:` URL object or string (ESM packages pass
  // `new URL('../x', import.meta.url)`); convert it to a filesystem path.
  if (p && typeof p === 'object' && p.protocol === 'file:' && typeof p.pathname === 'string') {
    return decodeURIComponent(p.pathname);
  }
  var s = String(p);
  if (s.slice(0, 7) === 'file://') {
    try { return decodeURIComponent(new URL(s).pathname); } catch (e) {}
  }
  return s;
}
function encOf(options) {
  if (typeof options === 'string') return options;
  return options && options.encoding ? options.encoding : null;
}

function Stats(o, bigint) {
  this._type = o._type;
  // Dates are derived from the millisecond fields before any BigInt coercion.
  this.mtime = new Date(o.mtimeMs);
  this.atime = new Date(o.atimeMs);
  this.ctime = new Date(o.ctimeMs);
  this.birthtime = new Date(o.birthtimeMs);
  if (bigint) {
    var B = function (n) { return BigInt(Math.floor(n || 0)); };
    this.size = B(o.size);
    this.mode = B(o.mode);
    this.mtimeMs = B(o.mtimeMs);
    this.atimeMs = B(o.atimeMs);
    this.ctimeMs = B(o.ctimeMs);
    this.birthtimeMs = B(o.birthtimeMs);
    this.mtimeNs = B(o.mtimeMs) * 1000000n;
    this.atimeNs = B(o.atimeMs) * 1000000n;
    this.ctimeNs = B(o.ctimeMs) * 1000000n;
    this.birthtimeNs = B(o.birthtimeMs) * 1000000n;
    this.blksize = 4096n;
    this.blocks = BigInt(Math.ceil((o.size || 0) / 512));
    this.dev = 0n; this.ino = 0n; this.nlink = 1n; this.uid = 0n; this.gid = 0n; this.rdev = 0n;
  } else {
    this.size = o.size;
    this.mode = o.mode;
    this.mtimeMs = o.mtimeMs;
    this.atimeMs = o.atimeMs;
    this.ctimeMs = o.ctimeMs;
    this.birthtimeMs = o.birthtimeMs;
    this.blksize = 4096;
    this.blocks = Math.ceil(o.size / 512);
    this.dev = 0; this.ino = 0; this.nlink = 1; this.uid = 0; this.gid = 0; this.rdev = 0;
  }
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

// fs.Dir — a directory handle yielding Dirents. velox reads the whole listing
// eagerly on open (no native dir-fd), then doles out entries; the async forms
// resolve on a microtask so callers that `await dir.read()` / `for await` work.
// Used by fs-extra's copy, readdirp, globby, etc.
function Dir(path) {
  this.path = String(path);
  this._entries = readdirSync(path, { withFileTypes: true });
  this._pos = 0;
  this._closed = false;
}
Dir.prototype.readSync = function () {
  if (this._pos >= this._entries.length) return null;
  return this._entries[this._pos++];
};
Dir.prototype.read = function (cb) {
  var self = this;
  var p = new Promise(function (res) { queueMicrotask(function () { res(self.readSync()); }); });
  if (typeof cb === 'function') { p.then(function (d) { cb(null, d); }, function (e) { cb(e); }); return; }
  return p;
};
Dir.prototype.closeSync = function () { this._closed = true; };
Dir.prototype.close = function (cb) {
  this._closed = true;
  var p = Promise.resolve();
  if (typeof cb === 'function') { p.then(function () { cb(null); }); return; }
  return p;
};
Dir.prototype[Symbol.asyncIterator] = function () {
  var self = this;
  return {
    next: function () {
      return self.read().then(function (d) {
        return d === null ? { value: undefined, done: true } : { value: d, done: false };
      });
    },
  };
};
function opendirSync(p) { return new Dir(p); }
function opendirAsync(p, options, cb) {
  if (typeof options === 'function') { cb = options; }
  var result;
  try { result = new Dir(p); } catch (e) { if (cb) return cb(e); throw e; }
  if (cb) queueMicrotask(function () { cb(null, result); });
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
// throwIfNoEntry:false makes a missing path return undefined instead of throwing.
function statImpl(p, follow, options) {
  try { return new Stats(JSON.parse(__velox_stat(fsPath(p), follow)), !!(options && options.bigint)); }
  catch (e) {
    if (options && options.throwIfNoEntry === false && e && e.code === 'ENOENT') return undefined;
    throw e;
  }
}
function statSync(p, options) { return statImpl(p, true, options); }
function lstatSync(p, options) { return statImpl(p, false, options); }
function readdirSync(p, options) {
  var names = JSON.parse(__velox_readdir(fsPath(p)));
  if (options && options.withFileTypes) {
    return names.map(function (n) { return direntFor(p, n); });
  }
  return names;
}
function mkdirSync(p, options) {
  __velox_mkdir(fsPath(p), !!(options && typeof options === 'object' && options.recursive));
}
function rmSync(p, options) {
  __velox_rm(fsPath(p), !!(options && options.recursive), !!(options && options.force));
}
function rmdirSync(p, options) {
  __velox_rm(fsPath(p), !!(options && options.recursive), false);
}
function unlinkSync(p) { __velox_rm(fsPath(p), false, false); }
function renameSync(a, b) { __velox_rename(fsPath(a), fsPath(b)); }
function realpathSync(p) { return __velox_realpath(fsPath(p)); }
function accessSync(p) { if (!__velox_exists(fsPath(p))) { throw globalThis.__velox_fs_error('ENOENT', 'ENOENT: no such file or directory, access \'' + p + '\''); } }
function copyFileSync(src, dest) { writeFileSync(dest, readFileSync(src)); }
// symlink: `target` is the link contents and need not exist, so only normalize
// it when it's a file: URL (a plain relative/absolute string is passed through).
function symlinkTarget(target) {
  if (target && typeof target === 'object' && target.protocol === 'file:') return fsPath(target);
  var s = String(target);
  if (s.slice(0, 7) === 'file://') return fsPath(target);
  return s;
}
function symlinkSync(target, path, type) { __velox_symlink(symlinkTarget(target), fsPath(path)); }
function readlinkSync(p, options) {
  var t = __velox_readlink(fsPath(p));
  if (options && (options === 'buffer' || options.encoding === 'buffer')) return globalThis.Buffer.from(t, 'utf8');
  return t;
}
function linkSync(existingPath, newPath) { __velox_link(fsPath(existingPath), fsPath(newPath)); }
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
function realpathSyncNative(p) { return __velox_realpath(fsPath(p)); }
realpathSync.native = realpathSyncNative;

// node:fs statfs (Node 19): filesystem statistics. The native returns numeric
// fields as JSON; with `{ bigint: true }` Node returns them as BigInts.
function statfsSync(p, options) {
  var o = JSON.parse(__velox_statfs(fsPath(p)));
  if (options && options.bigint) {
    return {
      type: BigInt(o.type), bsize: BigInt(o.bsize), blocks: BigInt(o.blocks),
      bfree: BigInt(o.bfree), bavail: BigInt(o.bavail), files: BigInt(o.files),
      ffree: BigInt(o.ffree),
    };
  }
  return {
    type: o.type, bsize: o.bsize, blocks: o.blocks, bfree: o.bfree,
    bavail: o.bavail, files: o.files, ffree: o.ffree,
  };
}
function statfsAsync(p, options, cb) {
  if (typeof options === 'function') { cb = options; options = undefined; }
  Promise.resolve().then(function () {
    var value;
    try { value = statfsSync(p, options); }
    catch (e) { if (cb) cb(e); return; }
    if (cb) cb(null, value);
  });
}

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
  // The 'x' flag (wx/ax) requires the file NOT to exist — fail with EEXIST.
  if (flags.indexOf('x') !== -1 && exists) {
    throw globalThis.__velox_fs_error('EEXIST', "EEXIST: file already exists, open '" + p + "'");
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
// Permission/ownership/time metadata ops. velox has no native chmod/chown, so
// these are best-effort no-ops — present so libraries (graceful-fs, fs-extra)
// that `promisify(fs.chmod)` at load time work, and chmod/chown calls succeed.
function chmodSync() {}
function fchmodSync() {}
function lchmodSync() {}
function chownSync() {}
function fchownSync() {}
function lchownSync() {}
function utimesSync() {}
function futimesSync() {}
function lutimesSync() {}

// Async fd read/write — Node calls back with (err, bytesRead/Written, buffer).
function read(fd, buffer, offset, length, position, cb) {
  if (typeof offset === 'object' && offset !== null) {
    // fs.read(fd, options, cb) / fs.read(fd, buffer, options, cb)
    var opts = offset;
    cb = length;
    offset = opts.offset || 0;
    length = opts.length === undefined ? buffer.length - offset : opts.length;
    position = opts.position == null ? null : opts.position;
  }
  Promise.resolve().then(function () {
    try {
      var bytesRead = readSync(fd, buffer, offset, length, position);
      if (cb) cb(null, bytesRead, buffer);
    } catch (e) { if (cb) cb(e); }
  });
}
function write() {
  var args = Array.prototype.slice.call(arguments);
  var cb = args.pop();
  var buffer = args[1];
  Promise.resolve().then(function () {
    try {
      var bytesWritten = writeSync.apply(null, args);
      if (cb) cb(null, bytesWritten, buffer);
    } catch (e) { if (cb) cb(e); }
  });
}

// --- vectored read/write (in terms of the single-buffer fd primitives) -----
// readv/writev operate on an array of ArrayBufferViews; we drive the existing
// readSync/writeSync for each buffer in turn, advancing `position` when given.
function writevSync(fd, buffers, position) {
  var total = 0;
  var pos = typeof position === 'number' ? position : null;
  for (var i = 0; i < buffers.length; i++) {
    var buf = buffers[i];
    var n = writeSync(fd, buf, 0, buf.length, pos);
    total += n;
    if (pos !== null) pos += n;
  }
  return total;
}
function readvSync(fd, buffers, position) {
  var total = 0;
  var pos = typeof position === 'number' ? position : null;
  for (var i = 0; i < buffers.length; i++) {
    var buf = buffers[i];
    var n = readSync(fd, buf, 0, buf.length, pos);
    total += n;
    if (pos !== null) pos += n;
    if (n < buf.length) break; // short read: end of file
  }
  return total;
}
function writev(fd, buffers, position, cb) {
  if (typeof position === 'function') { cb = position; position = null; }
  Promise.resolve().then(function () {
    try {
      var bytes = writevSync(fd, buffers, position);
      if (cb) cb(null, bytes, buffers);
    } catch (e) { if (cb) cb(e); }
  });
}
function readv(fd, buffers, position, cb) {
  if (typeof position === 'function') { cb = position; position = null; }
  Promise.resolve().then(function () {
    try {
      var bytes = readvSync(fd, buffers, position);
      if (cb) cb(null, bytes, buffers);
    } catch (e) { if (cb) cb(e); }
  });
}

// --- FileHandle (fs.promises.open) -----------------------------------------
// Wraps a synthetic fd from openSync; methods drive the sync fd primitives and
// resolve on the microtask queue, matching the rest of this shim.
function FileHandle(fd, path) {
  this.fd = fd;
  this._path = path;
}
FileHandle.prototype.read = function (buffer, offset, length, position) {
  var self = this;
  // Node-21 object form: read({ buffer, offset, length, position })
  if (buffer && typeof buffer === 'object' && !globalThis.Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) {
    var o = buffer;
    buffer = o.buffer || globalThis.Buffer.alloc(16384);
    offset = o.offset || 0;
    length = o.length === undefined ? buffer.length - offset : o.length;
    position = o.position == null ? null : o.position;
  }
  return new Promise(function (res, rej) {
    queueMicrotask(function () {
      try {
        var bytesRead = readSync(self.fd, buffer, offset, length, position == null ? null : position);
        res({ bytesRead: bytesRead, buffer: buffer });
      } catch (e) { rej(e); }
    });
  });
};
FileHandle.prototype.write = function (buffer, offset, length, position) {
  var self = this;
  // Node-21 object form: write({ buffer, offset, length, position })
  if (buffer && typeof buffer === 'object' && !globalThis.Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array) && typeof buffer !== 'string') {
    var o = buffer;
    buffer = o.buffer;
    offset = o.offset;
    length = o.length;
    position = o.position;
  }
  return new Promise(function (res, rej) {
    queueMicrotask(function () {
      try {
        var bytesWritten = writeSync(self.fd, buffer, offset, length, position);
        res({ bytesWritten: bytesWritten, buffer: buffer });
      } catch (e) { rej(e); }
    });
  });
};
FileHandle.prototype.readFile = function (options) {
  var self = this;
  return new Promise(function (res, rej) {
    queueMicrotask(function () {
      try { res(readFileSync(self._path, options)); } catch (e) { rej(e); }
    });
  });
};
FileHandle.prototype.writeFile = function (data, options) {
  var self = this;
  return new Promise(function (res, rej) {
    queueMicrotask(function () {
      try { writeFileSync(self._path, data, options); res(); } catch (e) { rej(e); }
    });
  });
};
FileHandle.prototype.appendFile = function (data, options) {
  var self = this;
  return new Promise(function (res, rej) {
    queueMicrotask(function () {
      try { appendFileSync(self._path, data, options); res(); } catch (e) { rej(e); }
    });
  });
};
FileHandle.prototype.stat = function (options) {
  var self = this;
  return new Promise(function (res, rej) {
    queueMicrotask(function () {
      try { res(statSync(self._path, options)); } catch (e) { rej(e); }
    });
  });
};
FileHandle.prototype.truncate = function (len) {
  var self = this;
  return new Promise(function (res, rej) {
    queueMicrotask(function () {
      try { ftruncateSync(self.fd, len); res(); } catch (e) { rej(e); }
    });
  });
};
FileHandle.prototype.sync = function () { return Promise.resolve(); };
FileHandle.prototype.datasync = function () { return Promise.resolve(); };
FileHandle.prototype.chmod = function () { return Promise.resolve(); };
FileHandle.prototype.chown = function () { return Promise.resolve(); };
FileHandle.prototype.utimes = function () { return Promise.resolve(); };
FileHandle.prototype.close = function () {
  var self = this;
  return new Promise(function (res) { queueMicrotask(function () { closeSync(self.fd); res(); }); });
};

function promisesOpen(p, flags, mode) {
  return new Promise(function (res, rej) {
    queueMicrotask(function () {
      try {
        var fd = openSync(p, flags, mode);
        res(new FileHandle(fd, fsPath(p)));
      } catch (e) { rej(e); }
    });
  });
}

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
  if (typeof options === 'function') { cb = options; options = undefined; }
  var bigint = !!(options && options.bigint);
  fsOpAsync('stat', p, cb, function (t) { return new Stats(JSON.parse(t), bigint); });
}
function lstatAsync(p, options, cb) {
  if (typeof options === 'function') { cb = options; options = undefined; }
  var bigint = !!(options && options.bigint);
  fsOpAsync('lstat', p, cb, function (t) { return new Stats(JSON.parse(t), bigint); });
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

// node:fs cp (Node 16): recursively copy a file or directory tree.
function cpSync(src, dest, options) {
  options = options || {};
  var path = require('node:path');
  if (options.filter && options.filter(src, dest) === false) return;
  var st = options.dereference ? statSync(src) : lstatSync(src);
  if (st.isDirectory()) {
    if (!options.recursive) {
      var e = new Error("EISDIR: illegal operation on a directory, cp '" + src + "' -> '" + dest + "'");
      e.code = 'EISDIR';
      throw e;
    }
    mkdirSync(dest, { recursive: true });
    var entries = readdirSync(src);
    for (var i = 0; i < entries.length; i++) {
      cpSync(path.join(src, entries[i]), path.join(dest, entries[i]), options);
    }
  } else {
    if (options.errorOnExist && existsSync(dest)) {
      var ee = new Error("EEXIST: file already exists, cp '" + src + "' -> '" + dest + "'");
      ee.code = 'EEXIST';
      throw ee;
    }
    if (options.force === false && existsSync(dest)) return;
    var pdir = path.dirname(dest);
    if (pdir && pdir !== '.' && !existsSync(pdir)) mkdirSync(pdir, { recursive: true });
    copyFileSync(src, dest);
  }
}
function cp(src, dest, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  try {
    cpSync(src, dest, options);
    Promise.resolve().then(function () { if (callback) callback(null); });
  } catch (e) {
    Promise.resolve().then(function () { if (callback) callback(e); });
  }
}

// node:fs glob (Node 22): walk from `cwd` and match each relative path with
// path.matchesGlob. `pattern` may be a string or an array; `options` accepts
// `cwd`, `exclude` (fn or glob array), and `withFileTypes`.
function globSync(pattern, options) {
  options = options || {};
  var path = require('node:path');
  var cwd = options.cwd || (globalThis.process && process.cwd ? process.cwd() : '.');
  var patterns = Array.isArray(pattern) ? pattern : [pattern];
  var withFileTypes = !!options.withFileTypes;
  var exclude = options.exclude;
  function isExcluded(rel) {
    if (typeof exclude === 'function') return !!exclude(rel);
    if (Array.isArray(exclude)) return exclude.some(function (p) { return path.matchesGlob(rel, p); });
    return false;
  }
  var out = [];
  function walk(dir, rel) {
    var entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (var i = 0; i < entries.length; i++) {
      var ent = entries[i];
      var childRel = rel ? rel + '/' + ent.name : ent.name;
      if (isExcluded(childRel)) continue;
      for (var j = 0; j < patterns.length; j++) {
        if (path.matchesGlob(childRel, patterns[j])) { out.push(withFileTypes ? ent : childRel); break; }
      }
      if (ent.isDirectory()) walk(path.join(dir, ent.name), childRel);
    }
  }
  // Start the walk at the pattern's literal directory prefix (for a single
  // pattern) so a scoped glob doesn't descend the whole tree.
  var startRel = '';
  if (patterns.length === 1) {
    var segs = String(patterns[0]).split('/');
    var base = [];
    for (var s = 0; s < segs.length - 1; s++) {
      if (/[*?[\]{}()!+@]/.test(segs[s])) break;
      base.push(segs[s]);
    }
    startRel = base.join('/');
  }
  walk(startRel ? path.join(cwd, startRel) : cwd, startRel);
  return out;
}

function globAsyncIterator(pattern, options) {
  var items = globSync(pattern, options);
  var i = 0;
  var iter = {
    next: function () {
      return Promise.resolve(
        i < items.length ? { value: items[i++], done: false } : { value: undefined, done: true }
      );
    },
  };
  iter[Symbol.asyncIterator] = function () { return iter; };
  return iter;
}

// `fs.glob(pattern[, options], callback)` calls back with (err, matches); with
// no callback it returns an async iterator.
function glob(pattern, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (typeof callback === 'function') {
    try {
      var m = globSync(pattern, options);
      Promise.resolve().then(function () { callback(null, m); });
    } catch (e) {
      Promise.resolve().then(function () { callback(e); });
    }
    return;
  }
  return globAsyncIterator(pattern, options);
}

// node:fs openAsBlob (Node 19): resolve to a Blob of the file's contents.
function openAsBlob(p, options) {
  return new Promise(function (res, rej) {
    readFile(p, function (e, buf) {
      if (e) return rej(e);
      res(new globalThis.Blob([buf], { type: (options && options.type) || '' }));
    });
  });
}

var promises = {
  readFile: function (p, o) { return new Promise(function (res, rej) { readFile(p, o, function (e, d) { e ? rej(e) : res(d); }); }); },
  writeFile: function (p, d, o) { return new Promise(function (res, rej) { writeFile(p, d, o, function (e) { e ? rej(e) : res(); }); }); },
  appendFile: promisify(appendFileSync),
  stat: function (p, o) { return new Promise(function (res, rej) { statAsync(p, o, function (e, d) { e ? rej(e) : res(d); }); }); },
  lstat: function (p, o) { return new Promise(function (res, rej) { lstatAsync(p, o, function (e, d) { e ? rej(e) : res(d); }); }); },
  statfs: function (p, o) { return new Promise(function (res, rej) { statfsAsync(p, o, function (e, d) { e ? rej(e) : res(d); }); }); },
  readdir: function (p, o) { return new Promise(function (res, rej) { readdirAsync(p, o, function (e, d) { e ? rej(e) : res(d); }); }); },
  // Mutation ops now run off-thread (see fsMutAsync) rather than sync-backed.
  mkdir: function (p, o) { return new Promise(function (res, rej) { mkdirAsync(p, o, function (e) { e ? rej(e) : res(undefined); }); }); },
  rm: function (p, o) { return new Promise(function (res, rej) { rmAsync(p, o, function (e) { e ? rej(e) : res(); }); }); },
  rmdir: function (p, o) { return new Promise(function (res, rej) { rmdirAsync(p, o, function (e) { e ? rej(e) : res(); }); }); },
  unlink: function (p) { return new Promise(function (res, rej) { unlinkAsync(p, function (e) { e ? rej(e) : res(); }); }); },
  rename: function (a, b) { return new Promise(function (res, rej) { renameAsync(a, b, function (e) { e ? rej(e) : res(); }); }); },
  copyFile: function (s, d, m) { return new Promise(function (res, rej) { copyFileAsync(s, d, m, function (e) { e ? rej(e) : res(); }); }); },
  realpath: promisify(realpathSync),
  symlink: function (target, path, type) { return new Promise(function (res, rej) { queueMicrotask(function () { try { symlinkSync(target, path, type); res(); } catch (e) { rej(e); } }); }); },
  readlink: function (p, o) { return new Promise(function (res, rej) { queueMicrotask(function () { try { res(readlinkSync(p, o)); } catch (e) { rej(e); } }); }); },
  link: function (existingPath, newPath) { return new Promise(function (res, rej) { queueMicrotask(function () { try { linkSync(existingPath, newPath); res(); } catch (e) { rej(e); } }); }); },
  open: promisesOpen,
  opendir: function (p, o) { return new Promise(function (res, rej) { opendirAsync(p, o, function (e, d) { e ? rej(e) : res(d); }); }); },
  access: promisify(accessSync),
  mkdtemp: promisify(mkdtempSync),
  glob: function (pattern, options) { return globAsyncIterator(pattern, options); },
  cp: function (src, dest, options) { return new Promise(function (res, rej) { cp(src, dest, options || {}, function (e) { e ? rej(e) : res(); }); }); },
};

module.exports = {
  readFileSync: readFileSync,
  writeFileSync: writeFileSync,
  appendFileSync: appendFileSync,
  existsSync: existsSync,
  statSync: statSync,
  lstatSync: lstatSync,
  statfsSync: statfsSync,
  readdirSync: readdirSync,
  opendirSync: opendirSync,
  opendir: opendirAsync,
  Dir: Dir,
  globSync: globSync,
  glob: glob,
  cpSync: cpSync,
  cp: cp,
  mkdirSync: mkdirSync,
  rmSync: rmSync,
  rmdirSync: rmdirSync,
  unlinkSync: unlinkSync,
  renameSync: renameSync,
  realpathSync: realpathSync,
  accessSync: accessSync,
  copyFileSync: copyFileSync,
  symlinkSync: symlinkSync,
  readlinkSync: readlinkSync,
  linkSync: linkSync,
  mkdtempSync: mkdtempSync,
  mkdtemp: callbackify(mkdtempSync, true),
  openSync: openSync,
  closeSync: closeSync,
  readSync: readSync,
  writeSync: writeSync,
  readvSync: readvSync,
  writevSync: writevSync,
  fstatSync: fstatSync,
  ftruncateSync: ftruncateSync,
  truncateSync: truncateSync,
  fsyncSync: fsyncSync,
  fdatasyncSync: fdatasyncSync,
  chmodSync: chmodSync,
  fchmodSync: fchmodSync,
  lchmodSync: lchmodSync,
  chownSync: chownSync,
  fchownSync: fchownSync,
  lchownSync: lchownSync,
  utimesSync: utimesSync,
  futimesSync: futimesSync,
  lutimesSync: lutimesSync,
  open: callbackify(openSync, true),
  close: callbackify(closeSync, false),
  read: read,
  write: write,
  readv: readv,
  writev: writev,
  fstat: callbackify(fstatSync, true),
  ftruncate: callbackify(ftruncateSync, false),
  truncate: callbackify(truncateSync, false),
  fsync: callbackify(fsyncSync, false),
  fdatasync: callbackify(fdatasyncSync, false),
  chmod: callbackify(chmodSync, false),
  fchmod: callbackify(fchmodSync, false),
  lchmod: callbackify(lchmodSync, false),
  chown: callbackify(chownSync, false),
  fchown: callbackify(fchownSync, false),
  lchown: callbackify(lchownSync, false),
  utimes: callbackify(utimesSync, false),
  futimes: callbackify(futimesSync, false),
  lutimes: callbackify(lutimesSync, false),
  createReadStream: createReadStream,
  createWriteStream: createWriteStream,
  // Node exposes the stream classes; `new fs.ReadStream(path, opts)` is
  // equivalent to createReadStream (velox returns a stream.Readable/Writable).
  ReadStream: function ReadStream(p, options) { return createReadStream(p, options); },
  WriteStream: function WriteStream(p, options) { return createWriteStream(p, options); },
  FileReadStream: function FileReadStream(p, options) { return createReadStream(p, options); },
  FileWriteStream: function FileWriteStream(p, options) { return createWriteStream(p, options); },
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
  statfs: statfsAsync,
  readdir: readdirAsync,
  mkdir: mkdirAsync,
  rm: rmAsync,
  rmdir: rmdirAsync,
  unlink: function (p, cb) { unlinkAsync(p, cb); },
  rename: function (a, b, cb) { renameAsync(a, b, cb); },
  realpath: callbackify(realpathSync, true),
  access: callbackify(accessSync, false),
  copyFile: copyFileAsync,
  symlink: callbackify(symlinkSync, false),
  readlink: callbackify(readlinkSync, true),
  link: callbackify(linkSync, false),
  openAsBlob: openAsBlob,
  FileHandle: FileHandle,
  Stats: Stats,
  Dirent: Dirent,
  constants: constants,
  promises: promises,
};
// graceful-fs probes `fs.realpath.native` and warns ("Is fs being
// monkey-patched?") if it's missing; expose it on both the callback and the
// promise-based realpath (it has the same behaviour as plain realpath here).
module.exports.realpath.native = module.exports.realpath;
promises.realpath.native = promises.realpath;
module.exports.default = module.exports;

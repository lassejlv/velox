// node:child_process — process spawning over the native bridge.
//
//   __velox_spawn_sync(file, argsJson, optsJson) -> JSON result (blocking)
//   __velox_exec(file, argsJson, optsJson, token) -> starts on a worker thread,
//        later calls globalThis.__velox_exec_done(token, resultJson)
//
// All process I/O crosses as latin1 strings (one char per byte). The result
// JSON shape is:
//   { status, signal, stdout (latin1), stderr (latin1), pid, error }

var stream = require('node:stream');
var EventEmitter = require('node:events');
var Readable = stream.Readable;
var Writable = stream.Writable;

// --- argument normalisation ------------------------------------------------

// Node lets you call spawn/exec family as (file, args?, options?). Normalise
// the overloads into a { args, options } pair.
function normalize(args, options) {
  if (Array.isArray(args)) {
    options = options || {};
  } else {
    // args omitted. If the slot held an options object use it; otherwise keep
    // the options that were passed explicitly (e.g. spawnSync(file, undefined, opts)).
    if (args && typeof args === 'object') options = args;
    else options = options || {};
    args = [];
  }
  return { args: args, options: options };
}

// Decode a latin1 payload into the form the caller asked for (Buffer default,
// or a decoded string when options.encoding is set; 'buffer' forces Buffer).
function decodeOut(latin1, encoding) {
  var buf = globalThis.Buffer.from(latin1 == null ? '' : latin1, 'latin1');
  if (encoding && encoding !== 'buffer') return buf.toString(encoding);
  return buf;
}

// Build the options JSON the native side understands.
function buildOpts(options, shell) {
  var input = null;
  if (options.input != null) {
    input = globalThis.Buffer.isBuffer(options.input)
      ? options.input.toString('latin1')
      : globalThis.Buffer.from(String(options.input), 'utf8').toString('latin1');
  }
  return {
    cwd: options.cwd != null ? String(options.cwd) : null,
    env: options.env || null,
    input: input,
    shell: shell != null ? shell : !!options.shell,
    maxBuffer: options.maxBuffer != null ? options.maxBuffer : 1024 * 1024,
    timeout: options.timeout != null ? options.timeout : 0,
  };
}

// --- synchronous API -------------------------------------------------------

function spawnSync(file, args, options) {
  var n = normalize(args, options);
  var opts = n.options;
  var raw = __velox_spawn_sync(
    String(file),
    JSON.stringify(n.args),
    JSON.stringify(buildOpts(opts, opts.shell))
  );
  var r = JSON.parse(raw);
  var enc = opts.encoding;
  var stdout = decodeOut(r.stdout, enc);
  var stderr = decodeOut(r.stderr, enc);
  var error = null;
  if (r.error) { error = new Error(r.error); }
  return {
    pid: r.pid,
    status: r.status,
    signal: r.signal,
    stdout: stdout,
    stderr: stderr,
    output: [null, stdout, stderr],
    error: error,
  };
}

// Shared body for execSync/execFileSync: run sync, throw on failure, return
// stdout. `shell` selects the exec vs execFile behaviour.
function execSyncImpl(file, args, options, shell) {
  var n = normalize(args, options);
  var opts = n.options;
  opts.shell = shell;
  var r = spawnSync(file, shell ? undefined : n.args, opts);
  if (r.error) throw r.error;
  if (r.status !== 0 && r.status !== null) {
    var err = new Error('Command failed: ' + file +
      (r.stderr ? '\n' + r.stderr.toString() : ''));
    err.status = r.status;
    err.signal = r.signal;
    err.pid = r.pid;
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    err.output = r.output;
    throw err;
  }
  return r.stdout;
}

function execSync(command, options) {
  return execSyncImpl(command, undefined, options || {}, true);
}
function execFileSync(file, args, options) {
  var n = normalize(args, options);
  return execSyncImpl(file, n.args, n.options, false);
}

// --- async exec_done registry ----------------------------------------------

var _nextToken = 1;
var _pending = Object.create(null); // token -> handler(resultJson)

// The native worker thread calls back here when a process finishes. Dispatch
// to the registered handler and drop it from the registry.
globalThis.__velox_exec_done = function (token, resultJson) {
  var handler = _pending[token];
  if (!handler) return;
  delete _pending[token];
  handler(resultJson);
};

// --- ChildProcess ----------------------------------------------------------

function ChildProcess() {
  EventEmitter.call(this);
  this.pid = null;
  this.exitCode = null;
  this.signalCode = null;
  this.killed = false;
  this._token = null;

  // stdout/stderr are Readable; data is pushed when the process finishes.
  this.stdout = new Readable({ read: function () {} });
  this.stderr = new Readable({ read: function () {} });
  // stdin is a write-only stub — we have no live pipe to the child.
  var self = this;
  this.stdin = new Writable({
    write: function (chunk, enc, cb) { cb(); },
  });
  this.stdin.on('error', function () {});
  // Node exposes a `.stdio` array [stdin, stdout, stderr, ...extra]; libraries
  // like execa spread it (`[...subprocess.stdio]`).
  this.stdio = [this.stdin, this.stdout, this.stderr];
  this.channel = null;
}
ChildProcess.prototype = Object.create(EventEmitter.prototype);
ChildProcess.prototype.constructor = ChildProcess;

ChildProcess.prototype.kill = function (signal) {
  this.killed = true;
  // No live handle to signal; mark killed and surface it on the next event.
  this.signalCode = signal || 'SIGTERM';
  return true;
};

// Wire a freshly-built ChildProcess to the native worker and arrange for the
// exec_done callback to drive its streams + lifecycle events.
function startChild(child, file, args, options) {
  var token = _nextToken++;
  child._token = token;

  _pending[token] = function (resultJson) {
    var r;
    try { r = JSON.parse(resultJson); }
    catch (e) { child.emit('error', e); return; }

    child.pid = r.pid;

    // A spawn failure (e.g. ENOENT) surfaces as 'error', no exit/close pair.
    if (r.error) {
      var err = new Error(r.error);
      err.code = r.error;
      child.emit('error', err);
      child.stdout.push(null);
      child.stderr.push(null);
      return;
    }

    // Node emits 'spawn' once the child is successfully started (never on a
    // spawn failure, handled above). Libraries like execa await it.
    child.emit('spawn');

    // The child has fully run; its stdin pipe is closed. End the writable side
    // so consumers waiting on stdin completion (e.g. execa, which awaits every
    // stdio stream) don't hang. Guard against a double-end.
    if (child.stdin && !child.stdin._writableState.ending) {
      try { child.stdin.end(); } catch (e) {}
    }

    // Feed captured output into the readable sides, then EOF them.
    if (r.stdout) child.stdout.push(globalThis.Buffer.from(r.stdout, 'latin1'));
    child.stdout.push(null);
    if (r.stderr) child.stderr.push(globalThis.Buffer.from(r.stderr, 'latin1'));
    child.stderr.push(null);

    child.exitCode = r.status;
    child.signalCode = r.signal;
    child.emit('exit', r.status, r.signal);
    // 'close' fires after stdio is fully consumed; emit on next microtask.
    queueMicrotask(function () {
      child.emit('close', r.status, r.signal);
    });
  };

  // Kick off the worker. If the native call itself throws, report async.
  try {
    __velox_exec(
      String(file),
      JSON.stringify(args || []),
      JSON.stringify(buildOpts(options, options.shell)),
      token
    );
  } catch (e) {
    delete _pending[token];
    queueMicrotask(function () { child.emit('error', e); });
  }
  return child;
}

function spawn(file, args, options) {
  var n = normalize(args, options);
  var child = new ChildProcess();
  return startChild(child, file, n.args, n.options);
}

// --- async exec / execFile -------------------------------------------------

// Shared body: spawn, buffer stdout/stderr, and invoke cb(err, out, err) on
// close. `shell` selects exec (true) vs execFile (false).
function execImpl(file, args, options, cb, shell) {
  options = options || {};
  options.shell = shell;
  // exec/execFile default to utf8 strings (unlike spawn, whose streams stay
  // Buffers); pass encoding: 'buffer' to opt back into Buffers.
  var enc = options.encoding == null ? 'utf8' : options.encoding;

  var child = spawn(file, shell ? [] : args, options);

  var outChunks = [];
  var errChunks = [];
  child.stdout.on('data', function (c) { outChunks.push(c); });
  child.stderr.on('data', function (c) { errChunks.push(c); });

  child.on('error', function (e) {
    if (cb) cb(e, decodeOut('', enc), decodeOut('', enc));
    cb = null;
  });

  child.on('close', function (code, signal) {
    if (!cb) return;
    var stdout = decodeOut(globalThis.Buffer.concat(outChunks).toString('latin1'), enc);
    var stderr = decodeOut(globalThis.Buffer.concat(errChunks).toString('latin1'), enc);
    var err = null;
    if (code !== 0 && code !== null) {
      err = new Error('Command failed: ' + file +
        (stderr ? '\n' + stderr.toString() : ''));
      err.code = code;
      err.signal = signal;
      err.killed = child.killed;
    }
    cb(err, stdout, stderr);
    cb = null;
  });

  return child;
}

function exec(command, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  return execImpl(command, [], options || {}, cb, true);
}
function execFile(file, args, options, cb) {
  // Slide the (args?, options?, cb) overloads.
  if (typeof args === 'function') { cb = args; args = []; options = {}; }
  else if (typeof options === 'function') { cb = options; options = {}; }
  if (!Array.isArray(args)) args = [];
  return execImpl(file, args, options || {}, cb, false);
}

// --- fork: a velox subprocess running a module, with IPC over localhost TCP --

function fork(modulePath, args, options) {
  if (!Array.isArray(args)) { options = args; args = []; }
  args = args || [];
  options = options || {};
  var net = require('node:net');
  var execPath = (typeof process !== 'undefined' && process.execPath) || 'velox';
  var execArgv = options.execArgv || [];

  var child;
  // Parent listens; the child connects back on startup (see the IPC prelude).
  var ipcServer = net.createServer(function (sock) {
    child._ipc = sock;
    child.connected = true;
    var buf = '';
    sock.on('data', function (d) {
      buf += d.toString('utf8');
      var idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        var line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line) continue;
        try { child.emit('message', JSON.parse(line)); } catch (e) {}
      }
    });
    sock.on('close', function () { child.connected = false; child.emit('disconnect'); });
    sock.on('error', function () {});
  });
  ipcServer.listen(0, '127.0.0.1');
  var port = ipcServer.address() && ipcServer.address().port;

  var baseEnv = options.env || (typeof process !== 'undefined' ? process.env : {});
  var env = Object.assign({}, baseEnv, { VELOX_IPC_PORT: String(port) });
  child = spawn(execPath, execArgv.concat([String(modulePath)], args), {
    cwd: options.cwd,
    env: env,
    stdio: options.stdio || 'inherit',
  });
  child.connected = false;
  child.send = function (message, sendHandle, opts, cb) {
    if (typeof sendHandle === 'function') { cb = sendHandle; }
    else if (typeof opts === 'function') { cb = opts; }
    if (!child._ipc) { if (cb) cb(new Error('IPC channel not connected')); return false; }
    try {
      child._ipc.write(JSON.stringify(message) + '\n');
      if (typeof cb === 'function') Promise.resolve().then(cb);
      return true;
    } catch (e) { if (typeof cb === 'function') cb(e); return false; }
  };
  child.disconnect = function () {
    if (child._ipc) child._ipc.end();
    try { ipcServer.close(); } catch (e) {}
    child.connected = false;
    child.emit('disconnect');
  };
  child.on('exit', function () { try { ipcServer.close(); } catch (e) {} });
  return child;
}

// --- exports ---------------------------------------------------------------

module.exports = {
  spawnSync: spawnSync,
  execSync: execSync,
  execFileSync: execFileSync,
  spawn: spawn,
  exec: exec,
  execFile: execFile,
  fork: fork,
  ChildProcess: ChildProcess,
};
module.exports.default = module.exports;

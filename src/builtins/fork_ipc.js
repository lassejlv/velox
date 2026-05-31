// Child-side IPC for `child_process.fork`. When velox is launched as a forked
// child, the parent passes `VELOX_IPC_PORT`; we connect back over localhost TCP
// and wire `process.send` / `process.on('message')` (newline-delimited JSON).
// A no-op for any normally-launched process (no `VELOX_IPC_PORT`).
(function () {
  if (typeof globalThis.process === 'undefined') return;
  var process = globalThis.process;
  if (!process.env || !process.env.VELOX_IPC_PORT) return;

  var port = parseInt(process.env.VELOX_IPC_PORT, 10);
  delete process.env.VELOX_IPC_PORT; // don't leak it to grandchildren
  if (!port) return;

  var net = require('node:net');
  var sock = net.connect(port, '127.0.0.1', function () {
    process.connected = true;
    process.emit('connect');
  });
  var buf = '';
  sock.on('data', function (d) {
    buf += d.toString('utf8');
    var idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      var line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { process.emit('message', JSON.parse(line)); } catch (e) {}
    }
  });
  sock.on('close', function () { process.connected = false; process.emit('disconnect'); });
  sock.on('error', function () {});

  process.send = function (message, sendHandle, opts, cb) {
    if (typeof sendHandle === 'function') { cb = sendHandle; }
    else if (typeof opts === 'function') { cb = opts; }
    try {
      sock.write(JSON.stringify(message) + '\n');
      if (typeof cb === 'function') process.nextTick(cb);
      return true;
    } catch (e) { if (typeof cb === 'function') cb(e); return false; }
  };
  process.disconnect = function () { try { sock.end(); } catch (e) {} };
  process.channel = { ref: function () {}, unref: function () {} };
})();

// node:readline — terminal line editing is minimal, but the keypress decoder is
// real: emitKeypressEvents() parses raw stdin bytes into 'keypress' events so
// interactive prompt libraries (@clack/prompts, inquirer, prompts, enquirer)
// work once stdin is in raw mode (process.stdin.setRawMode(true)).

var EventEmitter = require('node:events');

// --- key decoding ----------------------------------------------------------

// Map a single non-escape character to a key descriptor.
function baseKey(ch) {
  var c = ch.charCodeAt(0);
  var key = { sequence: ch, name: undefined, ctrl: false, meta: false, shift: false };
  if (c === 13) key.name = 'return';
  else if (c === 10) key.name = 'enter';
  else if (c === 9) key.name = 'tab';
  else if (c === 127 || c === 8) key.name = 'backspace';
  else if (c === 27) key.name = 'escape';
  else if (c === 32) key.name = 'space';
  else if (c >= 1 && c <= 26) { key.name = String.fromCharCode(c + 96); key.ctrl = true; }
  else if (c >= 65 && c <= 90) { key.name = ch.toLowerCase(); key.shift = true; }
  else key.name = ch;
  return key;
}

var CSI_NAMES = {
  '[A': 'up', '[B': 'down', '[C': 'right', '[D': 'left', '[E': 'clear',
  '[H': 'home', '[F': 'end', '[Z': 'tab',
  'OA': 'up', 'OB': 'down', 'OC': 'right', 'OD': 'left', 'OH': 'home', 'OF': 'end',
  '[1~': 'home', '[2~': 'insert', '[3~': 'delete', '[4~': 'end',
  '[5~': 'pageup', '[6~': 'pagedown', '[7~': 'home', '[8~': 'end',
};

function csiKey(code, seq) {
  return {
    sequence: seq,
    name: CSI_NAMES[code],
    ctrl: false,
    meta: false,
    shift: code === '[Z',
    code: code,
  };
}

// Consume one key from the front of `s`, emitting via `emit`. Returns the number
// of chars consumed, or 0 if `s` holds only a partial escape sequence (need more).
function consumeKey(s, emit) {
  if (s.length === 0) return 0;
  if (s.charCodeAt(0) === 0x1b) {
    if (s.length === 1) {
      emit('\x1b', { name: 'escape', sequence: '\x1b', ctrl: false, meta: true, shift: false });
      return 1;
    }
    var c1 = s[1];
    if (c1 === '[' || c1 === 'O') {
      var i = 2;
      while (i < s.length && /[0-9;]/.test(s[i])) i++;
      if (i >= s.length) return 0; // incomplete CSI/SS3
      var seq = s.slice(0, i + 1);
      var code = c1 + s.slice(2, i + 1);
      emit(seq, csiKey(code, seq));
      return i + 1;
    }
    // ESC + char → meta/alt-modified key.
    var k = baseKey(s[1]);
    k.meta = true;
    k.sequence = s.slice(0, 2);
    emit(k.sequence, k);
    return 2;
  }
  var ch = s[0];
  emit(ch, baseKey(ch));
  return 1;
}

// emitKeypressEvents(stream[, iface]) — attach a decoder so `stream` emits
// 'keypress' (string, key) events. Idempotent per stream.
function emitKeypressEvents(stream, iface) {
  if (!stream || stream._veloxKeypress) return;
  stream._veloxKeypress = true;
  var buf = '';
  stream.on('data', function (chunk) {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
    var consumed;
    do {
      consumed = consumeKey(buf, function (s, key) {
        stream.emit('keypress', s, key);
        if (iface && typeof iface.emit === 'function') iface.emit('keypress', s, key);
      });
      if (consumed > 0) buf = buf.slice(consumed);
    } while (consumed > 0 && buf.length > 0);
  });
  if (typeof stream.resume === 'function') stream.resume();
}

// --- terminal cursor/erase (write real ANSI to the stream) -----------------

function write(stream, seq) {
  if (stream && typeof stream.write === 'function') { stream.write(seq); return true; }
  return false;
}

exports.clearLine = function (stream, dir) {
  // dir: -1 left, 1 right, 0 entire line.
  var n = dir < 0 ? '1' : dir > 0 ? '' : '2';
  return write(stream, '\x1b[' + n + 'K');
};
exports.clearScreenDown = function (stream) { return write(stream, '\x1b[0J'); };
exports.cursorTo = function (stream, x, y) {
  if (typeof y === 'number') return write(stream, '\x1b[' + (y + 1) + ';' + (x + 1) + 'H');
  return write(stream, '\x1b[' + (x + 1) + 'G');
};
exports.moveCursor = function (stream, dx, dy) {
  var seq = '';
  if (dx < 0) seq += '\x1b[' + -dx + 'D'; else if (dx > 0) seq += '\x1b[' + dx + 'C';
  if (dy < 0) seq += '\x1b[' + -dy + 'A'; else if (dy > 0) seq += '\x1b[' + dy + 'B';
  return seq ? write(stream, seq) : true;
};
exports.emitKeypressEvents = emitKeypressEvents;

// --- Interface -------------------------------------------------------------

function Interface(input, output, completer, terminal) {
  EventEmitter.call(this);
  var opts = input && typeof input === 'object' && !input.on ? input : null;
  if (opts || (input && input.input)) {
    var o = opts || input;
    this.input = o.input || globalThis.process.stdin;
    this.output = o.output;
    this.terminal = o.terminal !== undefined ? o.terminal : !!(this.input && this.input.isTTY);
  } else {
    this.input = input || globalThis.process.stdin;
    this.output = output;
    this.terminal = terminal !== undefined ? terminal : !!(this.input && this.input.isTTY);
  }
  this.line = '';
  this.cursor = 0;
  this._closed = false;
}
Interface.prototype = Object.create(EventEmitter.prototype);
Interface.prototype.constructor = Interface;

// question(query, cb) / question(query, opts, cb) — read one line. Decodes
// keypresses so it works under raw mode; resolves on Enter.
Interface.prototype.question = function (query, optionsOrCb, maybeCb) {
  var cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
  var self = this;
  if (query && this.output) this.output.write(String(query));
  else if (query && globalThis.process.stdout) globalThis.process.stdout.write(String(query));
  var line = '';
  var input = this.input;
  if (!input || typeof input.on !== 'function') {
    if (cb) Promise.resolve().then(function () { cb(''); });
    return;
  }
  function onData(chunk) {
    var s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c === 13 || c === 10) {
        input.removeListener('data', onData);
        self.line = '';
        if (cb) cb(line);
        self.emit('line', line);
        return;
      } else if (c === 127 || c === 8) {
        line = line.slice(0, -1);
      } else if (c >= 32) {
        line += s[i];
      }
    }
    self.line = line;
  }
  input.on('data', onData);
  if (input.resume) input.resume();
};
Interface.prototype.prompt = function () { if (this.output && this._prompt) this.output.write(this._prompt); };
Interface.prototype.setPrompt = function (p) { this._prompt = p; };
Interface.prototype.write = function (data) { if (this.output && data != null) this.output.write(String(data)); };
Interface.prototype.close = function () {
  if (this._closed) return;
  this._closed = true;
  this.emit('close');
};
Interface.prototype.pause = function () { if (this.input && this.input.pause) this.input.pause(); this.emit('pause'); return this; };
Interface.prototype.resume = function () { if (this.input && this.input.resume) this.input.resume(); this.emit('resume'); return this; };
Interface.prototype[Symbol.asyncIterator] = function () {
  var self = this;
  var queue = [];
  var done = false;
  var pending = null;
  this.on('line', function (l) { if (pending) { pending({ value: l, done: false }); pending = null; } else queue.push(l); });
  this.on('close', function () { done = true; if (pending) { pending({ value: undefined, done: true }); pending = null; } });
  return {
    next: function () {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
      if (done) return Promise.resolve({ value: undefined, done: true });
      return new Promise(function (res) { pending = res; });
    },
    [Symbol.asyncIterator]: function () { return this; },
  };
};

exports.Interface = Interface;
exports.createInterface = function (input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
};

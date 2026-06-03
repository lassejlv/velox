// node:repl — a programmatic REPL server.
//
// Covers the API surface packages and Node's tests exercise: repl.start with
// custom input/output streams, dot-commands (defineCommand / .help / .exit /
// .break / .clear / .load / .save), a custom `eval` callback, writer/
// ignoreUndefined options, and 'line'/'exit'/'reset' events. Lines are
// processed synchronously in the input 'data' handler (callers write a line
// and assert on the output immediately, as Node's tests do).

const EventEmitter = require('node:events');
const util = require('node:util');

const REPL_MODE_SLOPPY = Symbol('repl-sloppy');
const REPL_MODE_STRICT = Symbol('repl-strict');

// Thrown (or passed to the eval callback) to signal "input is incomplete,
// keep buffering lines" — multiline editing.
function Recoverable(err) {
  this.err = err;
}
Object.setPrototypeOf(Recoverable.prototype, SyntaxError.prototype);

function defaultWriter(value) {
  return util.inspect(value);
}

function looksRecoverable(message) {
  return /Unexpected end of (input|script)|unterminated/i.test(String(message || ''));
}

function REPLServer(options) {
  if (!(this instanceof REPLServer)) return new REPLServer(options);
  EventEmitter.call(this);
  if (typeof options === 'string') options = { prompt: options };
  options = options || {};

  this.input = options.input || process.stdin;
  this.output = options.output || process.stdout;
  this.terminal = options.terminal !== undefined ? !!options.terminal : !!this.output.isTTY;
  this.useColors = options.useColors !== undefined ? !!options.useColors : false;
  this.ignoreUndefined = !!options.ignoreUndefined;
  this.replMode = options.replMode || REPL_MODE_SLOPPY;
  this.writer = options.writer || defaultWriter;
  this.commands = Object.create(null);
  this.context = createContext();
  this.lines = [];
  this.last = undefined;
  this.editorMode = false;
  this._prompt = options.prompt !== undefined ? options.prompt : '> ';
  this._buffered = '';   // partial input line
  this._multiline = '';  // accumulated recoverable (incomplete) statement
  this._closed = false;

  // The user-provided eval has Node's signature: (cmd, context, file, cb).
  this._eval = options.eval || defaultEval;

  defineDefaultCommands(this);

  const self = this;
  this._onData = function (chunk) {
    const text = typeof chunk === 'string' ? chunk : String(chunk);
    if (self.terminal) self.output.write(text); // echo, as readline would
    self._buffered += text;
    let nl;
    while ((nl = self._buffered.indexOf('\n')) !== -1) {
      const line = self._buffered.slice(0, nl).replace(/\r$/, '');
      self._buffered = self._buffered.slice(nl + 1);
      self._onLine(line);
      if (self._closed) return;
    }
  };
  this.input.on('data', this._onData);
  if (typeof this.input.resume === 'function') this.input.resume();
}
Object.setPrototypeOf(REPLServer.prototype, EventEmitter.prototype);
Object.setPrototypeOf(REPLServer, EventEmitter);

function createContext() {
  // useGlobal-style context: expose the real global object so evaluated code
  // sees the full runtime; `repl.context.foo = …` works because it IS global.
  const ctx = globalThis;
  try { ctx.module = undefined; } catch (e) {}
  return ctx;
}

function defaultEval(code, context, file, cb) {
  let result;
  try {
    result = (0, eval)(code); // indirect eval — global scope
  } catch (err) {
    if (err instanceof SyntaxError && looksRecoverable(err.message)) {
      return cb(new Recoverable(err));
    }
    return cb(err);
  }
  if (result && typeof result.then === 'function') {
    // Top-level await-ish: settle promises like the interactive REPL does.
    result.then(function (v) { cb(null, v); }, function (e) { cb(e); });
    return;
  }
  cb(null, result);
}

REPLServer.prototype.defineCommand = function (keyword, cmd) {
  if (typeof cmd === 'function') cmd = { action: cmd };
  this.commands[keyword] = cmd;
};

REPLServer.prototype.setPrompt = function (prompt) {
  this._prompt = prompt;
};
REPLServer.prototype.getPrompt = function () {
  return this._prompt;
};

REPLServer.prototype.displayPrompt = function (_preserveCursor) {
  this.output.write(this._multiline ? '... ' : this._prompt);
};
REPLServer.prototype.prompt = REPLServer.prototype.displayPrompt;

REPLServer.prototype.clearBufferedCommand = function () {
  this._multiline = '';
};

REPLServer.prototype.write = function (text) {
  this._onData(text);
};

REPLServer.prototype.resetContext = function () {
  this.context = createContext();
  this.emit('reset', this.context);
};

REPLServer.prototype.close = function () {
  if (this._closed) return;
  this._closed = true;
  if (this.input && typeof this.input.removeListener === 'function') {
    this.input.removeListener('data', this._onData);
  }
  this.emit('exit');
  this.emit('close');
};

REPLServer.prototype._onLine = function (line) {
  this.emit('line', line);
  // Dot-command? Only when not inside a multiline statement.
  if (!this._multiline && line[0] === '.' && !/^\.\.?(\/|$)/.test(line)) {
    const sp = line.indexOf(' ');
    const name = (sp === -1 ? line.slice(1) : line.slice(1, sp)).trim();
    const rest = sp === -1 ? '' : line.slice(sp + 1).trim();
    const cmd = this.commands[name];
    if (cmd && typeof cmd.action === 'function') {
      cmd.action.call(this, rest);
      return;
    }
    this.output.write('Invalid REPL keyword\n');
    this.displayPrompt();
    return;
  }

  const code = this._multiline ? this._multiline + '\n' + line : line;
  if (code.trim() === '') {
    this.displayPrompt();
    return;
  }
  this.lines.push(line);

  const self = this;
  this._eval.call(this, code, this.context, 'repl', function (err, result) {
    if (err) {
      if (err instanceof Recoverable) {
        self._multiline = code;
        self.displayPrompt();
        return;
      }
      self._multiline = '';
      const text = err && err.stack ? String(err.stack) : String(err);
      self.output.write('Uncaught ' + text + '\n');
      self.displayPrompt();
      return;
    }
    self._multiline = '';
    self.last = result;
    try { self.context._ = result; } catch (e) {}
    if (!(result === undefined && self.ignoreUndefined)) {
      self.output.write(self.writer(result) + '\n');
    }
    self.displayPrompt();
  });
};

function defineDefaultCommands(repl) {
  repl.defineCommand('break', {
    help: 'Sometimes you get stuck, this gets you out',
    action: function () {
      this.clearBufferedCommand();
      this.displayPrompt();
    },
  });
  repl.defineCommand('clear', {
    help: 'Break, and also clear the local context',
    action: function () {
      this.clearBufferedCommand();
      this.resetContext();
      this.displayPrompt();
    },
  });
  repl.defineCommand('editor', {
    help: 'Enter editor mode',
    action: function () {
      this.editorMode = true;
      this.output.write('// Entering editor mode (Ctrl+D to finish, Ctrl+C to cancel)\n');
    },
  });
  repl.defineCommand('exit', {
    help: 'Exit the REPL',
    action: function () {
      this.close();
    },
  });
  repl.defineCommand('help', {
    help: 'Print this help message',
    action: function () {
      const names = Object.keys(this.commands).sort();
      const longest = names.reduce(function (m, n) { return Math.max(m, n.length); }, 0);
      for (let i = 0; i < names.length; i++) {
        const cmd = this.commands[names[i]];
        const help = cmd.help || '';
        const pad = help ? ' '.repeat(longest - names[i].length + 3) : '';
        this.output.write('.' + names[i] + pad + help + '\n');
      }
      this.output.write('\nPress Ctrl+C to abort current expression, Ctrl+D to exit the REPL\n');
      this.displayPrompt();
    },
  });
  repl.defineCommand('load', {
    help: 'Load JS from a file into the REPL session',
    action: function (file) {
      try {
        const src = require('node:fs').readFileSync(file, 'utf8');
        this.write(src + '\n');
      } catch (e) {
        this.output.write('Failed to load: ' + file + '\n');
      }
      this.displayPrompt();
    },
  });
  repl.defineCommand('save', {
    help: 'Save all evaluated commands in this REPL session to a file',
    action: function (file) {
      try {
        require('node:fs').writeFileSync(file, this.lines.join('\n') + '\n');
        this.output.write('Session saved to: ' + file + '\n');
      } catch (e) {
        this.output.write('Failed to save: ' + file + '\n');
      }
      this.displayPrompt();
    },
  });
}

function start(options) {
  return new REPLServer(options);
}

module.exports = {
  start,
  REPLServer,
  Recoverable,
  REPL_MODE_SLOPPY,
  REPL_MODE_STRICT,
  writer: defaultWriter,
};
module.exports.default = module.exports;

// better-sqlite3 — velox can't load the native .node addon, so we shim its
// (synchronous) API on top of node:sqlite, which is itself backed by rusqlite.
// This makes the SQLite ecosystem that targets better-sqlite3 — knex, Drizzle,
// Kysely, TypeORM, many apps — run against a real embedded database. Registered
// as a builtin so `require('better-sqlite3')` routes here instead of the
// (unusable) native package the user installed.

var sqlite = require('node:sqlite');
var fs = require('node:fs');

// --- Statement -------------------------------------------------------------

function Statement(stmt, db, source) {
  this._stmt = stmt;
  this.database = db;
  this.source = source;
  this.reader = /^\s*select/i.test(source) || /returning/i.test(source);
  this._pluck = false;
  this._raw = false;
  this._expand = false;
}

function valuesInOrder(obj) {
  var out = [];
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) out.push(obj[k]);
  return out;
}

Statement.prototype._shape = function (row) {
  if (row === undefined) return undefined;
  if (this._pluck) { for (var k in row) return row[k]; return undefined; }
  if (this._raw) return valuesInOrder(row);
  return row;
};

// better-sqlite3 spreads a lone array argument as positional parameters (knex
// and Kysely's drivers call `stmt.all([a, b])`); node:sqlite expects them
// variadic. A lone object stays a single arg (named params).
function bindArgs(args) {
  if (args.length === 1 && Array.isArray(args[0])) return args[0];
  return args;
}

Statement.prototype.run = function () {
  return this._stmt.run.apply(this._stmt, bindArgs(arguments));
};
Statement.prototype.get = function () {
  return this._shape(this._stmt.get.apply(this._stmt, bindArgs(arguments)));
};
Statement.prototype.all = function () {
  var rows = this._stmt.all.apply(this._stmt, bindArgs(arguments));
  if (!this._pluck && !this._raw) return rows;
  var self = this;
  return rows.map(function (r) { return self._shape(r); });
};
Statement.prototype.iterate = function () {
  var inner = this._stmt.iterate.apply(this._stmt, bindArgs(arguments));
  var self = this;
  var it = {
    next: function () {
      var n = inner.next();
      return n.done ? n : { value: self._shape(n.value), done: false };
    },
    return: function () { return inner.return ? inner.return() : { value: undefined, done: true }; },
  };
  it[Symbol.iterator] = function () { return this; };
  return it;
};
Statement.prototype.pluck = function (toggle) { this._pluck = toggle !== false; return this; };
Statement.prototype.raw = function (toggle) { this._raw = toggle !== false; return this; };
Statement.prototype.expand = function (toggle) { this._expand = toggle !== false; return this; };
Statement.prototype.bind = function () {
  this._bound = Array.prototype.slice.call(arguments);
  return this;
};
Statement.prototype.columns = function () {
  return typeof this._stmt.columns === 'function' ? this._stmt.columns() : [];
};
Statement.prototype.safeIntegers = function (toggle) {
  this._stmt.setReadBigInts(toggle !== false);
  return this;
};

// --- Database --------------------------------------------------------------

function Database(filename, options) {
  if (!(this instanceof Database)) return new Database(filename, options);
  options = options || {};
  this.memory = filename === ':memory:' || filename === undefined || filename === '' || !!options.memory;
  this.name = this.memory ? ':memory:' : String(filename);
  this.readonly = !!options.readonly;
  if (options.fileMustExist && !this.memory && !fs.existsSync(this.name)) {
    throw new Error('unable to open database file: ' + this.name);
  }
  this._db = new sqlite.DatabaseSync(this.name);
  this.open = true;
  this.inTransaction = false;
  this._txDepth = 0;
}

Database.prototype.prepare = function (sql) {
  return new Statement(this._db.prepare(sql), this, String(sql));
};

Database.prototype.exec = function (sql) {
  this._db.exec(String(sql));
  return this;
};

// pragma('journal_mode = WAL'[, {simple}]) — runs PRAGMA, returns result rows
// (or a scalar with {simple:true}). Some pragmas return nothing.
Database.prototype.pragma = function (source, options) {
  var simple = options && options.simple;
  var rows;
  try {
    rows = this._db.prepare('PRAGMA ' + source).all();
  } catch (e) {
    this._db.exec('PRAGMA ' + source);
    rows = [];
  }
  if (simple) {
    if (!rows.length) return undefined;
    for (var k in rows[0]) return rows[0][k];
    return undefined;
  }
  return rows;
};

// transaction(fn) → a function that wraps fn in BEGIN/COMMIT (ROLLBACK on
// throw), nesting via SAVEPOINTs. The .deferred/.immediate/.exclusive variants
// map to the same behaviour here.
Database.prototype.transaction = function (fn) {
  if (typeof fn !== 'function') throw new TypeError('Expected first argument to be a function');
  var self = this;
  var wrap = function () {
    var top = self._txDepth === 0;
    var sp = 'sp_' + self._txDepth;
    self._db.exec(top ? 'BEGIN' : 'SAVEPOINT ' + sp);
    self._txDepth++;
    if (top) self.inTransaction = true;
    try {
      var result = fn.apply(this, arguments);
      self._txDepth--;
      self._db.exec(top ? 'COMMIT' : 'RELEASE ' + sp);
      if (top) self.inTransaction = false;
      return result;
    } catch (e) {
      self._txDepth--;
      if (top) { self._db.exec('ROLLBACK'); self.inTransaction = false; }
      else { self._db.exec('ROLLBACK TO ' + sp); self._db.exec('RELEASE ' + sp); }
      throw e;
    }
  };
  wrap.deferred = wrap;
  wrap.immediate = wrap;
  wrap.exclusive = wrap;
  return wrap;
};

Database.prototype.close = function () {
  if (this.open) { this._db.close(); this.open = false; }
  return this;
};

Database.prototype.function = function () {
  throw new Error('better-sqlite3 .function() is not supported in velox yet');
};
Database.prototype.aggregate = function () {
  throw new Error('better-sqlite3 .aggregate() is not supported in velox yet');
};
Database.prototype.loadExtension = function () {
  throw new Error('better-sqlite3 .loadExtension() is not supported in velox');
};
Database.prototype.defaultSafeIntegers = function () { return this; };
Database.prototype.unsafeMode = function () { return this; };
Database.prototype.serialize = function () {
  throw new Error('better-sqlite3 .serialize() is not supported in velox yet');
};
Database.prototype.backup = function () {
  return Promise.reject(new Error('better-sqlite3 .backup() is not supported in velox yet'));
};

Database.Database = Database;
Database.SqliteError = Error;
module.exports = Database;
module.exports.default = Database;

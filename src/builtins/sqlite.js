// node:sqlite — synchronous SQLite, backed by the native rusqlite bridge
// (__velox_sqlite_*). Implements the Node 22 API surface: DatabaseSync +
// StatementSync (run/get/all/iterate). Values cross as JSON; BLOBs and BigInts
// are tagged ({t:'blob'|'bigint', v}) so binary data and >2^53 integers survive.

var hasNative = typeof __velox_sqlite_open === 'function';

// --- value tagging (mirror of src/sqlite.rs) -------------------------------

function encodeParam(v) {
  if (v === null || v === undefined) return null;
  var t = typeof v;
  if (t === 'number' || t === 'string') return v;
  if (t === 'boolean') return v ? 1 : 0;
  if (t === 'bigint') return { t: 'bigint', v: v.toString() };
  if (globalThis.Buffer && globalThis.Buffer.isBuffer(v)) {
    return { t: 'blob', v: v.toString('base64') };
  }
  if (v instanceof Uint8Array || (v && v.buffer instanceof ArrayBuffer && typeof v.byteLength === 'number')) {
    return { t: 'blob', v: globalThis.Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  }
  if (v instanceof ArrayBuffer) {
    return { t: 'blob', v: globalThis.Buffer.from(v).toString('base64') };
  }
  throw new TypeError('Unsupported SQLite parameter type: ' + t);
}

function decodeValue(v) {
  if (v !== null && typeof v === 'object' && typeof v.t === 'string') {
    if (v.t === 'blob') return globalThis.Buffer.from(v.v, 'base64');
    if (v.t === 'bigint') return BigInt(v.v);
  }
  return v;
}

// Normalize the variadic params of run/get/all/iterate into the JSON shape the
// native expects: a positional array, or a named object whose keys carry their
// sigil. Node accepts a single object of named params, otherwise positionals.
function buildParams(args, allowBareNamed) {
  if (args.length === 1 && args[0] !== null && typeof args[0] === 'object'
      && !globalThis.Buffer.isBuffer(args[0]) && !(args[0] instanceof Uint8Array)
      && !Array.isArray(args[0]) && !(args[0] instanceof ArrayBuffer)) {
    var named = {};
    var src = args[0];
    for (var k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      // Allow bare names (`id`) to bind `:id`/`@id`/`$id`; default to `:`.
      var key = /^[:@$]/.test(k) ? k : (allowBareNamed ? ':' + k : k);
      named[key] = encodeParam(src[k]);
    }
    return JSON.stringify(named);
  }
  var positional = [];
  for (var i = 0; i < args.length; i++) positional.push(encodeParam(args[i]));
  return JSON.stringify(positional);
}

function rowsToObjects(parsed) {
  var cols = parsed.columns;
  var out = [];
  for (var r = 0; r < parsed.rows.length; r++) {
    var row = parsed.rows[r];
    var obj = {};
    for (var c = 0; c < cols.length; c++) obj[cols[c]] = decodeValue(row[c]);
    out.push(obj);
  }
  return out;
}

// --- StatementSync ---------------------------------------------------------

function StatementSync(dbId, sql, db) {
  this._dbId = dbId;
  this._sql = sql;
  this._db = db;
  this._bigints = false;
  // Node allows bare named-parameter keys (`id` binds `:id`) by default.
  this._bareNamed = true;
  this.sourceSQL = sql;
}

StatementSync.prototype.run = function () {
  var params = buildParams(arguments, this._bareNamed);
  var res = JSON.parse(__velox_sqlite_run(this._dbId, this._sql, params));
  return { changes: res.changes, lastInsertRowid: decodeValue(res.lastInsertRowid) };
};

StatementSync.prototype.all = function () {
  var params = buildParams(arguments, this._bareNamed);
  var parsed = JSON.parse(__velox_sqlite_query(this._dbId, this._sql, params, this._bigints));
  return rowsToObjects(parsed);
};

StatementSync.prototype.get = function () {
  var params = buildParams(arguments, this._bareNamed);
  var parsed = JSON.parse(__velox_sqlite_query(this._dbId, this._sql, params, this._bigints));
  if (parsed.rows.length === 0) return undefined;
  return rowsToObjects({ columns: parsed.columns, rows: [parsed.rows[0]] })[0];
};

StatementSync.prototype.iterate = function () {
  var rows = this.all.apply(this, arguments);
  var i = 0;
  var it = {
    next: function () {
      return i < rows.length ? { value: rows[i++], done: false } : { value: undefined, done: true };
    },
    return: function () { i = rows.length; return { value: undefined, done: true }; },
  };
  it[Symbol.iterator] = function () { return this; };
  return it;
};

StatementSync.prototype.columns = function () {
  // Run with no rows to learn the column names without scanning data.
  var parsed = JSON.parse(__velox_sqlite_query(this._dbId, this._sql + ' LIMIT 0', '[]', false));
  return parsed.columns.map(function (name) {
    return { column: name, name: name, table: null, database: null, type: null };
  });
};

StatementSync.prototype.setReadBigInts = function (flag) { this._bigints = !!flag; return this; };
StatementSync.prototype.setAllowBareNamedParameters = function (flag) { this._bareNamed = !!flag; return this; };
StatementSync.prototype.setAllowUnknownNamedParameters = function () { return this; };

// --- DatabaseSync ----------------------------------------------------------

function DatabaseSync(path, options) {
  if (!hasNative) throw new Error('node:sqlite is not available in this build');
  this._path = path === undefined || path === null ? ':memory:' : String(path);
  this._id = null;
  this._open = false;
  options = options || {};
  // `open: false` defers opening until .open() is called.
  if (options.open !== false) this.open();
}

DatabaseSync.prototype.open = function () {
  if (this._open) throw new Error('database is already open');
  this._id = __velox_sqlite_open(this._path);
  this._open = true;
};

DatabaseSync.prototype.close = function () {
  if (!this._open) return;
  __velox_sqlite_close(this._id);
  this._open = false;
  this._id = null;
};

DatabaseSync.prototype.exec = function (sql) {
  if (!this._open) throw new Error('database is not open');
  __velox_sqlite_exec(this._id, String(sql));
};

DatabaseSync.prototype.prepare = function (sql) {
  if (!this._open) throw new Error('database is not open');
  return new StatementSync(this._id, String(sql), this);
};

DatabaseSync.prototype.location = function () {
  return this._path === ':memory:' ? null : this._path;
};

// Custom functions/aggregates aren't bridged yet; surface a clear error rather
// than silently no-op so callers know.
DatabaseSync.prototype.function = function () {
  throw new Error('DatabaseSync.function() is not supported in velox yet');
};
DatabaseSync.prototype.aggregate = function () {
  throw new Error('DatabaseSync.aggregate() is not supported in velox yet');
};

Object.defineProperty(DatabaseSync.prototype, 'isOpen', {
  get: function () { return this._open; },
  configurable: true,
});

DatabaseSync.prototype[Symbol.dispose] = function () { this.close(); };

var constants = {
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
};

module.exports = {
  DatabaseSync: DatabaseSync,
  StatementSync: StatementSync,
  constants: constants,
};
module.exports.default = module.exports;

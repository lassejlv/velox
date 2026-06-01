// velox-test — a small Vitest/Bun-style test framework. `velox test` discovers
// test files and runs them through a generated driver that calls `register()`
// (installing the globals `describe`/`it`/`test`/`expect`/hooks), requires each
// test file, then `run()` (executes the collected suite + reports). This is a
// CommonJS builtin body.

// --- collected suite tree ---------------------------------------------------

function makeSuite(name, parent) {
  return {
    name: name,
    parent: parent,
    children: [],          // nested suites
    tests: [],             // { name, fn, mode } mode: 'run'|'skip'|'todo'|'only'
    beforeAll: [], afterAll: [], beforeEach: [], afterEach: [],
    hasOnly: false,
  };
}

var rootSuite = makeSuite('', null);
var currentSuite = rootSuite;
var anyOnly = false;

function describe(name, fn) { return describeWith(name, fn, 'run'); }
function describeWith(name, fn, mode) {
  var suite = makeSuite(name, currentSuite);
  suite.mode = mode;
  if (mode === 'only') { anyOnly = true; suite.hasOnly = true; }
  currentSuite.children.push(suite);
  var prev = currentSuite;
  currentSuite = suite;
  try { fn && fn(); } finally { currentSuite = prev; }
  return suite;
}
describe.skip = function (name, fn) { return describeWith(name, fn, 'skip'); };
describe.only = function (name, fn) { return describeWith(name, fn, 'only'); };
describe.todo = function (name) { return describeWith(name, function () {}, 'todo'); };

function it(name, fn, timeout) { addTest(name, fn, 'run', timeout); }
function addTest(name, fn, mode, timeout) {
  if (mode === 'only') { anyOnly = true; currentSuite.hasOnly = true; }
  currentSuite.tests.push({ name: name, fn: fn, mode: fn ? mode : 'todo', timeout: timeout, suite: currentSuite });
}
it.skip = function (name, fn) { addTest(name, fn, 'skip'); };
it.only = function (name, fn, timeout) { addTest(name, fn, 'only', timeout); };
it.todo = function (name) { addTest(name, null, 'todo'); };
it.each = makeEach(it);
var test = it;

function makeEach(itFn) {
  return function (cases) {
    return function (name, fn, timeout) {
      cases.forEach(function (c, i) {
        var args = Array.isArray(c) ? c : [c];
        var label = name.replace(/%[sdifjoO#]/g, function () { return String(args.shift !== undefined ? args[0] : c); });
        itFn(formatEach(name, Array.isArray(c) ? c : [c], i), function () { return fn.apply(null, Array.isArray(c) ? c : [c]); }, timeout);
      });
    };
  };
}
function formatEach(name, args, i) {
  var k = 0;
  return name.replace(/%[sdifjoO#%]/g, function (m) {
    if (m === '%%') return '%';
    if (m === '%#') return String(i);
    return formatValue(args[k++]);
  });
}

function beforeAll(fn) { currentSuite.beforeAll.push(fn); }
function afterAll(fn) { currentSuite.afterAll.push(fn); }
function beforeEach(fn) { currentSuite.beforeEach.push(fn); }
function afterEach(fn) { currentSuite.afterEach.push(fn); }

// --- expect -----------------------------------------------------------------

function expect(received) { return new Expectation(received, false); }
expect.assertions = function () {}; // accepted, not enforced
expect.any = function (ctor) { return { __any: ctor }; };
expect.anything = function () { return { __anything: true }; };

function Expectation(received, isNot) {
  this.received = received;
  this.isNot = isNot;
}
Object.defineProperty(Expectation.prototype, 'not', {
  get: function () { return new Expectation(this.received, !this.isNot); },
});
// Async: await expect(promise).resolves.toBe(x) / .rejects.toThrow()
Object.defineProperty(Expectation.prototype, 'resolves', {
  get: function () {
    var self = this;
    return wrapAsync(Promise.resolve(self.received).then(function (v) {
      return new Expectation(v, self.isNot);
    }));
  },
});
Object.defineProperty(Expectation.prototype, 'rejects', {
  get: function () {
    var self = this;
    return wrapAsync(Promise.resolve(self.received).then(
      function () { throw new AssertionError('expected promise to reject, but it resolved'); },
      function (err) { return new Expectation(err, self.isNot); }
    ));
  },
});
// Return a proxy-ish object that forwards matcher calls onto the resolved Expectation.
function wrapAsync(promise) {
  var out = {};
  MATCHERS.forEach(function (name) {
    out[name] = function () {
      var args = arguments;
      return promise.then(function (exp) { return exp[name].apply(exp, args); });
    };
  });
  Object.defineProperty(out, 'not', { get: function () { return wrapAsync(promise.then(function (e) { return e.not; })); } });
  return out;
}

function AssertionError(message) { this.name = 'AssertionError'; this.message = message; this.stack = message; }
AssertionError.prototype = Object.create(Error.prototype);

function fail(self, message) {
  throw new AssertionError(message);
}
function assert(self, pass, message, negMessage) {
  var ok = self.isNot ? !pass : pass;
  if (!ok) throw new AssertionError(self.isNot ? (negMessage || message) : message);
}

var MATCHERS = [
  'toBe', 'toEqual', 'toStrictEqual', 'toBeTruthy', 'toBeFalsy', 'toBeNull',
  'toBeUndefined', 'toBeDefined', 'toBeNaN', 'toContain', 'toContainEqual',
  'toHaveLength', 'toHaveProperty', 'toBeGreaterThan', 'toBeGreaterThanOrEqual',
  'toBeLessThan', 'toBeLessThanOrEqual', 'toBeCloseTo', 'toMatch', 'toMatchObject',
  'toThrow', 'toThrowError', 'toBeInstanceOf', 'toHaveBeenCalled',
  'toHaveBeenCalledTimes', 'toHaveBeenCalledWith', 'toHaveBeenLastCalledWith',
  'toHaveBeenNthCalledWith', 'toHaveReturned', 'toHaveReturnedWith',
  'toMatchInlineSnapshot',
];

Expectation.prototype.toBe = function (expected) {
  assert(this, Object.is(this.received, expected),
    'expected ' + formatValue(this.received) + ' to be ' + formatValue(expected),
    'expected ' + formatValue(this.received) + ' not to be ' + formatValue(expected));
};
Expectation.prototype.toEqual = function (expected) {
  assert(this, deepEqual(this.received, expected, false),
    'expected ' + formatValue(this.received) + ' to equal ' + formatValue(expected),
    'expected values not to be equal');
};
Expectation.prototype.toStrictEqual = function (expected) {
  assert(this, deepEqual(this.received, expected, true),
    'expected ' + formatValue(this.received) + ' to strictly equal ' + formatValue(expected),
    'expected values not to strictly equal');
};
Expectation.prototype.toBeTruthy = function () { assert(this, !!this.received, 'expected ' + formatValue(this.received) + ' to be truthy', 'expected value to be falsy'); };
Expectation.prototype.toBeFalsy = function () { assert(this, !this.received, 'expected ' + formatValue(this.received) + ' to be falsy', 'expected value to be truthy'); };
Expectation.prototype.toBeNull = function () { assert(this, this.received === null, 'expected ' + formatValue(this.received) + ' to be null', 'expected value not to be null'); };
Expectation.prototype.toBeUndefined = function () { assert(this, this.received === undefined, 'expected ' + formatValue(this.received) + ' to be undefined', 'expected value not to be undefined'); };
Expectation.prototype.toBeDefined = function () { assert(this, this.received !== undefined, 'expected value to be defined', 'expected value to be undefined'); };
Expectation.prototype.toBeNaN = function () { assert(this, typeof this.received === 'number' && isNaN(this.received), 'expected ' + formatValue(this.received) + ' to be NaN', 'expected value not to be NaN'); };
Expectation.prototype.toContain = function (item) {
  var r = this.received; var pass = false;
  if (typeof r === 'string') pass = r.indexOf(item) !== -1;
  else if (r && typeof r.indexOf === 'function') pass = r.indexOf(item) !== -1;
  else if (r && typeof r.has === 'function') pass = r.has(item);
  assert(this, pass, 'expected ' + formatValue(r) + ' to contain ' + formatValue(item), 'expected ' + formatValue(r) + ' not to contain ' + formatValue(item));
};
Expectation.prototype.toContainEqual = function (item) {
  var r = this.received; var pass = false;
  if (r && r.length != null) for (var i = 0; i < r.length; i++) if (deepEqual(r[i], item, false)) { pass = true; break; }
  assert(this, pass, 'expected collection to contain an element equal to ' + formatValue(item), 'expected collection not to contain ' + formatValue(item));
};
Expectation.prototype.toHaveLength = function (n) { assert(this, this.received && this.received.length === n, 'expected length ' + (this.received && this.received.length) + ' to be ' + n, 'expected length not to be ' + n); };
Expectation.prototype.toHaveProperty = function (path, value) {
  var keys = Array.isArray(path) ? path : String(path).split('.');
  var cur = this.received, found = true;
  for (var i = 0; i < keys.length; i++) { if (cur == null || !(keys[i] in Object(cur))) { found = false; break; } cur = cur[keys[i]]; }
  var pass = found && (arguments.length < 2 || deepEqual(cur, value, false));
  assert(this, pass, 'expected object to have property ' + formatValue(path) + (arguments.length >= 2 ? ' = ' + formatValue(value) : ''), 'expected object not to have property ' + formatValue(path));
};
Expectation.prototype.toBeGreaterThan = function (n) { assert(this, this.received > n, 'expected ' + formatValue(this.received) + ' to be > ' + n, 'expected not > ' + n); };
Expectation.prototype.toBeGreaterThanOrEqual = function (n) { assert(this, this.received >= n, 'expected ' + formatValue(this.received) + ' to be >= ' + n, 'expected not >= ' + n); };
Expectation.prototype.toBeLessThan = function (n) { assert(this, this.received < n, 'expected ' + formatValue(this.received) + ' to be < ' + n, 'expected not < ' + n); };
Expectation.prototype.toBeLessThanOrEqual = function (n) { assert(this, this.received <= n, 'expected ' + formatValue(this.received) + ' to be <= ' + n, 'expected not <= ' + n); };
Expectation.prototype.toBeCloseTo = function (n, digits) {
  if (digits === undefined) digits = 2;
  var pass = Math.abs(this.received - n) < Math.pow(10, -digits) / 2;
  assert(this, pass, 'expected ' + formatValue(this.received) + ' to be close to ' + n, 'expected not close to ' + n);
};
Expectation.prototype.toMatch = function (pattern) {
  var pass = typeof pattern === 'string' ? this.received.indexOf(pattern) !== -1 : pattern.test(this.received);
  assert(this, pass, 'expected ' + formatValue(this.received) + ' to match ' + formatValue(pattern), 'expected not to match ' + formatValue(pattern));
};
Expectation.prototype.toMatchObject = function (obj) {
  assert(this, matchObject(this.received, obj), 'expected object to match ' + formatValue(obj), 'expected object not to match ' + formatValue(obj));
};
Expectation.prototype.toBeInstanceOf = function (ctor) { assert(this, this.received instanceof ctor, 'expected value to be an instance of ' + (ctor && ctor.name), 'expected not an instance of ' + (ctor && ctor.name)); };
Expectation.prototype.toThrow = function (expected) {
  var threw = false, error = null;
  if (typeof this.received === 'function') {
    try { this.received(); } catch (e) { threw = true; error = e; }
  } else {
    // `received` is already a thrown value (e.g. via `.rejects.toThrow(...)`).
    threw = true; error = this.received;
  }
  var pass = threw;
  if (threw && expected !== undefined) {
    var msg = error && error.message != null ? String(error.message) : String(error);
    if (typeof expected === 'string') pass = msg.indexOf(expected) !== -1;
    else if (expected instanceof RegExp) pass = expected.test(msg);
    else if (typeof expected === 'function') pass = error instanceof expected;
  }
  assert(this, pass, threw ? ('expected error to match ' + formatValue(expected)) : 'expected function to throw', 'expected function not to throw');
};
Expectation.prototype.toThrowError = Expectation.prototype.toThrow;

// --- spies / mocks (Vitest-style `vi`) --------------------------------------

var __mocks = [];

function mockFn(impl) {
  var f = function () {
    var args = Array.prototype.slice.call(arguments);
    f.mock.calls.push(args);
    f.mock.lastCall = args;
    var use = f._once.length ? f._once.shift() : (f._impl || impl);
    try {
      var ret = use ? use.apply(this, args) : undefined;
      f.mock.results.push({ type: 'return', value: ret });
      return ret;
    } catch (e) {
      f.mock.results.push({ type: 'throw', value: e });
      throw e;
    }
  };
  f._isMockFunction = true;
  f._impl = impl;
  f._once = [];
  f.mock = { calls: [], results: [], lastCall: undefined };
  f.mockImplementation = function (g) { f._impl = g; return f; };
  f.mockImplementationOnce = function (g) { f._once.push(g); return f; };
  f.mockReturnValue = function (v) { f._impl = function () { return v; }; return f; };
  f.mockReturnValueOnce = function (v) { f._once.push(function () { return v; }); return f; };
  f.mockResolvedValue = function (v) { f._impl = function () { return Promise.resolve(v); }; return f; };
  f.mockResolvedValueOnce = function (v) { f._once.push(function () { return Promise.resolve(v); }); return f; };
  f.mockRejectedValue = function (v) { f._impl = function () { return Promise.reject(v); }; return f; };
  f.mockReturnThis = function () { f._impl = function () { return this; }; return f; };
  f.mockName = function () { return f; };
  f.getMockName = function () { return 'vi.fn()'; };
  f.mockClear = function () { f.mock.calls = []; f.mock.results = []; f.mock.lastCall = undefined; return f; };
  f.mockReset = function () { f.mockClear(); f._impl = undefined; f._once = []; return f; };
  __mocks.push(f);
  return f;
}

function spyOn(obj, method) {
  var original = obj[method];
  var spy = mockFn(typeof original === 'function' ? original : undefined);
  spy.mockRestore = function () { obj[method] = original; };
  obj[method] = spy;
  return spy;
}

var vi = {
  fn: mockFn,
  spyOn: spyOn,
  isMockFunction: function (v) { return !!(v && v._isMockFunction); },
  clearAllMocks: function () { __mocks.forEach(function (m) { m.mockClear(); }); return vi; },
  resetAllMocks: function () { __mocks.forEach(function (m) { m.mockReset(); }); return vi; },
  restoreAllMocks: function () { __mocks.forEach(function (m) { if (m.mockRestore) m.mockRestore(); }); return vi; },
};

// Spy/mock matchers.
function callsOf(self) {
  if (!self.received || !self.received.mock) throw new AssertionError('received value is not a mock function');
  return self.received.mock;
}
Expectation.prototype.toHaveBeenCalled = function () {
  var m = callsOf(this);
  assert(this, m.calls.length > 0, 'expected mock to have been called', 'expected mock not to have been called');
};
Expectation.prototype.toHaveBeenCalledTimes = function (n) {
  var m = callsOf(this);
  assert(this, m.calls.length === n, 'expected mock to have been called ' + n + ' time(s), but was called ' + m.calls.length, 'expected mock not to have been called ' + n + ' time(s)');
};
Expectation.prototype.toHaveBeenCalledWith = function () {
  var want = Array.prototype.slice.call(arguments);
  var m = callsOf(this);
  var pass = m.calls.some(function (c) { return deepEqual(c, want, false); });
  assert(this, pass, 'expected mock to have been called with ' + formatValue(want), 'expected mock not to have been called with ' + formatValue(want));
};
Expectation.prototype.toHaveBeenLastCalledWith = function () {
  var want = Array.prototype.slice.call(arguments);
  var m = callsOf(this);
  assert(this, deepEqual(m.lastCall, want, false), 'expected last call with ' + formatValue(want) + ', got ' + formatValue(m.lastCall), 'expected last call not to be ' + formatValue(want));
};
Expectation.prototype.toHaveBeenNthCalledWith = function (nth) {
  var want = Array.prototype.slice.call(arguments, 1);
  var m = callsOf(this);
  assert(this, deepEqual(m.calls[nth - 1], want, false), 'expected call #' + nth + ' with ' + formatValue(want), 'expected call #' + nth + ' not to be ' + formatValue(want));
};
Expectation.prototype.toHaveReturned = function () {
  var m = callsOf(this);
  assert(this, m.results.some(function (r) { return r.type === 'return'; }), 'expected mock to have returned', 'expected mock not to have returned');
};
Expectation.prototype.toHaveReturnedWith = function (value) {
  var m = callsOf(this);
  assert(this, m.results.some(function (r) { return r.type === 'return' && deepEqual(r.value, value, false); }), 'expected mock to have returned ' + formatValue(value), 'expected mock not to have returned ' + formatValue(value));
};

// --- inline snapshots -------------------------------------------------------

Expectation.prototype.toMatchInlineSnapshot = function (expected) {
  var actual = serializeSnapshot(this.received, '');
  if (expected === undefined) {
    throw new AssertionError(
      'inline snapshot not provided — received:\n' + actual +
      '\n(paste it into toMatchInlineSnapshot(`...`))'
    );
  }
  assert(
    this,
    normalizeSnap(actual) === normalizeSnap(String(expected)),
    'inline snapshot mismatch\n--- expected\n' + String(expected).trim() + '\n--- received\n' + actual,
    'expected not to match the inline snapshot'
  );
};
Expectation.prototype.toMatchObject = Expectation.prototype.toMatchObject; // keep

function normalizeSnap(s) {
  return s.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length; }).join('\n');
}
function serializeSnapshot(v, indent) {
  var ni = indent + '  ';
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  var t = typeof v;
  if (t === 'string') return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  if (t === 'number' || t === 'boolean') return String(v);
  if (t === 'bigint') return String(v) + 'n';
  if (t === 'function') return '[Function ' + (v.name || 'anonymous') + ']';
  if (v instanceof Date) return 'Date(' + v.toISOString() + ')';
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '[\n' + v.map(function (x) { return ni + serializeSnapshot(x, ni); }).join(',\n') + '\n' + indent + ']';
  }
  if (t === 'object') {
    var keys = Object.keys(v).sort();
    if (keys.length === 0) return '{}';
    return '{\n' + keys.map(function (k) {
      var key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : '"' + k + '"';
      return ni + key + ': ' + serializeSnapshot(v[k], ni);
    }).join(',\n') + '\n' + indent + '}';
  }
  return String(v);
}

// --- equality + matching helpers --------------------------------------------

function deepEqual(a, b, strict) {
  if (Object.is(a, b)) return true;
  if (a && b && a.__any) return b instanceof a.__any || typeof b === typeName(a.__any);
  if (b && b.__any) return a instanceof b.__any || typeof a === typeName(b.__any);
  if (typeof a !== 'object' || typeof b !== 'object' || a == null || b == null) return false;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i], strict)) return false;
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    var ok = true; a.forEach(function (v, k) { if (!b.has(k) || !deepEqual(v, b.get(k), strict)) ok = false; }); return ok;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    var ok2 = true; a.forEach(function (v) { if (!b.has(v)) ok2 = false; }); return ok2;
  }
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  var ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (var j = 0; j < ka.length; j++) { if (!Object.prototype.hasOwnProperty.call(b, ka[j])) return false; if (!deepEqual(a[ka[j]], b[ka[j]], strict)) return false; }
  return true;
}
function typeName(ctor) { return ctor === String ? 'string' : ctor === Number ? 'number' : ctor === Boolean ? 'boolean' : ctor === Object ? 'object' : '__none'; }
function matchObject(received, expected) {
  if (received == null || typeof received !== 'object') return false;
  for (var k in expected) {
    if (!Object.prototype.hasOwnProperty.call(expected, k)) continue;
    var ev = expected[k], rv = received[k];
    if (ev && typeof ev === 'object' && !Array.isArray(ev) && !(ev instanceof RegExp) && !(ev instanceof Date)) {
      if (!matchObject(rv, ev)) return false;
    } else if (!deepEqual(rv, ev, false)) return false;
  }
  return true;
}

function formatValue(v) {
  try {
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'function') return v.name ? '[Function ' + v.name + ']' : '[Function]';
    if (typeof v === 'bigint') return String(v) + 'n';
    if (v instanceof RegExp) return String(v);
    if (typeof globalThis.__velox_inspect === 'function' && v && typeof v === 'object') return globalThis.__velox_inspect(v);
    return String(v);
  } catch (e) { return String(v); }
}

// --- runner -----------------------------------------------------------------

var C = (function () {
  var on = globalThis.process && globalThis.process.stdout && globalThis.process.stdout.isTTY !== false;
  function w(code) { return function (s) { return on ? '[' + code + 'm' + s + '[0m' : s; }; }
  return { green: w(32), red: w(31), yellow: w(33), dim: w(2), bold: w(1), cyan: w(36) };
})();

var stats = { pass: 0, fail: 0, skip: 0, todo: 0, files: 0, failures: [] };

async function runFn(fn, timeout) {
  if (!fn) return;
  var p = fn.length >= 1
    ? new Promise(function (res, rej) { var d = function (e) { e ? rej(e) : res(); }; var r = fn(d); if (r && typeof r.then === 'function') r.then(function () { res(); }, rej); })
    : Promise.resolve().then(fn);
  if (timeout && timeout > 0) {
    var to;
    var timer = new Promise(function (_res, rej) { to = setTimeout(function () { rej(new Error('test timed out after ' + timeout + 'ms')); }, timeout); });
    try { await Promise.race([p, timer]); } finally { clearTimeout(to); }
  } else {
    await p;
  }
}

function ancestry(suite) { var out = []; for (var s = suite; s && s !== rootSuite; s = s.parent) out.unshift(s); return out; }

async function runSuite(suite, depth) {
  var indent = '  '.repeat(depth);
  if (suite !== rootSuite && suite.name) console.log(indent + C.bold(suite.name));

  var bodyIndent = suite === rootSuite ? '' : indent + '  ';
  for (var bi = 0; bi < suite.beforeAll.length; bi++) await runFn(suite.beforeAll[bi]);

  for (var t = 0; t < suite.tests.length; t++) {
    var test = suite.tests[t];
    if (test.mode === 'todo') { stats.todo++; console.log(bodyIndent + C.cyan('○') + ' ' + test.name + C.dim(' [todo]')); continue; }
    if (test.mode === 'skip' || (anyOnly && !isOnlyPath(test))) { stats.skip++; console.log(bodyIndent + C.yellow('○') + ' ' + C.dim(test.name)); continue; }
    var start = Date.now();
    try {
      for (var be = 0; be < suite.beforeEach.length; be++) await runFn(suite.beforeEach[be]);
      await runFn(test.fn, test.timeout);
      for (var ae = 0; ae < suite.afterEach.length; ae++) await runFn(suite.afterEach[ae]);
      stats.pass++;
      var ms = Date.now() - start;
      console.log(bodyIndent + C.green('✓') + ' ' + test.name + (ms > 5 ? C.dim(' (' + ms + 'ms)') : ''));
    } catch (err) {
      stats.fail++;
      console.log(bodyIndent + C.red('✗') + ' ' + C.red(test.name));
      var path = ancestry(suite).map(function (s) { return s.name; }).concat(test.name).join(' › ');
      stats.failures.push({ path: path, err: err });
    }
  }

  for (var c = 0; c < suite.children.length; c++) {
    if (suite.children[c].mode !== 'skip') await runSuite(suite.children[c], depth + 1);
    else { skipCount(suite.children[c]); console.log('  '.repeat(depth + 1) + C.yellow('○') + ' ' + C.dim(suite.children[c].name)); }
  }

  for (var aa = 0; aa < suite.afterAll.length; aa++) await runFn(suite.afterAll[aa]);
}
function skipCount(suite) { stats.skip += suite.tests.length; suite.children.forEach(skipCount); }
function isOnlyPath(test) {
  if (test.mode === 'only') return true;
  for (var s = test.suite; s; s = s.parent) if (s.mode === 'only' || s.hasOnly) return true;
  return false;
}

// register(): install the globals so test files can use them bare.
function register() {
  var g = globalThis;
  g.describe = describe; g.it = it; g.test = test; g.expect = expect;
  g.beforeAll = beforeAll; g.afterAll = afterAll; g.beforeEach = beforeEach; g.afterEach = afterEach;
  g.vi = vi; g.jest = vi; // jest alias for compatibility
}

// run(): execute the collected suite and report; sets process.exitCode.
async function run() {
  var start = Date.now();
  try {
    await runSuite(rootSuite, 0);
  } catch (e) {
    console.log(C.red('fatal error while running tests: ' + (e && e.stack || e)));
    stats.fail++;
  }
  var ms = Date.now() - start;

  if (stats.failures.length) {
    console.log('\n' + C.bold(C.red('Failures:')));
    stats.failures.forEach(function (f, i) {
      console.log('\n  ' + C.red((i + 1) + ') ' + f.path));
      var msg = f.err && f.err.message != null ? f.err.message : String(f.err);
      console.log('     ' + C.red(msg));
      if (f.err && f.err.stack && f.err.name !== 'AssertionError') {
        var lines = String(f.err.stack).split('\n').slice(1, 4);
        lines.forEach(function (l) { console.log(C.dim('     ' + l.trim())); });
      }
    });
  }

  var parts = [];
  if (stats.pass) parts.push(C.green(stats.pass + ' passed'));
  if (stats.fail) parts.push(C.red(stats.fail + ' failed'));
  if (stats.skip) parts.push(C.yellow(stats.skip + ' skipped'));
  if (stats.todo) parts.push(C.cyan(stats.todo + ' todo'));
  var total = stats.pass + stats.fail + stats.skip + stats.todo;
  console.log('\n' + C.bold('Tests:') + ' ' + (parts.join(C.dim(', ')) || '0') + C.dim(' (' + total + ' total)'));
  console.log(C.bold('Time: ') + ' ' + ms + 'ms');

  if (globalThis.process) globalThis.process.exitCode = stats.fail > 0 ? 1 : 0;
  return stats.fail === 0;
}

module.exports = { register: register, run: run, describe: describe, it: it, test: test, expect: expect, vi: vi, beforeAll: beforeAll, afterAll: afterAll, beforeEach: beforeEach, afterEach: afterEach };
module.exports.default = module.exports;

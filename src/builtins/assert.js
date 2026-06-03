// node:assert — a self-contained reimplementation of Node's assertion API.
//
// The module IS a callable function (`assert(value, message)`) with all the
// assertion helpers attached as properties. A `strict` variant is exposed where
// the loose `equal`/`notEqual`/`deepEqual` helpers alias their strict siblings.

// ---------------------------------------------------------------------------
// AssertionError
// ---------------------------------------------------------------------------

class AssertionError extends Error {
  constructor(options) {
    options = options || {};
    const message =
      options.message != null
        ? String(options.message)
        : buildDefaultMessage(options);
    super(message);
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator;
    this.generatedMessage = options.message == null;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, options.stackStartFn || AssertionError);
    }
  }
}

// Compact string preview of a value for default error messages.
function inspect(value) {
  try {
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'bigint') return value.toString() + 'n';
    if (typeof value === 'function')
      return '[Function' + (value.name ? ': ' + value.name : '') + ']';
    if (value instanceof RegExp) return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (value === undefined) return 'undefined';
    if (typeof value === 'object' && value !== null) {
      const s = JSON.stringify(value);
      if (s !== undefined) return s;
      return Object.prototype.toString.call(value);
    }
    return String(value);
  } catch (e) {
    return String(value);
  }
}

function buildDefaultMessage(options) {
  const op = options.operator;
  if (op === 'fail') return 'Failed';
  return inspect(options.actual) + ' ' + op + ' ' + inspect(options.expected);
}

function fail(actual, expected, message, operator, stackStartFn) {
  // Node signature variants: fail(message) / fail(actual, expected, msg, op).
  const argsLen = arguments.length;
  if (argsLen === 0) {
    message = 'Failed';
  } else if (argsLen === 1) {
    message = actual;
    actual = undefined;
  } else if (argsLen === 2) {
    operator = '!=';
  }

  if (message instanceof Error) throw message;

  throw new AssertionError({
    message: message,
    actual: actual,
    expected: expected,
    operator: operator == null ? 'fail' : operator,
    stackStartFn: stackStartFn || fail,
  });
}

// ---------------------------------------------------------------------------
// The callable assert() and ok()
// ---------------------------------------------------------------------------

function ok(value, message) {
  if (!value) {
    innerFail({
      actual: value,
      expected: true,
      message: message,
      operator: '==',
      stackStartFn: ok,
    });
  }
}

function innerFail(obj) {
  if (obj.message instanceof Error) throw obj.message;
  throw new AssertionError(obj);
}

// The exported module: callable, delegates to ok().
function assert(value, message) {
  ok(value, message);
}

// ---------------------------------------------------------------------------
// Loose / strict equality
// ---------------------------------------------------------------------------

function equal(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual != expected) {
    innerFail({
      actual,
      expected,
      message,
      operator: '==',
      stackStartFn: equal,
    });
  }
}

function notEqual(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual == expected) {
    innerFail({
      actual,
      expected,
      message,
      operator: '!=',
      stackStartFn: notEqual,
    });
  }
}

function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'strictEqual',
      stackStartFn: strictEqual,
    });
  }
}

function notStrictEqual(actual, expected, message) {
  if (Object.is(actual, expected)) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notStrictEqual',
      stackStartFn: notStrictEqual,
    });
  }
}

// ---------------------------------------------------------------------------
// Deep equality (structural compare)
// ---------------------------------------------------------------------------

function isPrimitiveEqual(a, b, strict) {
  if (strict) {
    // Object.is handles NaN and -0 distinction.
    return Object.is(a, b);
  }
  // Loose: NaN still equals NaN for deepEqual, otherwise ==.
  if (typeof a === 'number' && typeof b === 'number') {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
  }
  // eslint-disable-next-line eqeqeq
  return a == b;
}

function getTag(v) {
  return Object.prototype.toString.call(v);
}

function isTypedArray(v) {
  return ArrayBuffer.isView(v) && !(v instanceof DataView);
}

function deepEqualInternal(a, b, strict, seen) {
  // Fast path for identical references / primitives.
  if (Object.is(a, b)) return true;

  const ta = typeof a;
  const tb = typeof b;

  // If either is not an object, fall back to primitive comparison.
  if (a === null || b === null || ta !== 'object' || tb !== 'object') {
    return isPrimitiveEqual(a, b, strict);
  }

  // In strict mode, prototypes/tags must match.
  if (strict) {
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  }

  // Cycle guard.
  if (seen.has(a)) return seen.get(a) === b;
  seen.set(a, b);

  const tagA = getTag(a);
  const tagB = getTag(b);
  if (tagA !== tagB) return false;

  // Date
  if (a instanceof Date) {
    return a.getTime() === b.getTime();
  }

  // RegExp
  if (a instanceof RegExp) {
    return a.source === b.source && a.flags === b.flags;
  }

  // Map
  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, valA] of a) {
      if (!b.has(key)) {
        // Key may itself be a non-primitive needing deep match.
        if (!mapHasDeepKey(b, key, valA, strict, seen)) return false;
      } else if (!deepEqualInternal(valA, b.get(key), strict, seen)) {
        return false;
      }
    }
    return true;
  }

  // Set
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    for (const valA of a) {
      if (!b.has(valA) && !setHasDeep(b, valA, strict, seen)) return false;
    }
    return true;
  }

  // Typed arrays / Buffer
  if (isTypedArray(a) || isTypedArray(b)) {
    if (!isTypedArray(a) || !isTypedArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // ArrayBuffer
  if (a instanceof ArrayBuffer) {
    if (a.byteLength !== b.byteLength) return false;
    const va = new Uint8Array(a);
    const vb = new Uint8Array(b);
    for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
    return true;
  }

  // Arrays
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr || bIsArr) {
    if (aIsArr !== bIsArr) return false;
    if (a.length !== b.length) return false;
  }

  // Generic objects: compare own enumerable keys (including symbols).
  const keysA = ownKeys(a);
  const keysB = ownKeys(b);
  if (keysA.length !== keysB.length) return false;

  const setB = new Set(keysB);
  for (const key of keysA) {
    if (!setB.has(key)) return false;
    if (!deepEqualInternal(a[key], b[key], strict, seen)) return false;
  }
  return true;
}

function ownKeys(obj) {
  const keys = Object.keys(obj);
  const syms = Object.getOwnPropertySymbols(obj).filter((s) =>
    Object.prototype.propertyIsEnumerable.call(obj, s)
  );
  return keys.concat(syms);
}

// Map key lookup where the key is a non-primitive needing deep comparison.
function mapHasDeepKey(map, key, valA, strict, seen) {
  for (const [k, v] of map) {
    if (deepEqualInternal(k, key, strict, seen) &&
        deepEqualInternal(v, valA, strict, seen)) {
      return true;
    }
  }
  return false;
}

function setHasDeep(set, valA, strict, seen) {
  for (const v of set) {
    if (deepEqualInternal(v, valA, strict, seen)) return true;
  }
  return false;
}

function deepEqual(actual, expected, message) {
  if (!deepEqualInternal(actual, expected, false, new Map())) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'deepEqual',
      stackStartFn: deepEqual,
    });
  }
}

function notDeepEqual(actual, expected, message) {
  if (deepEqualInternal(actual, expected, false, new Map())) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notDeepEqual',
      stackStartFn: notDeepEqual,
    });
  }
}

function deepStrictEqual(actual, expected, message) {
  if (!deepEqualInternal(actual, expected, true, new Map())) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'deepStrictEqual',
      stackStartFn: deepStrictEqual,
    });
  }
}

function notDeepStrictEqual(actual, expected, message) {
  if (deepEqualInternal(actual, expected, true, new Map())) {
    innerFail({
      actual,
      expected,
      message,
      operator: 'notDeepStrictEqual',
      stackStartFn: notDeepStrictEqual,
    });
  }
}

// ---------------------------------------------------------------------------
// throws / doesNotThrow / rejects / doesNotReject
// ---------------------------------------------------------------------------

// Does `error` satisfy the `expected` matcher?
function expectedMatches(error, expected) {
  if (expected == null) return true;

  // RegExp matches the stringified error.
  if (expected instanceof RegExp) {
    return expected.test(String(error && error.message != null ? error.message : error));
  }

  // A constructor (class/function): instanceof check.
  if (typeof expected === 'function') {
    // Could be a subclass of Error, or any constructor.
    if (error instanceof expected) return true;
    // Predicate function fallback: call it, truthy = pass.
    if (!(expected.prototype instanceof Error) && expected !== Error) {
      try {
        return expected(error) === true;
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  // A validation object: each property must match the error's. A RegExp value
  // is tested against the error's (stringified) property; otherwise deep-equal.
  if (typeof expected === 'object') {
    for (const key of Object.keys(expected)) {
      if (!(key in Object(error))) return false;
      const ev = expected[key], av = error[key];
      if (ev instanceof RegExp) {
        if (!ev.test(String(av))) return false;
      } else if (!deepEqualInternal(av, ev, false, new Map())) {
        if (av !== ev) return false; // loose match for primitives
      }
    }
    return true;
  }

  return false;
}

// Normalises the (expected, message) argument pair, which may be swapped.
function parseThrowsArgs(expected, message) {
  if (
    typeof expected === 'string' &&
    message === undefined
  ) {
    return { expected: undefined, message: expected };
  }
  return { expected, message };
}

function throws(fn, expected, message) {
  const parsed = parseThrowsArgs(expected, message);
  expected = parsed.expected;
  message = parsed.message;

  let threw = false;
  let caught;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }

  if (!threw) {
    innerFail({
      actual: undefined,
      expected,
      message:
        (message ? message + ': ' : '') +
        'Missing expected exception' +
        (expected && expected.name ? ' (' + expected.name + ')' : '') + '.',
      operator: 'throws',
      stackStartFn: throws,
    });
  }

  if (!expectedMatches(caught, expected)) {
    // The thrown error didn't match the matcher; surface it.
    if (expected instanceof RegExp || typeof expected === 'function' ||
        (expected && typeof expected === 'object')) {
      throw new AssertionError({
        message:
          (message ? message + ': ' : '') +
          'The error did not match the expected value.',
        actual: caught,
        expected,
        operator: 'throws',
        stackStartFn: throws,
      });
    }
  }
}

function doesNotThrow(fn, expected, message) {
  const parsed = parseThrowsArgs(expected, message);
  expected = parsed.expected;
  message = parsed.message;

  let caught;
  let threw = false;
  try {
    fn();
  } catch (e) {
    threw = true;
    caught = e;
  }

  if (threw) {
    // If a matcher was given and it doesn't match, rethrow the original.
    if (expected != null && !expectedMatches(caught, expected)) {
      throw caught;
    }
    innerFail({
      actual: caught,
      expected,
      message:
        (message ? message + ': ' : '') +
        'Got unwanted exception.',
      operator: 'doesNotThrow',
      stackStartFn: doesNotThrow,
    });
  }
}

// Resolve a thenable or invoke a function that returns one.
function asPromise(fnOrPromise) {
  if (typeof fnOrPromise === 'function') {
    return Promise.resolve().then(() => fnOrPromise());
  }
  return Promise.resolve(fnOrPromise);
}

async function rejects(promiseOrFn, expected, message) {
  const parsed = parseThrowsArgs(expected, message);
  expected = parsed.expected;
  message = parsed.message;

  let caught;
  let rejected = false;
  try {
    await asPromise(promiseOrFn);
  } catch (e) {
    rejected = true;
    caught = e;
  }

  if (!rejected) {
    throw new AssertionError({
      message:
        (message ? message + ': ' : '') +
        'Missing expected rejection' +
        (expected && expected.name ? ' (' + expected.name + ')' : '') + '.',
      operator: 'rejects',
      stackStartFn: rejects,
    });
  }

  if (!expectedMatches(caught, expected)) {
    throw new AssertionError({
      message:
        (message ? message + ': ' : '') +
        'The rejection did not match the expected value.',
      actual: caught,
      expected,
      operator: 'rejects',
      stackStartFn: rejects,
    });
  }
}

async function doesNotReject(promiseOrFn, expected, message) {
  const parsed = parseThrowsArgs(expected, message);
  expected = parsed.expected;
  message = parsed.message;

  let caught;
  let rejected = false;
  try {
    await asPromise(promiseOrFn);
  } catch (e) {
    rejected = true;
    caught = e;
  }

  if (rejected) {
    if (expected != null && !expectedMatches(caught, expected)) {
      throw caught;
    }
    throw new AssertionError({
      message:
        (message ? message + ': ' : '') +
        'Got unwanted rejection.',
      actual: caught,
      operator: 'doesNotReject',
      stackStartFn: doesNotReject,
    });
  }
}

// ---------------------------------------------------------------------------
// match / doesNotMatch
// ---------------------------------------------------------------------------

function match(string, regexp, message) {
  if (!(regexp instanceof RegExp)) {
    throw new TypeError('The "regexp" argument must be a RegExp.');
  }
  if (typeof string !== 'string') {
    innerFail({
      actual: string,
      expected: regexp,
      message:
        (message ? message + ': ' : '') +
        'The "string" argument must be of type string.',
      operator: 'match',
      stackStartFn: match,
    });
  }
  if (!regexp.test(string)) {
    innerFail({
      actual: string,
      expected: regexp,
      message,
      operator: 'match',
      stackStartFn: match,
    });
  }
}

function doesNotMatch(string, regexp, message) {
  if (!(regexp instanceof RegExp)) {
    throw new TypeError('The "regexp" argument must be a RegExp.');
  }
  if (typeof string === 'string' && regexp.test(string)) {
    innerFail({
      actual: string,
      expected: regexp,
      message,
      operator: 'doesNotMatch',
      stackStartFn: doesNotMatch,
    });
  }
}

// ---------------------------------------------------------------------------
// ifError
// ---------------------------------------------------------------------------

function ifError(err) {
  if (err !== null && err !== undefined) {
    let message = 'ifError got unwanted exception: ';
    if (typeof err === 'object' && typeof err.message === 'string') {
      message += err.message === '' ? inspect(err) : err.message;
    } else {
      message += inspect(err);
    }
    const e = new AssertionError({
      actual: err,
      expected: null,
      operator: 'ifError',
      message,
      stackStartFn: ifError,
    });
    e.generatedMessage = false;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// CallTracker (experimental call-tracking helper)
// ---------------------------------------------------------------------------

class CallTracker {
  constructor() {
    // Each entry: { name, expected, calls: [{ thisArg, arguments }] }.
    this._tracked = new Map();
  }

  calls(fn, exact) {
    // calls(exact) — fn omitted, wraps a no-op.
    if (typeof fn === 'number') {
      exact = fn;
      fn = () => {};
    }
    if (fn === undefined) fn = () => {};
    if (exact === undefined) exact = 1;
    if (typeof fn !== 'function') {
      throw new TypeError('The "fn" argument must be of type function.');
    }
    if (typeof exact !== 'number') {
      throw new TypeError('The "exact" argument must be of type number.');
    }

    const tracked = this._tracked;
    const wrapper = function (...args) {
      const record = tracked.get(wrapper);
      if (record) {
        record.calls.push({ thisArg: this, arguments: args });
      }
      return fn.apply(this, args);
    };

    tracked.set(wrapper, {
      name: fn.name || 'calls',
      expected: exact,
      calls: [],
    });
    return wrapper;
  }

  getCalls(fn) {
    const record = this._tracked.get(fn);
    if (!record) {
      throw new Error('The provided function is not a tracked function.');
    }
    return record.calls.slice();
  }

  report() {
    const out = [];
    for (const record of this._tracked.values()) {
      const actual = record.calls.length;
      if (actual !== record.expected) {
        out.push({
          message:
            'Expected the ' + record.name + ' function to be executed ' +
            record.expected + ' time(s) but was executed ' + actual +
            ' time(s).',
          actual,
          expected: record.expected,
          operator: record.name,
          stack: new Error().stack,
        });
      }
    }
    return out;
  }

  verify() {
    const report = this.report();
    if (report.length > 0) {
      const message = report.map((r) => r.message).join('\n\n');
      throw new AssertionError({
        message,
        operator: 'CallTracker.verify',
        stackStartFn: CallTracker.prototype.verify,
      });
    }
  }

  reset(fn) {
    if (fn === undefined) {
      for (const record of this._tracked.values()) {
        record.calls = [];
      }
      return;
    }
    const record = this._tracked.get(fn);
    if (!record) {
      throw new Error('The provided function is not a tracked function.');
    }
    record.calls = [];
  }
}

// ---------------------------------------------------------------------------
// Assemble the exported callable + its method surface
// ---------------------------------------------------------------------------

assert.AssertionError = AssertionError;
assert.ok = ok;
assert.equal = equal;
assert.notEqual = notEqual;
assert.strictEqual = strictEqual;
assert.notStrictEqual = notStrictEqual;
assert.deepEqual = deepEqual;
assert.notDeepEqual = notDeepEqual;
assert.deepStrictEqual = deepStrictEqual;
assert.notDeepStrictEqual = notDeepStrictEqual;
assert.throws = throws;
assert.doesNotThrow = doesNotThrow;
assert.rejects = rejects;
assert.doesNotReject = doesNotReject;
assert.match = match;
assert.doesNotMatch = doesNotMatch;
assert.fail = fail;
assert.ifError = ifError;
assert.CallTracker = CallTracker;

// The strict variant: a callable mirror where loose helpers alias strict ones.
function strictAssert(value, message) {
  ok(value, message);
}
strictAssert.AssertionError = AssertionError;
strictAssert.ok = ok;
strictAssert.equal = strictEqual;
strictAssert.notEqual = notStrictEqual;
strictAssert.strictEqual = strictEqual;
strictAssert.notStrictEqual = notStrictEqual;
strictAssert.deepEqual = deepStrictEqual;
strictAssert.notDeepEqual = notDeepStrictEqual;
strictAssert.deepStrictEqual = deepStrictEqual;
strictAssert.notDeepStrictEqual = notDeepStrictEqual;
strictAssert.throws = throws;
strictAssert.doesNotThrow = doesNotThrow;
strictAssert.rejects = rejects;
strictAssert.doesNotReject = doesNotReject;
strictAssert.match = match;
strictAssert.doesNotMatch = doesNotMatch;
strictAssert.fail = fail;
strictAssert.ifError = ifError;
strictAssert.CallTracker = CallTracker;
strictAssert.strict = strictAssert;

assert.strict = strictAssert;

module.exports = assert;
module.exports.default = assert;

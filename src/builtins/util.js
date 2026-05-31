'use strict';

// Shim of Node.js's `node:util` module for the velox runtime (JavaScriptCore).
// This file is a CommonJS module body; it is wrapped by the runtime as:
//   __modules['node:util'] = async function (module, exports, require) { ... };
// so we export via `module.exports` / `exports`.

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

// Delegate to the runtime-provided formatter. `__velox_inspect` already handles
// objects/arrays/Map/Set/circular/depth/functions and returns a string
// (top-level strings unquoted, nested quoted) — matching Node's util.inspect.
function inspect(value, _opts) {
  return globalThis.__velox_inspect(value);
}
// Symbol Node looks up to let objects provide a custom inspect representation.
inspect.custom = Symbol.for('nodejs.util.inspect.custom');

// ---------------------------------------------------------------------------
// format / formatWithOptions
// ---------------------------------------------------------------------------

// Matches a printf-style conversion specifier. We capture the conversion char.
const formatRegExp = /%[sdifjoOc%]/g;

// Format a single non-string argument for the "leftover args" tail or for %o/%O.
// Strings are returned as-is (Node appends bare strings); everything else is
// run through inspect so objects render like `{ a: 1 }`.
function inspectArg(arg) {
  if (typeof arg === 'string') return arg;
  return inspect(arg);
}

// Core printf engine shared by format() and formatWithOptions().
// `_inspectOptions` is accepted for API compatibility; the underlying
// __velox_inspect does not currently take options, so it is unused.
// Match Node's number formatting in `%d`/`%i`/`%f`: negative zero renders as
// "-0" (plain `String(-0)` is "0").
function formatNumber(n) {
  return Object.is(n, -0) ? '-0' : String(n);
}

function formatWithOptionsInternal(_inspectOptions, args) {
  const first = args[0];

  // If the first argument is not a string, Node just inspect-joins everything.
  if (typeof first !== 'string') {
    const pieces = [];
    for (let i = 0; i < args.length; i++) {
      // Top-level strings are emitted bare; non-strings are inspected.
      pieces.push(typeof args[i] === 'string' ? args[i] : inspect(args[i]));
    }
    return pieces.join(' ');
  }

  // No conversion specifiers at all: fast path — just append remaining args.
  if (args.length === 1) return first;

  let str = '';
  let lastPos = 0;       // index in `first` up to which we've copied
  let argIndex = 1;      // next argument to consume for a specifier
  let match;

  formatRegExp.lastIndex = 0;
  while ((match = formatRegExp.exec(first)) !== null) {
    const conv = match[0];
    const matchStart = match.index;

    // Literal `%%` — emit a single `%` and consume no argument.
    if (conv === '%%') {
      str += first.slice(lastPos, matchStart) + '%';
      lastPos = matchStart + 2;
      continue;
    }

    // If we've run out of arguments, leave the specifier untouched
    // (e.g. format('%s:%s', 'a') -> 'a:%s').
    if (argIndex >= args.length) {
      // Stop trying to substitute; the rest of the string is copied verbatim
      // below, and the unused %c case is irrelevant here.
      break;
    }

    str += first.slice(lastPos, matchStart);
    const arg = args[argIndex];

    switch (conv) {
      case '%s': {
        // %s: BigInt gets an `n` suffix; objects use inspect; else String().
        if (typeof arg === 'bigint') str += String(arg) + 'n';
        else if (typeof arg === 'number') str += String(arg);
        else if (arg === null || typeof arg !== 'object') str += String(arg);
        else str += inspect(arg);
        break;
      }
      case '%d': {
        // Number: `Number(value)` — keeps decimals (1.5 -> "1.5"), unlike %i.
        if (typeof arg === 'bigint') str += String(arg) + 'n';
        else if (typeof arg === 'symbol') str += 'NaN';
        else str += formatNumber(Number(arg));
        break;
      }
      case '%i': {
        // Integer: `parseInt(value, 10)` — truncates (1.5 -> "1").
        if (typeof arg === 'bigint') str += String(arg) + 'n';
        else if (typeof arg === 'symbol') str += 'NaN';
        else str += formatNumber(truncInt(arg));
        break;
      }
      case '%f': {
        // Float.
        if (typeof arg === 'symbol') str += 'NaN';
        else str += formatNumber(parseFloat(arg));
        break;
      }
      case '%j': {
        // JSON, with circular references rendered as '[Circular]'.
        str += tryStringify(arg);
        break;
      }
      case '%o':
      case '%O': {
        // Inspect the value.
        str += inspect(arg);
        break;
      }
      case '%c': {
        // CSS directive: consumed and ignored (no output).
        str += '';
        break;
      }
    }

    lastPos = matchStart + 2;
    argIndex++;
  }

  // Copy the remainder of the format string verbatim.
  str += first.slice(lastPos);

  // Append any leftover arguments, space-separated.
  while (argIndex < args.length) {
    const arg = args[argIndex];
    str += ' ' + (typeof arg === 'string' ? arg : inspect(arg));
    argIndex++;
  }

  return str;
}

// Integer conversion for %d/%i matching Node (truncate toward zero).
function truncInt(arg) {
  const n = Number(arg);
  if (Number.isNaN(n)) return 'NaN';
  return Math.trunc(n);
}

// JSON.stringify wrapper that degrades circular structures to '[Circular]',
// matching the behavior of Node's %j conversion.
function tryStringify(arg) {
  try {
    return JSON.stringify(arg);
  } catch (err) {
    if (err instanceof RangeError || /circular/i.test(String(err && err.message))) {
      return '[Circular]';
    }
    throw err;
  }
}

function format(...args) {
  return formatWithOptionsInternal(undefined, args);
}

function formatWithOptions(inspectOptions, ...args) {
  if (typeof inspectOptions !== 'object' || inspectOptions === null) {
    throw new TypeError(
      'The "inspectOptions" argument must be of type object.'
    );
  }
  return formatWithOptionsInternal(inspectOptions, args);
}

// ---------------------------------------------------------------------------
// inherits
// ---------------------------------------------------------------------------

function inherits(ctor, superCtor) {
  if (ctor === undefined || ctor === null) {
    throw new TypeError('The "ctor" argument must be of type function.');
  }
  if (superCtor === undefined || superCtor === null) {
    throw new TypeError('The "superCtor" argument must be of type function.');
  }
  if (superCtor.prototype === undefined) {
    throw new TypeError('The "superCtor.prototype" property must be of type function.');
  }
  // Node exposes the parent constructor as `super_` and links prototypes.
  Object.defineProperty(ctor, 'super_', {
    value: superCtor,
    writable: true,
    configurable: true,
  });
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

// ---------------------------------------------------------------------------
// deprecate
// ---------------------------------------------------------------------------

function deprecate(fn, msg) {
  let warned = false;
  function deprecated(...args) {
    if (!warned) {
      warned = true;
      try {
        if (globalThis.process && globalThis.process.stderr) {
          globalThis.process.stderr.write('(velox) DeprecationWarning: ' + msg + '\n');
        }
      } catch (_e) {
        // best-effort; never throw from the warning path
      }
    }
    return fn.apply(this, args);
  }
  // Preserve the original prototype so `new deprecated()` still works.
  if (fn.prototype) deprecated.prototype = fn.prototype;
  return deprecated;
}

// ---------------------------------------------------------------------------
// promisify / callbackify
// ---------------------------------------------------------------------------

const kCustomPromisifiedSymbol = Symbol.for('nodejs.util.promisify.custom');

function promisify(original) {
  if (typeof original !== 'function') {
    throw new TypeError('The "original" argument must be of type function.');
  }

  // Honor a user-provided custom promisified implementation.
  if (original[kCustomPromisifiedSymbol]) {
    const fn = original[kCustomPromisifiedSymbol];
    if (typeof fn !== 'function') {
      throw new TypeError('The "util.promisify.custom" property must be of type function.');
    }
    return fn;
  }

  function promisified(...args) {
    return new Promise((resolve, reject) => {
      original.call(this, ...args, (err, ...values) => {
        if (err) return reject(err);
        // Node resolves with the single value after the error argument.
        resolve(values[0]);
      });
    });
  }

  // Inherit static properties and prototype, as Node does.
  Object.setPrototypeOf(promisified, Object.getPrototypeOf(original));
  Object.defineProperties(promisified, Object.getOwnPropertyDescriptors(original));
  return promisified;
}
promisify.custom = kCustomPromisifiedSymbol;

function callbackify(original) {
  if (typeof original !== 'function') {
    throw new TypeError('The "original" argument must be of type function.');
  }

  function callbackified(...args) {
    const cb = args.pop();
    if (typeof cb !== 'function') {
      throw new TypeError('The last argument must be of type function.');
    }
    const self = this;
    Promise.resolve(original.apply(self, args)).then(
      (value) => {
        // Defer to next tick so the callback is never invoked synchronously.
        queueMicrotask(() => cb.call(self, null, value));
      },
      (err) => {
        // Ensure a falsy rejection still surfaces as a truthy error.
        const reason = err || new Error('Promise was rejected with a falsy value');
        queueMicrotask(() => cb.call(self, reason));
      }
    );
  }

  Object.setPrototypeOf(callbackified, Object.getPrototypeOf(original));
  Object.defineProperties(callbackified, Object.getOwnPropertyDescriptors(original));
  return callbackified;
}

// ---------------------------------------------------------------------------
// debuglog
// ---------------------------------------------------------------------------

function debuglog(_section, _cb) {
  // velox has no NODE_DEBUG support; always return a disabled no-op logger.
  const fn = function debug() {};
  fn.enabled = false;
  return fn;
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

const toStr = Object.prototype.toString;
function tag(v) {
  return toStr.call(v);
}

const types = {
  isPromise(v) {
    return v instanceof Promise || tag(v) === '[object Promise]';
  },
  isDate(v) {
    return v instanceof Date || tag(v) === '[object Date]';
  },
  isRegExp(v) {
    return v instanceof RegExp || tag(v) === '[object RegExp]';
  },
  isMap(v) {
    return tag(v) === '[object Map]';
  },
  isSet(v) {
    return tag(v) === '[object Set]';
  },
  isWeakMap(v) {
    return tag(v) === '[object WeakMap]';
  },
  isWeakSet(v) {
    return tag(v) === '[object WeakSet]';
  },
  isAsyncFunction(v) {
    return typeof v === 'function' && tag(v) === '[object AsyncFunction]';
  },
  isGeneratorFunction(v) {
    return typeof v === 'function' && tag(v) === '[object GeneratorFunction]';
  },
  isArrayBuffer(v) {
    return tag(v) === '[object ArrayBuffer]';
  },
  isSharedArrayBuffer(v) {
    return tag(v) === '[object SharedArrayBuffer]';
  },
  isTypedArray(v) {
    return ArrayBuffer.isView(v) && !(v instanceof DataView);
  },
  isDataView(v) {
    return v instanceof DataView || tag(v) === '[object DataView]';
  },
  isNativeError(v) {
    return v instanceof Error || tag(v) === '[object Error]';
  },
  isBigIntObject(v) {
    return tag(v) === '[object BigInt]';
  },
  isBooleanObject(v) {
    return tag(v) === '[object Boolean]';
  },
  isNumberObject(v) {
    return tag(v) === '[object Number]';
  },
  isStringObject(v) {
    return tag(v) === '[object String]';
  },
  isSymbolObject(v) {
    return tag(v) === '[object Symbol]';
  },
  isAnyArrayBuffer(v) {
    return tag(v) === '[object ArrayBuffer]' || tag(v) === '[object SharedArrayBuffer]';
  },
  isBoxedPrimitive(v) {
    return (
      types.isNumberObject(v) ||
      types.isStringObject(v) ||
      types.isBooleanObject(v) ||
      types.isBigIntObject(v) ||
      types.isSymbolObject(v)
    );
  },
  isProxy() {
    return false;
  },
  isModuleNamespaceObject() {
    return false;
  },
};

// Typed-array element-type predicates (each returns false for non-matches).
const typedArrayCtors = {
  isUint8Array: typeof Uint8Array !== 'undefined' ? Uint8Array : null,
  isUint8ClampedArray: typeof Uint8ClampedArray !== 'undefined' ? Uint8ClampedArray : null,
  isUint16Array: typeof Uint16Array !== 'undefined' ? Uint16Array : null,
  isUint32Array: typeof Uint32Array !== 'undefined' ? Uint32Array : null,
  isInt8Array: typeof Int8Array !== 'undefined' ? Int8Array : null,
  isInt16Array: typeof Int16Array !== 'undefined' ? Int16Array : null,
  isInt32Array: typeof Int32Array !== 'undefined' ? Int32Array : null,
  isFloat32Array: typeof Float32Array !== 'undefined' ? Float32Array : null,
  isFloat64Array: typeof Float64Array !== 'undefined' ? Float64Array : null,
  isBigInt64Array: typeof BigInt64Array !== 'undefined' ? BigInt64Array : null,
  isBigUint64Array: typeof BigUint64Array !== 'undefined' ? BigUint64Array : null,
};
for (const name of Object.keys(typedArrayCtors)) {
  const Ctor = typedArrayCtors[name];
  types[name] = Ctor ? (v) => v instanceof Ctor : () => false;
}

// ---------------------------------------------------------------------------
// isDeepStrictEqual
// ---------------------------------------------------------------------------

function isDeepStrictEqual(a, b) {
  return deepEqual(a, b, new Set());
}

function deepEqual(a, b, seen) {
  // SameValue-ish for primitives, but with +0/-0 distinguished like Node.
  if (a === b) {
    if (a === 0) return 1 / a === 1 / b; // distinguish +0 / -0
    return true;
  }
  // NaN === NaN structurally.
  if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
    return true;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }

  // Must share the same [[Prototype]] and toString tag in strict mode.
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (tag(a) !== tag(b)) return false;

  // Guard against cycles.
  if (seen.has(a)) return true;
  seen.add(a);

  // Dates.
  if (a instanceof Date) return a.getTime() === b.getTime();
  // RegExps.
  if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags;

  // Arrays / typed arrays.
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
  }
  if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  // Maps.
  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k)) return false;
      if (!deepEqual(v, b.get(k), seen)) return false;
    }
    return true;
  }
  // Sets.
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) {
      if (!b.has(v)) {
        // Fall back to a structural search for object members.
        let found = false;
        for (const w of b) {
          if (deepEqual(v, w, seen)) { found = true; break; }
        }
        if (!found) return false;
      }
    }
    return true;
  }

  // Plain objects (and arrays' own enumerable keys).
  const keysA = Reflect.ownKeys(a).filter((k) => isEnumerable(a, k));
  const keysB = Reflect.ownKeys(b).filter((k) => isEnumerable(b, k));
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key], seen)) return false;
  }
  return true;
}

function isEnumerable(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return !!d && d.enumerable;
}

// ---------------------------------------------------------------------------
// Legacy type-check helpers (still exposed on Node's util)
// ---------------------------------------------------------------------------

function isArray(v) {
  return Array.isArray(v);
}
function isBoolean(v) {
  return typeof v === 'boolean';
}
function isNull(v) {
  return v === null;
}
function isNullOrUndefined(v) {
  return v === null || v === undefined;
}
function isNumber(v) {
  return typeof v === 'number';
}
function isString(v) {
  return typeof v === 'string';
}
function isSymbol(v) {
  return typeof v === 'symbol';
}
function isUndefined(v) {
  return v === undefined;
}
function isRegExp(v) {
  return types.isRegExp(v);
}
function isObject(v) {
  return v !== null && typeof v === 'object';
}
function isDate(v) {
  return types.isDate(v);
}
function isError(v) {
  return v instanceof Error || tag(v) === '[object Error]';
}
function isFunction(v) {
  return typeof v === 'function';
}
function isPrimitive(v) {
  return (
    v === null ||
    (typeof v !== 'object' && typeof v !== 'function')
  );
}
function isBuffer(v) {
  // velox has no Buffer global; report false unless one exists and matches.
  return typeof globalThis.Buffer !== 'undefined' &&
    globalThis.Buffer.isBuffer ? globalThis.Buffer.isBuffer(v) : false;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// parseArgs — a pragmatic implementation of Node's util.parseArgs.
function parseArgs(config) {
  config = config || {};
  var args = config.args || (globalThis.process ? process.argv.slice(2) : []);
  var options = config.options || {};
  var strict = config.strict !== false;
  var allowPositionals = config.allowPositionals || config.allowPositionals === undefined && !strict;
  if (config.allowPositionals !== undefined) allowPositionals = config.allowPositionals;

  // Map short flags to their long name.
  var shorts = {};
  for (var name in options) {
    if (options[name] && options[name].short) shorts[options[name].short] = name;
  }
  function optFor(name) { return options[name]; }
  function typeOf(name) { var o = optFor(name); return o && o.type === 'boolean' ? 'boolean' : (o ? 'string' : undefined); }

  var values = {};
  var positionals = [];
  var tokens = [];

  // Apply declared defaults.
  for (var dn in options) if (options[dn] && 'default' in options[dn]) values[dn] = options[dn].default;

  function setValue(name, val, isBool) {
    var o = optFor(name);
    if (o && o.multiple) { if (!Array.isArray(values[name])) values[name] = []; values[name].push(isBool ? true : val); }
    else values[name] = isBool ? true : val;
  }

  var i = 0;
  var doubleDash = false;
  for (; i < args.length; i++) {
    var arg = args[i];
    if (doubleDash) { positionals.push(arg); continue; }
    if (arg === '--') { doubleDash = true; continue; }
    if (arg.startsWith('--')) {
      var body = arg.slice(2);
      var eq = body.indexOf('=');
      var key = eq === -1 ? body : body.slice(0, eq);
      var inlineVal = eq === -1 ? undefined : body.slice(eq + 1);
      if (strict && !optFor(key)) throw new TypeError("Unknown option '--" + key + "'");
      if (typeOf(key) === 'boolean') { setValue(key, true, true); tokens.push({ kind: 'option', name: key, value: undefined }); }
      else {
        var v = inlineVal !== undefined ? inlineVal : args[++i];
        setValue(key, v, false); tokens.push({ kind: 'option', name: key, value: v });
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      // Short flags, possibly grouped: -abc or -p value or -p=value.
      var chars = arg.slice(1);
      for (var c = 0; c < chars.length; c++) {
        var sh = chars[c];
        var lname = shorts[sh] || sh;
        if (strict && !optFor(lname)) throw new TypeError("Unknown option '-" + sh + "'");
        if (typeOf(lname) === 'boolean') { setValue(lname, true, true); tokens.push({ kind: 'option', name: lname, value: undefined }); }
        else {
          var rest = chars.slice(c + 1);
          var sv = rest ? (rest[0] === '=' ? rest.slice(1) : rest) : args[++i];
          setValue(lname, sv, false); tokens.push({ kind: 'option', name: lname, value: sv });
          break;
        }
      }
    } else {
      if (!allowPositionals && strict) throw new TypeError("Unexpected positional '" + arg + "'");
      positionals.push(arg); tokens.push({ kind: 'positional', index: positionals.length - 1, value: arg });
    }
  }

  var result = { values: values, positionals: positionals };
  if (config.tokens) result.tokens = tokens;
  return result;
}

// Strip ANSI/VT control sequences (Node 16.11+: util.stripVTControlCharacters).
// Built from escapes so the ESC/CSI bytes are explicit.
var ANSI_RE = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*' +
  '(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)' +
  '|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  'g'
)
function stripVTControlCharacters(str) {
  if (typeof str !== 'string') throw new TypeError('The "str" argument must be of type string.');
  return str.replace(ANSI_RE, '');
}

// Promise-with-resolvers style helper Node exposes as util.deferred-ish; and
// styleText (Node 20.12+) for ANSI styling — minimal passthrough.
function styleText(format, text) { return text; }

module.exports = {
  // Core
  inspect,
  format,
  formatWithOptions,
  inherits,
  deprecate,
  promisify,
  callbackify,
  debuglog,
  debug: debuglog, // Node aliases util.debug -> util.debuglog
  types,
  isDeepStrictEqual,
  parseArgs,
  stripVTControlCharacters,
  styleText,
  TextEncoder: globalThis.TextEncoder,
  TextDecoder: globalThis.TextDecoder,
  _extend: function (a, b) { return Object.assign(a, b); },

  // Legacy type checks
  isArray,
  isBoolean,
  isNull,
  isNullOrUndefined,
  isNumber,
  isString,
  isSymbol,
  isUndefined,
  isRegExp,
  isObject,
  isDate,
  isError,
  isFunction,
  isPrimitive,
  isBuffer,
};

// Re-export the global TextEncoder/TextDecoder if the engine provides them.
if (typeof globalThis.TextEncoder !== 'undefined') {
  module.exports.TextEncoder = globalThis.TextEncoder;
}
if (typeof globalThis.TextDecoder !== 'undefined') {
  module.exports.TextDecoder = globalThis.TextDecoder;
}

// internal/errors — a pragmatic port of Node's coded-error system. Node builtins
// throw errors carrying a `.code` (e.g. `ERR_INVALID_ARG_TYPE`) and a name like
// `TypeError [ERR_INVALID_ARG_TYPE]`; thousands of Node tests assert on these via
// `assert.throws(fn, { code })`. velox's builtins use this module so their
// validation errors match; tests that `require('internal/errors')` directly run.

var classRegExp = /^([A-Z][a-z0-9]*)+$/;
var kTypes = ['string', 'function', 'number', 'object', 'Function', 'Object', 'boolean', 'bigint', 'symbol'];

function addNumericalSeparator(val) {
  var res = '';
  var i = val.length;
  var start = val[0] === '-' ? 1 : 0;
  for (; i >= start + 4; i -= 3) res = '_' + val.slice(i - 3, i) + res;
  return val.slice(0, i) + res;
}

// The set of code -> Error factory.
var codes = {};

function makeNodeErrorWithCode(Base, key, messageFn) {
  function NodeError() {
    var args = Array.prototype.slice.call(arguments);
    var err = new Base(messageFn.apply(null, args));
    Object.defineProperty(err, 'message', { value: err.message, enumerable: false, writable: true, configurable: true });
    Object.defineProperty(err, 'toString', {
      value: function () { return this.name + ': ' + this.message; },
      enumerable: false, writable: true, configurable: true,
    });
    err.code = key;
    // Node sets name to `${Base.name} [${code}]` but keeps it non-enumerable.
    Object.defineProperty(err, 'name', { value: Base.name + ' [' + key + ']', enumerable: false, writable: true, configurable: true });
    return err;
  }
  NodeError.prototype = Object.create(Base.prototype);
  NodeError.prototype.constructor = NodeError;
  codes[key] = NodeError;
  return NodeError;
}

// --- the common, widely-asserted-on error codes ----------------------------

makeNodeErrorWithCode(TypeError, 'ERR_INVALID_ARG_TYPE', function (name, expected, actual) {
  if (!Array.isArray(expected)) expected = [expected];
  var msg = 'The ';
  if (name.endsWith(' argument')) msg += name + ' ';
  else msg += '"' + name + '" ' + (name.includes('.') ? 'property' : 'argument') + ' ';
  // "must be of type x" / "must be one of type x, y, or z"
  var types = expected.map(function (t) {
    return classRegExp.test(t) && kTypes.indexOf(t) === -1 ? 'an instance of ' + t : 'of type ' + String(t).toLowerCase();
  });
  if (types.length === 1) msg += 'must be ' + types[0];
  else if (types.length === 2) msg += 'must be ' + types[0] + ' or ' + types[1];
  else msg += 'must be one of ' + types.slice(0, -1).join(', ') + ', or ' + types[types.length - 1];
  msg += '.' + receivedString(actual);
  return msg;
});

makeNodeErrorWithCode(RangeError, 'ERR_OUT_OF_RANGE', function (name, range, value) {
  var received = value;
  if (Number.isInteger(value) && Math.abs(value) > 2 ** 32) received = addNumericalSeparator(String(value));
  else if (typeof value === 'bigint') { received = String(value); if (value > 2n ** 32n || value < -(2n ** 32n)) received = addNumericalSeparator(received); received += 'n'; }
  else received = inspectLite(value);
  return 'The value of "' + name + '" is out of range. It must be ' + range + '. Received ' + received;
});

makeNodeErrorWithCode(TypeError, 'ERR_INVALID_ARG_VALUE', function (name, value, reason) {
  reason = reason || 'is invalid';
  var inspected = inspectLite(value);
  return (name.includes('.') ? 'The property \'' + name + '\'' : 'The argument \'' + name + '\'') + ' ' + reason + '. Received ' + inspected;
});

makeNodeErrorWithCode(RangeError, 'ERR_BUFFER_OUT_OF_BOUNDS', function (name) {
  return name ? '"' + name + '" is outside of buffer bounds' : 'Attempt to access memory outside buffer bounds';
});

makeNodeErrorWithCode(RangeError, 'ERR_BUFFER_TOO_LARGE', function (max) {
  return 'Cannot create a Buffer larger than ' + max + ' bytes';
});

makeNodeErrorWithCode(TypeError, 'ERR_UNKNOWN_ENCODING', function (enc) {
  return 'Unknown encoding: ' + enc;
});

makeNodeErrorWithCode(TypeError, 'ERR_INVALID_BUFFER_SIZE', function (size) {
  return 'Buffer size must be a multiple of ' + size;
});

makeNodeErrorWithCode(TypeError, 'ERR_MISSING_ARGS', function () {
  var args = Array.prototype.slice.call(arguments);
  var names = args.map(function (a) { return '"' + a + '"'; });
  return 'The ' + names.join(', ') + ' argument' + (names.length > 1 ? 's' : '') + ' must be specified';
});

makeNodeErrorWithCode(TypeError, 'ERR_INVALID_CALLBACK', function (cb) {
  return 'Callback must be a function. Received ' + inspectLite(cb);
});

makeNodeErrorWithCode(Error, 'ERR_INVALID_THIS', function (type) {
  return 'Value of "this" must be of type ' + type;
});

makeNodeErrorWithCode(TypeError, 'ERR_INVALID_ARG_TYPE_RANGE', function (m) { return m; });
makeNodeErrorWithCode(Error, 'ERR_UNHANDLED_ERROR', function (err) { return 'Unhandled error.' + (err ? ' (' + err + ')' : ''); });
makeNodeErrorWithCode(RangeError, 'ERR_INVALID_OPT_VALUE', function (name, value) { return 'The value "' + inspectLite(value) + '" is invalid for option "' + name + '"'; });

function receivedString(actual) {
  if (actual == null) return ' Received ' + actual;
  if (typeof actual === 'function' && actual.name) return ' Received function ' + actual.name;
  if (typeof actual === 'object') {
    if (actual.constructor && actual.constructor.name) return ' Received an instance of ' + actual.constructor.name;
    return ' Received ' + inspectLite(actual);
  }
  var inspected = inspectLite(actual);
  if (inspected.length > 28) inspected = inspected.slice(0, 25) + '...';
  return ' Received type ' + typeof actual + ' (' + inspected + ')';
}

function inspectLite(v) {
  try {
    if (typeof globalThis.__velox_inspect === 'function') return globalThis.__velox_inspect(v);
  } catch (e) {}
  if (typeof v === 'string') return "'" + v + "'";
  if (typeof v === 'bigint') return String(v) + 'n';
  return String(v);
}

module.exports = { codes: codes };
module.exports.default = module.exports;

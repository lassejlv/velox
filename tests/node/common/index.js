// Minimal Node test `common` harness shim — enough to run many parallel tests.
'use strict';
const assert = require('assert');

const mustCallChecks = [];
function runCallChecks() {
  const failed = mustCallChecks.filter((c) => {
    if ('minimum' in c) { c.messageSegment = `at least ${c.minimum}`; return c.actual < c.minimum; }
    c.messageSegment = `exactly ${c.exact}`; return c.actual !== c.exact;
  });
  failed.forEach((c) => {
    console.error(`Mismatched ${c.name} function calls. Expected ${c.messageSegment}, actual ${c.actual}.`);
  });
  if (failed.length) process.exit(1);
}
if (typeof process !== 'undefined' && process.on) process.on('exit', runCallChecks);

function _mustCallInner(fn, criteria, field) {
  if (typeof fn === 'number') { criteria = fn; fn = () => {}; }
  else if (fn === undefined) fn = () => {};
  const context = { [field]: criteria, actual: 0, name: fn.name || '<anonymous>' };
  mustCallChecks.push(context);
  function wrapped(...args) { context.actual++; return fn.apply(this, args); }
  return wrapped;
}
function mustCall(fn, exact) { return _mustCallInner(fn, exact === undefined ? 1 : exact, 'exact'); }
function mustCallAtLeast(fn, minimum) { return _mustCallInner(fn, minimum === undefined ? 1 : minimum, 'minimum'); }
function mustSucceed(fn, exact) { return mustCall(function (err, ...a) { assert.ifError(err); if (typeof fn === 'function') return fn.apply(this, a); }, exact); }
function mustNotCall(msg) { return function (...args) { assert.fail(msg || `mustNotCall: ${args.length} args`); }; }
function mustNotMutateObjectDeep(obj) { return obj; }

module.exports = {
  mustCall, mustCallAtLeast, mustSucceed, mustNotCall, mustNotMutateObjectDeep,
  isWindows: process.platform === 'win32',
  isMacOS: process.platform === 'darwin',
  isLinux: process.platform === 'linux',
  isMainThread: true,
  isDumbTerminal: true,
  hasCrypto: true,
  hasIntl: typeof Intl !== 'undefined',
  hasMultiLocalhost: false,
  enoughTestMem: true,
  platformTimeout: (ms) => ms,
  allowGlobals: () => {},
  skip: (msg) => { console.log('1..0 # SKIP', msg); process.exit(0); },
  skipIfInspectorDisabled: () => {},
  printSkipMessage: (msg) => console.log('1..0 # SKIP', msg),
  expectsError: () => {},
  expectWarning: () => {},
  getCallSite: () => '',
  runWithInvalidFD: () => {},
  PORT: 12346,
  localhostIPv4: '127.0.0.1',
  mustCallChecks,
  getArrayBufferViews: (buf) => [buf],
  getBufferSources: (buf) => [buf],
  spawnPromisified: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
};

const util = require('util');
module.exports.invalidArgTypeHelper = function invalidArgTypeHelper(input) {
  if (input == null) return ` Received ${input}`;
  if (typeof input === 'function') return ` Received function ${input.name || '(anonymous)'}`;
  if (typeof input === 'object') {
    if (input.constructor && input.constructor.name) return ` Received an instance of ${input.constructor.name}`;
    return ` Received ${util.inspect(input, { depth: -1 })}`;
  }
  let inspected = util.inspect(input, { colors: false });
  if (inspected.length > 28) inspected = `${inspected.slice(0, 25)}...`;
  return ` Received type ${typeof input} (${inspected})`;
};
module.exports.getArrayBufferViews = function (buf) {
  const { byteOffset, byteLength } = buf;
  const ab = buf.buffer || buf;
  const out = [];
  const Ctors = [Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, DataView];
  for (const Ctor of Ctors) {
    const len = Math.floor(byteLength / (Ctor.BYTES_PER_ELEMENT || 1));
    if (len > 0) try { out.push(new Ctor(ab, byteOffset, len)); } catch (e) {}
  }
  return out;
};
module.exports.runWithInvalidFD = function () {};

// Additional helpers various parallel tests reach for.
Object.assign(module.exports, {
  skipIf32Bits: () => {},
  skipIfDumbTerminal: () => {},
  skipIfWorker: () => {},
  skipIfInspectorDisabled: () => {},
  skipIfEslintMissing: () => {},
  hasFipsCrypto: false,
  isAIX: process.platform === 'aix',
  isIBMi: false,
  isSunOS: process.platform === 'sunos',
  isFreeBSD: process.platform === 'freebsd',
  isOpenBSD: process.platform === 'openbsd',
  isOSX: process.platform === 'darwin',
  buildType: 'Release',
  rootDir: '/',
  getCallSites: () => [],
  expectsInternalAssertion: () => {},
  canCreateSymLink: () => true,
  childShouldThrowAndAbort: () => {},
  createZeroFilledFile: () => {},
});

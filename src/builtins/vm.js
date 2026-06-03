// node:vm — sandboxed execution. The sandbox is exposed as the code's global
// scope via a `with(proxy)` block whose `has` trap claims every identifier, so
// free variables resolve to the sandbox (or a standard JS intrinsic) instead of
// the host's real globals — much closer to Node's separate-context isolation
// than a bare Function call. (Caveat vs. a true separate JSContext: top-level
// `var`/function *declarations* inside the code don't write back to the sandbox;
// implicit-global assignments — `x = 1` — do.)

// Standard JS intrinsics a fresh context still gets (Node exposes these in a new
// context; host-specific globals like process/require are NOT exposed).
var INTRINSICS = [
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "BigInt", "Math",
  "JSON", "Date", "RegExp", "Map", "Set", "WeakMap", "WeakSet", "WeakRef",
  "Promise", "Proxy", "Reflect", "Function", "Error", "TypeError", "RangeError",
  "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError",
  "parseInt", "parseFloat", "isNaN", "isFinite", "NaN", "Infinity", "undefined",
  "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array",
  "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array",
  "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
  "Intl", "atob", "btoa", "structuredClone",
];
var INTRINSIC_SET = new Set(INTRINSICS);

var CONTEXT_FLAG = "__velox_vm_context__";

function makeScope(sandbox) {
  var scope = new Proxy(sandbox, {
    // Trap every identifier so `with` routes all free-variable lookups here
    // (never falling through to the host global) — except: `Symbol.unscopables`
    // (must report absent for `with` to work), `eval` (must stay the *direct*
    // eval so the evaluated code inherits this `with` scope), and the runner's
    // own `__velox_*` params (must resolve lexically, not via the sandbox).
    has: function (target, key) {
      if (key === Symbol.unscopables) return false;
      if (key === "eval") return false;
      if (typeof key === "string" && key.indexOf("__velox_") === 0) return false;
      return true;
    },
    get: function (target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (key === "globalThis" || key === "global" || key === "self") return target;
      if (key in target) return target[key];
      if (typeof key === "string" && INTRINSIC_SET.has(key)) return globalThis[key];
      return undefined;
    },
    set: function (target, key, value) { target[key] = value; return true; },
    deleteProperty: function (target, key) { delete target[key]; return true; },
  });
  return scope;
}

// `with (scope) { return eval(code); }` — `eval` is direct, so the evaluated
// code inherits the `with` scope and all its free identifiers hit the proxy.
var SANDBOX_RUNNER = new Function(
  "__velox_scope__", "__velox_code__",
  "with (__velox_scope__) { return eval(__velox_code__); }"
);

function runInNewContext(code, sandbox, options) {
  sandbox = sandbox || {};
  // Prefer the native isolated context (real separate JSContext): it gives true
  // host isolation AND top-level `var`/function write-back to the sandbox.
  if (typeof globalThis.__velox_vm_run === 'function') {
    return globalThis.__velox_vm_run(String(code), sandbox);
  }
  // Fallback: the `with(proxy)` sandbox (isolates host globals; no var write-back).
  return SANDBOX_RUNNER(makeScope(sandbox), String(code));
}
// --- dynamic import() inside vm code ----------------------------------------
// JSC's own loader can't resolve here, so `import(spec)` in vm-compiled code is
// rewritten to a hook: it calls the script's `importModuleDynamically` when
// given, and otherwise rejects with Node's ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING.
var dynImportHooks = { nextId: 1, map: {} };
Object.defineProperty(globalThis, '__velox_vm_dyn_import', {
  value: function (id, spec) {
    var hook = id && dynImportHooks.map[id];
    if (hook) {
      return Promise.resolve().then(function () {
        var ns = hook(String(spec));
        return ns && ns.namespace ? ns.namespace : ns;
      });
    }
    var e = new TypeError(
      'A dynamic import callback was not specified.');
    e.code = 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING';
    return Promise.reject(e);
  },
  writable: true, enumerable: false, configurable: true,
});
function instrumentDynamicImport(code, options) {
  code = String(code);
  if (code.indexOf('import') === -1 || !/import\s*\(/.test(code)) return code;
  var id = 0;
  if (options && typeof options.importModuleDynamically === 'function') {
    id = dynImportHooks.nextId++;
    dynImportHooks.map[id] = options.importModuleDynamically;
  }
  // `import(` not preceded by an identifier char or `.` (so `obj.import()`
  // and `Ximport(` stay untouched).
  return code.replace(/([^.\w$]|^)import\s*\(/g, function (m, pre) {
    return pre + '__velox_vm_dyn_import(' + id + ', ';
  });
}

function runInThisContext(code, options) {
  var indirectEval = eval;
  return indirectEval(instrumentDynamicImport(code, options));
}
function createContext(sandbox) {
  sandbox = sandbox || {};
  try { Object.defineProperty(sandbox, CONTEXT_FLAG, { value: true, enumerable: false, configurable: true }); }
  catch (e) {}
  return sandbox;
}
function runInContext(code, contextifiedSandbox, options) {
  // Reuse the same sandbox object so state persists across runs.
  contextifiedSandbox = contextifiedSandbox || {};
  if (typeof globalThis.__velox_vm_run === 'function') {
    return globalThis.__velox_vm_run(String(code), contextifiedSandbox);
  }
  return SANDBOX_RUNNER(makeScope(contextifiedSandbox), String(code));
}
function isContext(sandbox) {
  return !!(sandbox && sandbox[CONTEXT_FLAG]);
}
function compileFunction(code, params, options) {
  params = params || [];
  code = instrumentDynamicImport(code, options);
  var ctx = options && options.parsingContext;
  if (ctx) {
    // Compile with the contextified sandbox in scope.
    var runner = new Function(
      "__velox_scope__", "__velox_params__", "__velox_body__",
      "with (__velox_scope__) { return new Function(...__velox_params__, __velox_body__); }"
    );
    return runner(makeScope(ctx), params, String(code));
  }
  return Function.apply(null, params.concat([String(code)]));
}
function measureMemory() {
  return Promise.resolve({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] } });
}

function Script(code, options) {
  this.code = String(code);
  this._options = options;
}
Script.prototype.runInNewContext = function (sandbox, o) { return runInNewContext(this.code, sandbox, o); };
Script.prototype.runInContext = function (ctx, o) { return runInContext(this.code, ctx, o); };
Script.prototype.runInThisContext = function (o) { return runInThisContext(this.code, this._options || o); };

// --- vm.SyntheticModule (the --experimental-vm-modules surface) -------------
// A module whose exports are set programmatically via setExport. Pure JS — no
// native retention, so instances are ordinarily garbage-collectable.
var syntheticModuleCounter = 0;
function SyntheticModule(exportNames, evaluateCallback, options) {
  if (!(this instanceof SyntheticModule)) {
    throw new TypeError("Class constructor SyntheticModule cannot be invoked without 'new'");
  }
  this._exportNames = (exportNames || []).slice();
  this._evaluateCallback = evaluateCallback;
  this._namespace = { __proto__: null };
  this.status = 'unlinked';
  this.identifier = (options && options.identifier) ||
    'vm:module(' + syntheticModuleCounter++ + ')';
  this.context = (options && options.context) || undefined;
  this.error = undefined;
}
Object.defineProperty(SyntheticModule.prototype, 'namespace', {
  configurable: true,
  get: function () { return this._namespace; },
});
SyntheticModule.prototype.link = function (_linker) {
  this.status = 'linked';
  return Promise.resolve();
};
SyntheticModule.prototype.evaluate = function () {
  var self = this;
  return Promise.resolve().then(function () {
    self.status = 'evaluating';
    if (typeof self._evaluateCallback === 'function') self._evaluateCallback.call(self);
    self.status = 'evaluated';
  });
};
SyntheticModule.prototype.setExport = function (name, value) {
  if (this._exportNames.indexOf(name) === -1) {
    var e = new ReferenceError('Module did not declare an export named "' + name + '"');
    e.code = 'ERR_VM_MODULE_SYMBOL_NOT_DEFINED';
    throw e;
  }
  this._namespace[name] = value;
};

module.exports = {
  runInNewContext: runInNewContext,
  runInThisContext: runInThisContext,
  runInContext: runInContext,
  createContext: createContext,
  isContext: isContext,
  compileFunction: compileFunction,
  measureMemory: measureMemory,
  Script: Script,
  SyntheticModule: SyntheticModule,
};
module.exports.default = module.exports;

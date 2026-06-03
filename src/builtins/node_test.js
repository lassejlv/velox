// node:test — a pragmatic implementation of Node's built-in test runner API.
// Supports test()/it()/describe()/suite(), before/after/beforeEach/afterEach
// hooks, t.test() subtests, t.diagnostic/skip/todo, skip/todo/only options, and
// TAP-ish output with a final summary. Failures set process.exitCode = 1.
//
// This is the module API (`import { test } from 'node:test'`); velox also has a
// separate describe/it/expect framework for `velox test` (builtins/test.js).

var assert = require("node:assert");

var rootEntries = []; // top-level tests and suites, in declaration order
var suiteStack = []; // describe() nesting while registering
var scheduled = false;
var counter = 0;
var passed = 0;
var failed = 0;
var skipped = 0;
var todoCount = 0;

function currentSuite() {
  return suiteStack.length ? suiteStack[suiteStack.length - 1] : null;
}

function emptyHooks() {
  return { before: [], after: [], beforeEach: [], afterEach: [] };
}

// Normalize the (name, options, fn) overloads node:test accepts.
function normalizeArgs(name, options, fn) {
  if (typeof name === "function") { fn = name; options = {}; name = fn.name || "<anonymous>"; }
  else if (typeof options === "function") { fn = options; options = {}; }
  if (options == null) options = {};
  if (typeof name !== "string") name = (fn && fn.name) || "<anonymous>";
  return { name: name, options: options, fn: fn };
}

function registerTest(name, options, fn) {
  var a = normalizeArgs(name, options, fn);
  var entry = { kind: "test", name: a.name, fn: a.fn, options: a.options };
  var suite = currentSuite();
  if (suite) suite.children.push(entry);
  else { rootEntries.push(entry); scheduleFlush(); }
  // node:test returns a promise; for top-level tests the real run happens at
  // flush, so resolve immediately (callers rarely await the top-level return).
  return Promise.resolve();
}

function registerSuite(name, options, fn) {
  var a = normalizeArgs(name, options, fn);
  var suite = { kind: "suite", name: a.name, options: a.options, children: [], hooks: emptyHooks() };
  var parent = currentSuite();
  if (parent) parent.children.push(suite);
  else { rootEntries.push(suite); scheduleFlush(); }
  // Run the body synchronously to register child tests/hooks.
  suiteStack.push(suite);
  try { if (a.fn) a.fn(); } finally { suiteStack.pop(); }
  return Promise.resolve();
}

// Hooks: when called inside describe() they attach to that suite; at top level
// they attach to a synthetic root hook set.
var rootHooks = emptyHooks();
function addHook(kind, fn) {
  var suite = currentSuite();
  (suite ? suite.hooks : rootHooks)[kind].push(fn);
}

function makeContext(name) {
  var ctx = {
    name: name,
    _skipped: false,
    _todo: false,
    diagnostic: function (msg) { log("# " + msg); },
    skip: function (msg) { ctx._skipped = true; if (msg) ctx._skipMsg = msg; },
    todo: function (msg) { ctx._todo = true; if (msg) ctx._todoMsg = msg; },
    plan: function () {},
    assert: assert,
    mock: mock,
    signal: undefined,
    // t.test() subtest — runs inline and is awaited by the parent.
    test: function (n, o, f) {
      var a = normalizeArgs(n, o, f);
      return runTest({ kind: "test", name: a.name, fn: a.fn, options: a.options }, 1);
    },
  };
  ctx.it = ctx.test;
  return ctx;
}

function log(line) {
  try { process.stdout.write(line + "\n"); } catch (e) { console.log(line); }
}

function indent(depth) { var s = ""; for (var i = 0; i < depth; i++) s += "    "; return s; }

async function callHooks(hooks, kind, arg) {
  for (var i = 0; i < hooks[kind].length; i++) {
    var r = hooks[kind][i](arg);
    if (r && typeof r.then === "function") await r;
  }
}

// Run a single test entry. Returns true on pass/skip/todo, false on failure.
async function runTest(entry, depth) {
  var opts = entry.options || {};
  counter++;
  var num = counter;
  if (opts.skip) { skipped++; log(indent(depth) + "ok " + num + " - " + entry.name + " # SKIP" + (typeof opts.skip === "string" ? " " + opts.skip : "")); return true; }
  if (opts.todo) { todoCount++; log(indent(depth) + "ok " + num + " - " + entry.name + " # TODO" + (typeof opts.todo === "string" ? " " + opts.todo : "")); return true; }

  var ctx = makeContext(entry.name);
  try {
    if (entry.fn) {
      if (entry.fn.length >= 2) {
        // callback style: fn(t, done)
        await new Promise(function (resolve, reject) {
          var done = function (err) { err ? reject(err) : resolve(); };
          var r = entry.fn(ctx, done);
          if (r && typeof r.then === "function") r.then(resolve, reject);
        });
      } else {
        var r2 = entry.fn(ctx);
        if (r2 && typeof r2.then === "function") await r2;
      }
    }
    if (ctx._skipped) { skipped++; log(indent(depth) + "ok " + num + " - " + entry.name + " # SKIP" + (ctx._skipMsg ? " " + ctx._skipMsg : "")); return true; }
    if (ctx._todo) { todoCount++; log(indent(depth) + "ok " + num + " - " + entry.name + " # TODO" + (ctx._todoMsg ? " " + ctx._todoMsg : "")); return true; }
    passed++;
    log(indent(depth) + "ok " + num + " - " + entry.name);
    return true;
  } catch (err) {
    failed++;
    log(indent(depth) + "not ok " + num + " - " + entry.name);
    log(indent(depth) + "  ---");
    var msg = (err && err.message ? err.message : String(err));
    log(indent(depth) + "  error: " + msg.replace(/\n/g, "\n" + indent(depth) + "    "));
    if (err && err.stack) log(indent(depth) + "  stack: " + String(err.stack).split("\n").slice(1, 4).join(" | "));
    log(indent(depth) + "  ...");
    return false;
  }
}

async function runSuite(suite, depth) {
  log(indent(depth) + "# Subtest: " + suite.name);
  if (suite.options && (suite.options.skip || suite.options.todo)) {
    counter++;
    log(indent(depth) + "ok " + counter + " - " + suite.name + (suite.options.skip ? " # SKIP" : " # TODO"));
    return;
  }
  try {
    await callHooks(suite.hooks, "before");
    for (var i = 0; i < suite.children.length; i++) {
      var child = suite.children[i];
      await callHooks(suite.hooks, "beforeEach", child.name);
      if (child.kind === "suite") await runSuite(child, depth + 1);
      else await runTest(child, depth + 1);
      await callHooks(suite.hooks, "afterEach", child.name);
    }
    await callHooks(suite.hooks, "after");
  } catch (err) {
    failed++;
    log(indent(depth) + "not ok - " + suite.name + " (hook failed: " + (err && err.message || err) + ")");
  }
}

function scheduleFlush() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(flush);
}

var flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  // Allow synchronous registration (top-level test() calls) to settle first.
  await Promise.resolve();
  log("TAP version 13");
  try {
    await callHooks(rootHooks, "before");
    for (var i = 0; i < rootEntries.length; i++) {
      var entry = rootEntries[i];
      await callHooks(rootHooks, "beforeEach", entry.name);
      if (entry.kind === "suite") await runSuite(entry, 0);
      else await runTest(entry, 0);
      await callHooks(rootHooks, "afterEach", entry.name);
    }
    await callHooks(rootHooks, "after");
  } catch (err) {
    failed++;
    log("# root hook failed: " + (err && err.message || err));
  }
  var total = passed + failed + skipped + todoCount;
  log("1.." + counter);
  log("# tests " + total);
  log("# pass " + passed);
  log("# fail " + failed);
  if (skipped) log("# skipped " + skipped);
  if (todoCount) log("# todo " + todoCount);
  if (failed > 0 && globalThis.process) process.exitCode = 1;
}

// --- mock surface (minimal) ------------------------------------------------
var mock = {
  fn: function (original, impl) {
    var implementation = impl || original || function () {};
    var calls = [];
    var f = function () {
      var args = Array.prototype.slice.call(arguments);
      var result;
      try { result = implementation.apply(this, args); }
      catch (e) { calls.push({ arguments: args, error: e, result: undefined, target: this }); throw e; }
      calls.push({ arguments: args, result: result, target: this, error: undefined });
      return result;
    };
    f.mock = {
      calls: calls,
      callCount: function () { return calls.length; },
      resetCalls: function () { calls.length = 0; },
      restore: function () {},
      mockImplementation: function (newImpl) { implementation = newImpl; },
      mockImplementationOnce: function (newImpl) { var once = implementation; implementation = function () { var r = newImpl.apply(this, arguments); implementation = once; return r; }; },
    };
    return f;
  },
  method: function (obj, methodName, impl) {
    var original = obj[methodName];
    var mocked = mock.fn(original, impl || original);
    mocked.mock.restore = function () { obj[methodName] = original; };
    obj[methodName] = mocked;
    return mocked;
  },
  reset: function () {},
  restoreAll: function () {},
  timers: { enable: function () {}, reset: function () {}, tick: function () {} },
};

// --- public surface --------------------------------------------------------
function test(name, options, fn) { return registerTest(name, options, fn); }
test.test = test;
test.it = test;
test.describe = function (name, options, fn) { return registerSuite(name, options, fn); };
test.suite = test.describe;
test.before = function (fn) { addHook("before", fn); };
test.after = function (fn) { addHook("after", fn); };
test.beforeEach = function (fn) { addHook("beforeEach", fn); };
test.afterEach = function (fn) { addHook("afterEach", fn); };
test.skip = function (name, options, fn) { var a = normalizeArgs(name, options, fn); a.options.skip = true; return registerTest(a.name, a.options, a.fn); };
test.todo = function (name, options, fn) { var a = normalizeArgs(name, options, fn); a.options.todo = true; return registerTest(a.name, a.options, a.fn); };
test.only = function (name, options, fn) { return registerTest(name, options, fn); };
test.mock = mock;
test.run = function () { scheduleFlush(); return Promise.resolve(); };

module.exports = test;
module.exports.test = test;
module.exports.it = test;
module.exports.describe = test.describe;
module.exports.suite = test.suite;
module.exports.before = test.before;
module.exports.after = test.after;
module.exports.beforeEach = test.beforeEach;
module.exports.afterEach = test.afterEach;
module.exports.mock = mock;
module.exports.default = test;

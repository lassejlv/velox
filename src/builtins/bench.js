// velox's built-in benchmark runner — the `velox bench` framework.
//
// `bench`, `describe`/`group`, and the before*/after* hooks are installed as
// globals by register() (no import needed). Each bench is warmed up, then run
// in adaptively-sized batches for a time budget; the runner reports ops/sec and
// mean/min/p99 timings, plus a per-group "fastest" summary.

var C = (function () {
  var on = globalThis.process && globalThis.process.stdout && globalThis.process.stdout.isTTY !== false;
  function w(code) { return function (s) { return on ? '\x1b[' + code + 'm' + s + '\x1b[0m' : s; }; }
  return { green: w(32), red: w(31), yellow: w(33), dim: w(2), bold: w(1), cyan: w(36), magenta: w(35) };
})();

function now() { return performance.now(); }

// A group of benches (top level is the implicit root group).
function makeGroup(name) {
  return { name: name, benches: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
}
var rootGroup = makeGroup(null);
var current = rootGroup;
var hasOnly = false;
var failures = [];
var allResults = []; // flat list across groups, for the JSON reporter

function describe(name, fn) {
  var parent = current;
  var g = makeGroup(name);
  g.parent = parent;
  current = g;
  try { fn(); } finally { current = parent; }
  // Flatten: a described group runs as its own section.
  parent.benches.push({ group: g });
}

function bench(name, fn, opts) {
  if (typeof fn !== 'function') throw new TypeError('bench("' + name + '", fn): fn must be a function');
  current.benches.push({ name: name, fn: fn, opts: opts || {} });
}
bench.only = function (name, fn, opts) { hasOnly = true; var o = Object.assign({ only: true }, opts || {}); bench(name, fn, o); };
bench.skip = function (name, fn, opts) { var o = Object.assign({ skip: true }, opts || {}); bench(name, fn, o); };

function beforeAll(fn) { current.beforeAll.push(fn); }
function afterAll(fn) { current.afterAll.push(fn); }
function beforeEach(fn) { current.beforeEach.push(fn); }
function afterEach(fn) { current.afterEach.push(fn); }

async function runHooks(list) { for (var i = 0; i < list.length; i++) await list[i](); }

// Detect whether `fn` is async (returns a thenable) by probing once.
async function isAsyncFn(fn) {
  try {
    var r = fn();
    if (r && typeof r.then === 'function') { await r; return true; }
  } catch (e) { /* surfaced again during the real run */ }
  return false;
}

// Warm up, calibrate a batch size, then collect per-iteration timings (ms).
async function measure(fn, isAsync, opts) {
  var budget = opts.time != null ? opts.time : 500;     // measured-window ms
  var warmup = opts.warmup != null ? opts.warmup : 100; // warmup ms

  var wEnd = now() + warmup;
  while (now() < wEnd) { if (isAsync) await fn(); else fn(); }

  // Grow the batch until one batch takes >= 1ms (cuts timer-resolution noise).
  var batch = 1;
  while (batch < 1e7) {
    var t0 = now();
    for (var i = 0; i < batch; i++) { if (isAsync) await fn(); else fn(); }
    if (now() - t0 >= 1) break;
    batch *= 2;
  }

  var samples = [];
  var end = now() + budget;
  do {
    var s0 = now();
    for (var j = 0; j < batch; j++) { if (isAsync) await fn(); else fn(); }
    samples.push((now() - s0) / batch);
  } while (now() < end && samples.length < 4096);

  samples.sort(function (a, b) { return a - b; });
  var n = samples.length;
  var sum = 0;
  for (var k = 0; k < n; k++) sum += samples[k];
  var mean = sum / n;
  var varc = 0;
  for (var m = 0; m < n; m++) { var d = samples[m] - mean; varc += d * d; }
  function q(p) { return samples[Math.min(n - 1, Math.floor(p * n))]; }
  return {
    mean: mean, min: samples[0], max: samples[n - 1],
    p75: q(0.75), p99: q(0.99), sd: Math.sqrt(varc / n),
    ops: mean > 0 ? 1000 / mean : Infinity,
    samples: n, iters: n * batch,
  };
}

// --- formatting -------------------------------------------------------------

function fmtTime(ms) {
  if (ms >= 1) return ms.toFixed(2) + ' ms';
  if (ms >= 1e-3) return (ms * 1e3).toFixed(2) + ' µs';
  return (ms * 1e6).toFixed(2) + ' ns';
}
function fmtOps(ops) {
  if (!isFinite(ops)) return '∞';
  return Math.round(ops).toLocaleString('en-US');
}
function padStart(s, w) { s = '' + s; while (s.length < w) s = ' ' + s; return s; }
function padEnd(s, w) { s = '' + s; while (s.length < w) s += ' '; return s; }

// Run every bench in a group, printing a table, then a "fastest" summary.
async function runGroup(g, depth, prefix) {
  await runHooks(g.beforeAll);

  var indent = '  '.repeat(depth + 1);
  if (g.name) console.log('\n' + indent + C.bold(g.name));
  var groupPath = g.name ? (prefix ? prefix + ' › ' + g.name : g.name) : prefix;

  var results = [];
  for (var i = 0; i < g.benches.length; i++) {
    var entry = g.benches[i];
    if (entry.group) { await runGroup(entry.group, depth + 1, groupPath); continue; }
    if (entry.opts.skip || (hasOnly && !entry.opts.only)) {
      console.log(indent + '  ' + C.yellow('- ' + entry.name) + C.dim(' (skipped)'));
      continue;
    }
    try {
      await runHooks(g.beforeEach);
      var isAsync = await isAsyncFn(entry.fn);
      var stat = await measure(entry.fn, isAsync, entry.opts);
      await runHooks(g.afterEach);
      results.push({ name: entry.name, stat: stat });
      allResults.push({
        name: groupPath ? groupPath + ' › ' + entry.name : entry.name,
        opsPerSec: stat.ops, meanMs: stat.mean, minMs: stat.min,
        maxMs: stat.max, p99Ms: stat.p99, samples: stat.samples,
      });
    } catch (e) {
      failures.push({ name: entry.name, err: e });
      console.log(indent + '  ' + C.red('✖ ' + entry.name) + C.dim(' — ' + (e && e.message || e)));
    }
  }

  if (results.length) {
    var nameW = 4;
    results.forEach(function (r) { if (r.name.length > nameW) nameW = r.name.length; });
    results.forEach(function (r) {
      var s = r.stat;
      console.log(
        indent + '  ' + padEnd(r.name, nameW) + '  ' +
        C.cyan(padStart(fmtOps(s.ops), 14)) + C.dim(' ops/s') + '  ' +
        C.dim('mean ') + padStart(fmtTime(s.mean), 9) + '  ' +
        C.dim('min ') + padStart(fmtTime(s.min), 9) + '  ' +
        C.dim('p99 ') + padStart(fmtTime(s.p99), 9)
      );
    });
    if (results.length > 1) {
      var fastest = results.reduce(function (a, b) { return b.stat.ops > a.stat.ops ? b : a; });
      var slowest = results.reduce(function (a, b) { return b.stat.ops < a.stat.ops ? b : a; });
      var ratio = slowest.stat.mean / fastest.stat.mean;
      console.log(indent + '  ' + C.dim('summary: ') + C.green(fastest.name) +
        C.dim(' is ') + C.bold(ratio.toFixed(2) + '×') + C.dim(' faster than ') + slowest.name);
    }
  }

  await runHooks(g.afterAll);
}

function register() {
  var g = globalThis;
  g.bench = bench;
  g.describe = describe;
  g.group = describe;
  g.beforeAll = beforeAll;
  g.afterAll = afterAll;
  g.beforeEach = beforeEach;
  g.afterEach = afterEach;
}

// Write a machine-readable JSON report when `velox bench --reporter=json[=PATH]`
// is set (default bench-results.json). The pretty terminal output is unaffected.
function writeJsonReport(durationMs) {
  var reporter = globalThis.__VELOX_BENCH_REPORTER;
  if (!reporter || reporter.indexOf('json') !== 0) return;
  var file = reporter.indexOf('=') >= 0 ? reporter.slice(reporter.indexOf('=') + 1) : 'bench-results.json';
  var report = { durationMs: durationMs, benchmarks: allResults };
  try {
    var fs = require('node:fs'), path = require('node:path');
    var dir = path.dirname(file);
    if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
    console.log(C.dim(' results written to ' + file));
  } catch (e) {
    console.log(C.red('could not write JSON report: ' + (e && e.message || e)));
  }
}

async function run() {
  var start = now();
  console.log(C.bold('Benchmarks:'));
  try {
    await runGroup(rootGroup, 0, '');
  } catch (e) {
    console.log(C.red('fatal error while running benchmarks: ' + (e && e.stack || e)));
    failures.push({ name: '(fatal)', err: e });
  }
  var ms = now() - start;
  console.log('\n' + C.bold('Done') + C.dim(' in ' + ms.toFixed(0) + 'ms'));
  writeJsonReport(ms);
  if (failures.length && g_process()) g_process().exitCode = 1;
  return failures.length === 0;
}

function g_process() { return globalThis.process; }

module.exports = {
  register: register, run: run, bench: bench, describe: describe, group: describe,
  beforeAll: beforeAll, afterAll: afterAll, beforeEach: beforeEach, afterEach: afterEach,
};
module.exports.default = module.exports;

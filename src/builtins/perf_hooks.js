// node:perf_hooks — thin re-export of the global `performance` plus pragmatic
// stubs for the observer/mark/measure surface most libraries probe for.

var performance = globalThis.performance;

// PerformanceObserver — minimal: records entries created via mark()/measure()
// and delivers them to observe() callbacks. Good enough for libraries that only
// need the API to exist and fire for their own marks.
var observers = [];
function PerformanceObserver(callback) {
  this._callback = callback;
  this._entryTypes = null;
}
PerformanceObserver.prototype.observe = function (options) {
  this._entryTypes = (options && (options.entryTypes || (options.type ? [options.type] : null))) || null;
  if (observers.indexOf(this) === -1) observers.push(this);
};
PerformanceObserver.prototype.disconnect = function () {
  var i = observers.indexOf(this);
  if (i !== -1) observers.splice(i, 1);
};
PerformanceObserver.prototype.takeRecords = function () { return []; };
PerformanceObserver.supportedEntryTypes = ['mark', 'measure'];

function deliver(entry) {
  var list = { getEntries: function () { return [entry]; }, getEntriesByName: function (n) { return entry.name === n ? [entry] : []; }, getEntriesByType: function (t) { return entry.entryType === t ? [entry] : []; } };
  observers.forEach(function (obs) {
    if (!obs._entryTypes || obs._entryTypes.indexOf(entry.entryType) !== -1) {
      queueMicrotask(function () { obs._callback(list, obs); });
    }
  });
}

// Install the real mark()/measure() on the global performance. The web_globals
// prelude only provides no-op stubs (it has no observer machinery), so requiring
// node:perf_hooks upgrades them to entries-buffered versions that notify
// PerformanceObserver — this is the module libraries pull in for that to work.
if (performance) {
  var marks = {};
  var entries = [];
  performance.mark = function (name, options) {
    var entry = { name: String(name), entryType: 'mark', startTime: performance.now(), duration: 0, detail: options && options.detail };
    marks[entry.name] = entry;
    entries.push(entry);
    deliver(entry);
    return entry;
  };
  performance.measure = function (name, startOrOptions, endMark) {
    var start = 0, end = performance.now();
    if (startOrOptions && typeof startOrOptions === 'object') {
      // measure(name, { start, end, duration, detail })
      var o = startOrOptions;
      if (typeof o.start === 'string' && marks[o.start]) start = marks[o.start].startTime;
      else if (typeof o.start === 'number') start = o.start;
      if (typeof o.end === 'string' && marks[o.end]) end = marks[o.end].startTime;
      else if (typeof o.end === 'number') end = o.end;
      else if (typeof o.duration === 'number') end = start + o.duration;
      var mentry = { name: String(name), entryType: 'measure', startTime: start, duration: end - start, detail: o.detail };
      entries.push(mentry);
      deliver(mentry);
      return mentry;
    }
    if (typeof startOrOptions === 'string' && marks[startOrOptions]) start = marks[startOrOptions].startTime;
    if (typeof endMark === 'string' && marks[endMark]) end = marks[endMark].startTime;
    var entry = { name: String(name), entryType: 'measure', startTime: start, duration: end - start };
    entries.push(entry);
    deliver(entry);
    return entry;
  };
  performance.clearMarks = function (name) {
    if (name) { delete marks[name]; entries = entries.filter(function (e) { return !(e.entryType === 'mark' && e.name === name); }); }
    else { marks = {}; entries = entries.filter(function (e) { return e.entryType !== 'mark'; }); }
  };
  performance.clearMeasures = function (name) {
    entries = entries.filter(function (e) { return e.entryType !== 'measure' || (name && e.name !== name); });
  };
  performance.getEntries = function () { return entries.slice(); };
  performance.getEntriesByName = function (n, type) { return entries.filter(function (e) { return e.name === n && (!type || e.entryType === type); }); };
  performance.getEntriesByType = function (t) { return entries.filter(function (e) { return e.entryType === t; }); };
}

// performance.timeOrigin — fall back if the global lacks it.
if (performance && typeof performance.timeOrigin !== 'number') {
  try { Object.defineProperty(performance, 'timeOrigin', { value: Date.now() - performance.now(), configurable: true }); } catch (e) {}
}

// performance.eventLoopUtilization() — Node reports idle/active loop time; velox
// doesn't track it, so return a zeroed reading (its diff form subtracts two).
// (@hapi/heavy and other load monitors call this at startup.)
if (performance && typeof performance.eventLoopUtilization !== 'function') {
  performance.eventLoopUtilization = function () {
    return { idle: 0, active: 0, utilization: 0 };
  };
}

// monitorEventLoopDelay — stub histogram (the loop is single-threaded; delay ~0).
function monitorEventLoopDelay() {
  return {
    enable: function () {}, disable: function () {}, reset: function () {},
    min: 0, max: 0, mean: 0, stddev: 0, percentile: function () { return 0; },
    get exceeds() { return 0; },
  };
}

// createHistogram — a RecordableHistogram that stores samples and computes
// min/max/mean/stddev/percentile on demand (good enough for the metrics most
// libraries collect; not the HdrHistogram velox lacks a native for).
function createHistogram() {
  var samples = [];
  var lastDelta = null;
  function pct(p) {
    if (!samples.length) return 0;
    var sorted = samples.slice().sort(function (a, b) { return a - b; });
    var idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
  }
  var h = {
    record: function (v) { samples.push(Number(v)); },
    recordDelta: function () {
      var now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) * 1e6; // ns
      if (lastDelta != null) samples.push(now - lastDelta);
      lastDelta = now;
    },
    reset: function () { samples = []; lastDelta = null; },
    percentile: pct,
    get count() { return samples.length; },
    get min() { return samples.length ? Math.min.apply(Math, samples) : 0; },
    get max() { return samples.length ? Math.max.apply(Math, samples) : 0; },
    get mean() { return samples.length ? samples.reduce(function (a, b) { return a + b; }, 0) / samples.length : 0; },
    get stddev() {
      if (!samples.length) return 0;
      var m = h.mean, v = samples.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / samples.length;
      return Math.sqrt(v);
    },
    get exceeds() { return 0; },
    get percentiles() {
      var map = new Map();
      [50, 75, 90, 97.5, 99, 99.9].forEach(function (p) { map.set(p, pct(p)); });
      return map;
    },
  };
  return h;
}

module.exports = {
  performance: performance,
  PerformanceObserver: PerformanceObserver,
  PerformanceEntry: function () {},
  monitorEventLoopDelay: monitorEventLoopDelay,
  createHistogram: createHistogram,
  constants: {},
};
module.exports.default = module.exports;

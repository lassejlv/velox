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

// Augment the global performance with mark()/measure() if absent.
if (performance && typeof performance.mark !== 'function') {
  var marks = {};
  performance.mark = function (name, options) {
    var entry = { name: String(name), entryType: 'mark', startTime: performance.now(), duration: 0, detail: options && options.detail };
    marks[entry.name] = entry;
    deliver(entry);
    return entry;
  };
  performance.measure = function (name, startOrOptions, endMark) {
    var start = 0, end = performance.now();
    if (typeof startOrOptions === 'string' && marks[startOrOptions]) start = marks[startOrOptions].startTime;
    if (typeof endMark === 'string' && marks[endMark]) end = marks[endMark].startTime;
    var entry = { name: String(name), entryType: 'measure', startTime: start, duration: end - start };
    deliver(entry);
    return entry;
  };
  performance.clearMarks = function (name) { if (name) delete marks[name]; else marks = {}; };
  performance.clearMeasures = function () {};
  performance.getEntriesByName = function () { return []; };
  performance.getEntriesByType = function () { return []; };
  performance.getEntries = function () { return []; };
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

module.exports = {
  performance: performance,
  PerformanceObserver: PerformanceObserver,
  PerformanceEntry: function () {},
  monitorEventLoopDelay: monitorEventLoopDelay,
  constants: {},
};
module.exports.default = module.exports;

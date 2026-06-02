// node:cluster — velox runs a single process, so there is no real multi-process
// clustering. Expose the surface as a *primary-only* stub: `isPrimary`/`isMaster`
// are true and `isWorker` is false, and the EventEmitter API exists, so packages
// that `require('cluster')` at load and branch on those flags
// (rate-limiter-flexible, many server frameworks) work in single-process mode.
// `fork()` has no process model to back it, so it throws a clear error rather
// than pretend — code guarded by `if (cluster.isPrimary)` that only forks in a
// real cluster simply never calls it here.

var EventEmitter = require('node:events');

function Cluster() {
  EventEmitter.call(this);
  this.isMaster = true;
  this.isPrimary = true;
  this.isWorker = false;
  this.worker = undefined;
  this.workers = {};
  this.settings = {};
  this.SCHED_NONE = 1;
  this.SCHED_RR = 2;
  this.schedulingPolicy = this.SCHED_RR;
}
Cluster.prototype = Object.create(EventEmitter.prototype);
Cluster.prototype.constructor = Cluster;

Cluster.prototype.setupPrimary = function (settings) {
  if (settings) Object.assign(this.settings, settings);
};
Cluster.prototype.setupMaster = Cluster.prototype.setupPrimary;

Cluster.prototype.fork = function () {
  throw new Error(
    'cluster.fork() is not supported in velox (single-process runtime; ' +
      'use worker_threads for parallelism)'
  );
};

Cluster.prototype.disconnect = function (cb) {
  if (typeof cb === 'function') queueMicrotask(cb);
};

module.exports = new Cluster();
module.exports.default = module.exports;

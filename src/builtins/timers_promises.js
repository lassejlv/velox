// node:timers/promises — Promise-based timer helpers.
//
// Built on the global setTimeout/clearTimeout/setInterval/clearInterval and,
// optionally, AbortSignal (which exists as a runtime global). The `ref` option
// is accepted but ignored (this runtime has no unref concept for timers here).

// Construct an AbortError consistent with Node's shape.
function abortError(signal) {
  // Prefer the reason carried by the signal, if any.
  if (signal && signal.reason !== undefined) {
    return signal.reason;
  }
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  err.code = 'ABORT_ERR';
  return err;
}

// True if `opts.signal` is an already-aborted AbortSignal.
function alreadyAborted(opts) {
  return !!(opts && opts.signal && opts.signal.aborted);
}

// ---------------------------------------------------------------------------
// setTimeout(delay, value, opts) -> Promise<value>
// ---------------------------------------------------------------------------

function setTimeoutPromise(delay, value, opts) {
  delay = delay === undefined ? 0 : delay;
  return new Promise((resolve, reject) => {
    if (alreadyAborted(opts)) {
      reject(abortError(opts.signal));
      return;
    }

    let onAbort;
    const handle = setTimeout(() => {
      if (onAbort && opts && opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
      resolve(value);
    }, delay);

    if (opts && opts.signal) {
      onAbort = () => {
        clearTimeout(handle);
        reject(abortError(opts.signal));
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// setImmediate(value, opts) -> Promise<value>
//
// Resolved on the next tick. We use a 0ms timer (queueMicrotask would run
// before the timer/IO phase, but a 0ms macrotask matches setImmediate timing
// more faithfully on this loop).
// ---------------------------------------------------------------------------

function setImmediatePromise(value, opts) {
  return new Promise((resolve, reject) => {
    if (alreadyAborted(opts)) {
      reject(abortError(opts.signal));
      return;
    }

    let onAbort;
    const handle = setTimeout(() => {
      if (onAbort && opts && opts.signal) {
        opts.signal.removeEventListener('abort', onAbort);
      }
      resolve(value);
    }, 0);

    if (opts && opts.signal) {
      onAbort = () => {
        clearTimeout(handle);
        reject(abortError(opts.signal));
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

// ---------------------------------------------------------------------------
// setInterval(delay, value, opts) -> AsyncIterable yielding `value`
//
// Usable with `for await`. The iterator buffers ticks that fire faster than the
// consumer drains them, and stops cleanly when `opts.signal` aborts or when the
// consumer calls `.return()` (e.g. `break` out of a for-await loop).
// ---------------------------------------------------------------------------

function setIntervalPromise(delay, value, opts) {
  delay = delay === undefined ? 0 : delay;
  const signal = opts && opts.signal;

  return {
    [Symbol.asyncIterator]() {
      // Pending ticks not yet consumed.
      const ticks = [];
      // A waiting consumer's resolve/reject, when ticks is empty.
      let pendingResolve = null;
      let pendingReject = null;
      let done = false;
      let handle = null;
      let onAbort = null;

      const cleanup = () => {
        if (handle !== null) {
          clearInterval(handle);
          handle = null;
        }
        if (onAbort && signal) {
          signal.removeEventListener('abort', onAbort);
          onAbort = null;
        }
      };

      const start = () => {
        handle = setInterval(() => {
          if (pendingResolve) {
            const r = pendingResolve;
            pendingResolve = pendingReject = null;
            r({ value, done: false });
          } else {
            ticks.push(value);
          }
        }, delay);

        if (signal) {
          onAbort = () => {
            done = true;
            cleanup();
            if (pendingReject) {
              const rej = pendingReject;
              pendingResolve = pendingReject = null;
              rej(abortError(signal));
            }
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      };

      // Honour an already-aborted signal before scheduling anything.
      if (signal && signal.aborted) {
        done = true;
      } else {
        start();
      }

      return {
        next() {
          if (signal && signal.aborted && ticks.length === 0) {
            done = true;
            cleanup();
            return Promise.reject(abortError(signal));
          }
          if (done && ticks.length === 0) {
            return Promise.resolve({ value: undefined, done: true });
          }
          if (ticks.length > 0) {
            return Promise.resolve({ value: ticks.shift(), done: false });
          }
          return new Promise((resolve, reject) => {
            pendingResolve = resolve;
            pendingReject = reject;
          });
        },
        return(v) {
          done = true;
          cleanup();
          if (pendingResolve) {
            const r = pendingResolve;
            pendingResolve = pendingReject = null;
            r({ value: undefined, done: true });
          }
          return Promise.resolve({ value: v, done: true });
        },
        throw(err) {
          done = true;
          cleanup();
          return Promise.reject(err);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// scheduler (Node 17+ experimental)
//
// scheduler.wait(ms, opts) -> Promise that resolves after `ms` ms; honours
// opts.signal for abort. Equivalent to setTimeout(ms, undefined, opts).
// scheduler.yield() -> Promise that resolves on the next turn (setImmediate).
// ---------------------------------------------------------------------------

const scheduler = {
  wait(ms, opts) {
    return setTimeoutPromise(ms, undefined, opts);
  },
};
scheduler['yield'] = function () {
  return setImmediatePromise(undefined);
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  setTimeout: setTimeoutPromise,
  setImmediate: setImmediatePromise,
  setInterval: setIntervalPromise,
  scheduler: scheduler,
};
module.exports.default = module.exports;

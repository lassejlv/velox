// node:domain — the (deprecated but still shipped) error-scoping API. Old
// packages require it, and Node's test suite exercises it heavily.
//
// Semantics implemented:
//   - create()/createDomain() → Domain (an EventEmitter)
//   - run/enter/exit with a proper domain stack (exit pops nested domains too)
//   - add/remove member emitters; an unhandled 'error' on a member routes to
//     its domain instead of throwing (hooked via EventEmitter._getDomain /
//     the domain-aware error path in events.js)
//   - EventEmitters constructed while a domain is active adopt it (Node does
//     this in the EE constructor; events.js calls our hook)
//   - bind/intercept callback wrappers
//   - timers/process.nextTick callbacks scheduled under a domain run inside it,
//     with thrown errors routed to the domain (patched on first require, like
//     Node only activates domains once the module loads)
//   - process.domain mirrors the active domain

const EventEmitter = require('node:events');

const stack = [];
exports._stack = stack;
exports.active = null;

function updateState() {
  exports.active = stack.length ? stack[stack.length - 1] : null;
  try {
    process.domain = exports.active;
  } catch (e) {}
}

function Domain() {
  EventEmitter.call(this);
  this.members = [];
}
Object.setPrototypeOf(Domain.prototype, EventEmitter.prototype);
Object.setPrototypeOf(Domain, EventEmitter);

Domain.prototype.enter = function enter() {
  stack.push(this);
  updateState();
};

Domain.prototype.exit = function exit() {
  const idx = stack.lastIndexOf(this);
  if (idx === -1) return;
  // Exiting a domain also exits any domains nested inside it.
  stack.splice(idx);
  updateState();
};

Domain.prototype._handleError = function _handleError(er) {
  if (er instanceof Error) {
    tagErrorDomain(er, this);
    er.domainThrown = true;
  }
  this.emit('error', er);
};

// `error.domain` is non-enumerable in Node (it must not leak into JSON or
// deepEqual comparisons of the error).
function tagErrorDomain(er, d) {
  try {
    Object.defineProperty(er, 'domain', {
      value: d, writable: true, enumerable: false, configurable: true,
    });
  } catch (e) {
    er.domain = d;
  }
}

Domain.prototype.run = function run(fn) {
  const args = Array.prototype.slice.call(arguments, 1);
  this.enter();
  try {
    return fn.apply(this, args);
  } catch (er) {
    this._handleError(er);
  } finally {
    this.exit();
  }
};

Domain.prototype.add = function add(ee) {
  if (ee.domain === this) return;
  if (ee.domain && typeof ee.domain.remove === 'function') ee.domain.remove(ee);
  setDomainProp(ee, this);
  this.members.push(ee);
};

// `emitter.domain` is non-enumerable in Node (it must not show up in
// Object.keys/JSON of user objects).
function setDomainProp(ee, value) {
  try {
    Object.defineProperty(ee, 'domain', {
      value: value, writable: true, enumerable: false, configurable: true,
    });
  } catch (e) {
    ee.domain = value;
  }
}

Domain.prototype.remove = function remove(ee) {
  setDomainProp(ee, null);
  const i = this.members.indexOf(ee);
  if (i !== -1) this.members.splice(i, 1);
};

Domain.prototype.bind = function bind(cb) {
  const self = this;
  function runBound() {
    self.enter();
    try {
      return cb.apply(this, arguments);
    } catch (er) {
      self._handleError(er);
    } finally {
      self.exit();
    }
  }
  runBound.domain = self;
  return runBound;
};

Domain.prototype.intercept = function intercept(cb) {
  const self = this;
  function runIntercepted(er) {
    if (er) {
      // A callback-style error is "bound", not "thrown" (Node tags it so).
      if (er instanceof Error) {
        tagErrorDomain(er, self);
        er.domainBound = cb;
        er.domainThrown = false;
      }
      self.emit('error', er);
      return;
    }
    const args = Array.prototype.slice.call(arguments, 1);
    self.enter();
    try {
      return cb.apply(this, args);
    } catch (er2) {
      self._handleError(er2);
    } finally {
      self.exit();
    }
  }
  runIntercepted.domain = self;
  return runIntercepted;
};

function create() {
  return new Domain();
}

// --- activate the runtime hooks (once, on first require) --------------------
(function activateDomains() {
  if (EventEmitter._getDomain) return;

  // events.js consults this in the EE constructor (adopt the active domain)
  // and in the unhandled-'error' path (route to `emitter.domain`).
  EventEmitter._getDomain = function () {
    return exports.active;
  };

  // Wrap a callback so it runs inside the domain active at schedule time.
  function wrap(cb) {
    if (typeof cb !== 'function') return cb;
    const d = exports.active;
    if (!d) return cb;
    return d.bind(cb);
  }
  const g = globalThis;
  ['setTimeout', 'setInterval', 'setImmediate'].forEach(function (name) {
    const orig = g[name];
    if (typeof orig !== 'function') return;
    const patched = function (cb) {
      const args = Array.prototype.slice.call(arguments);
      args[0] = wrap(cb);
      return orig.apply(this, args);
    };
    try {
      Object.defineProperty(g, name, {
        value: patched, writable: true, enumerable: false, configurable: true,
      });
    } catch (e) {
      g[name] = patched;
    }
  });
  if (g.process && typeof g.process.nextTick === 'function') {
    const tick = g.process.nextTick;
    g.process.nextTick = function (cb) {
      const args = Array.prototype.slice.call(arguments);
      args[0] = wrap(cb);
      return tick.apply(this, args);
    };
  }
})();

module.exports = {
  Domain,
  create,
  createDomain: create,
  _stack: stack,
};
Object.defineProperty(module.exports, 'active', {
  enumerable: true,
  get: function () {
    return exports.active;
  },
});
module.exports.default = module.exports;

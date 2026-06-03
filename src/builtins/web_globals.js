// web_globals.js — velox prelude installing common Web/Node global APIs that
// bare JavaScriptCore lacks. This is a plain-script IIFE (NOT a module): it runs
// at startup and installs each global via `globalThis.X = ...`, but only when the
// global is not already defined. Anything JSC already provides is left untouched.
//
// Available in the host environment: Promise, setTimeout/clearTimeout/
// setInterval/clearInterval, Symbol, Map/Set/WeakMap, typed arrays, JSON, Math,
// Date, and Buffer (installed by an earlier prelude). Everything else below is
// hand-rolled.
(function () {
  "use strict";

  var g = globalThis;

  // ---------------------------------------------------------------------------
  // Symbol.dispose / Symbol.asyncDispose — the explicit-resource-management
  // well-known symbols (TC39 `using`/`await using`). Some JSC builds lack them;
  // oxc lowers `using` to `[Symbol.dispose]()` calls, so they must exist.
  // ---------------------------------------------------------------------------
  if (!Symbol.dispose) {
    try { Object.defineProperty(Symbol, "dispose", { value: Symbol("Symbol.dispose"), configurable: false, writable: false }); } catch (e) {}
  }
  if (!Symbol.asyncDispose) {
    try { Object.defineProperty(Symbol, "asyncDispose", { value: Symbol("Symbol.asyncDispose"), configurable: false, writable: false }); } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Timeout/Timer handles — wrap the native numeric setTimeout/setInterval so
  // they return a Node-style object with .ref()/.unref()/.hasRef()/.refresh(),
  // while clearTimeout/clearInterval still accept either the handle or a raw id.
  // ---------------------------------------------------------------------------
  (function () {
    var nativeSetTimeout = g.setTimeout;
    var nativeSetInterval = g.setInterval;
    var nativeClearTimeout = g.clearTimeout;
    var nativeClearInterval = g.clearInterval;
    if (typeof nativeSetTimeout !== "function" || nativeSetTimeout.__veloxWrapped) return;

    function Timeout(id, rearm) {
      this._id = id;
      this._rearm = rearm; // () -> newId, for refresh(); null for intervals
      this._hasRef = true;
    }
    Timeout.prototype.ref = function () {
      this._hasRef = true;
      if (g.__velox_timer_unref) g.__velox_timer_unref(this._id, false);
      return this;
    };
    Timeout.prototype.unref = function () {
      this._hasRef = false;
      if (g.__velox_timer_unref) g.__velox_timer_unref(this._id, true);
      return this;
    };
    Timeout.prototype.hasRef = function () { return this._hasRef; };
    Timeout.prototype.refresh = function () {
      if (this._rearm) {
        nativeClearTimeout(this._id);
        this._id = this._rearm();
        if (!this._hasRef && g.__velox_timer_unref) g.__velox_timer_unref(this._id, true);
      }
      return this;
    };
    Timeout.prototype.close = function () { nativeClearTimeout(this._id); };
    Timeout.prototype[Symbol.toPrimitive] = function () { return this._id; };
    Timeout.prototype.valueOf = function () { return this._id; };

    function idOf(h) { return (h && typeof h === "object" && "_id" in h) ? h._id : h; }

    g.setTimeout = function setTimeout(cb) {
      var args = Array.prototype.slice.call(arguments);
      var id = nativeSetTimeout.apply(null, args);
      return new Timeout(id, function () { return nativeSetTimeout.apply(null, args); });
    };
    g.setTimeout.__veloxWrapped = true;
    g.setInterval = function setInterval(cb) {
      var args = Array.prototype.slice.call(arguments);
      return new Timeout(nativeSetInterval.apply(null, args), null);
    };
    g.clearTimeout = function clearTimeout(h) { return nativeClearTimeout(idOf(h)); };
    g.clearInterval = function clearInterval(h) { return nativeClearInterval(idOf(h)); };
    g.__veloxTimeout = Timeout;
  })();

  // ---------------------------------------------------------------------------
  // SharedArrayBuffer — JSC ships `Atomics` but not `SharedArrayBuffer` (it's
  // disabled by default). Provide it as an `ArrayBuffer` subclass so code that
  // allocates one and runs `Atomics` over a view works single-threaded. (True
  // cross-thread *sharing* isn't possible: velox workers are separate JSC
  // context groups, and JSC's C API exposes no shareable backing store.)
  // ---------------------------------------------------------------------------
  if (typeof g.SharedArrayBuffer === "undefined") {
    var hasShared = typeof g.__velox_shared_alloc === "function";
    function adopt(buf, id) {
      Object.setPrototypeOf(buf, SAB.prototype); // keep the real [[ArrayBufferData]] slot
      if (id !== undefined) Object.defineProperty(buf, "__velox_shared_id", { value: id, enumerable: false, configurable: true });
      return buf;
    }
    var SAB = function SharedArrayBuffer(length) {
      length = length >>> 0;
      if (hasShared) {
        // Back the bytes with a process-global region so workers can map the
        // same memory (real cross-thread sharing, see src/shared.rs).
        var id = __velox_shared_alloc(length);
        return adopt(__velox_shared_buffer(id), id);
      }
      return adopt(new ArrayBuffer(length));
    };
    SAB.prototype = Object.create(ArrayBuffer.prototype);
    SAB.prototype.constructor = SAB;
    Object.defineProperty(SAB.prototype, Symbol.toStringTag, { value: "SharedArrayBuffer", configurable: true });
    Object.defineProperty(SAB.prototype, "growable", { get: function () { return false; }, configurable: true });
    // `byteLength` getter — webidl-conversions (whatwg-url → mongodb, etc.) reads
    // `Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype,"byteLength").get`
    // at load time. Our instances carry a real [[ArrayBufferData]] slot, so we
    // delegate to ArrayBuffer's own getter.
    var abByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;
    Object.defineProperty(SAB.prototype, "byteLength", { get: function () { return abByteLength.call(this); }, configurable: true });
    // Re-map an existing shared region by id (used when a SAB crosses a worker
    // message boundary); returns null if shared memory isn't available.
    SAB.__veloxRevive = function (id) {
      if (!hasShared) return null;
      var buf = __velox_shared_buffer(id);
      return buf ? adopt(buf, id) : null;
    };
    g.SharedArrayBuffer = SAB;
  }

  // ---------------------------------------------------------------------------
  // WebAssembly async API — JSC's WebAssembly.instantiate/compile (and their
  // streaming variants) return promises that settle via JSC's deferredWorkTimer,
  // a CFRunLoop timer. velox drives its own kqueue loop with no CFRunLoop, so
  // those promises NEVER settle (the background wasm compile finishes but can't
  // post its resolution back). The *synchronous* WebAssembly.Module/Instance
  // constructors work fine, so reimplement the async surface on top of them
  // (compile synchronously, resolve immediately). Unblocks emscripten output
  // and every wasm-backed package (sql.js, wasm crypto/codecs, …).
  // ---------------------------------------------------------------------------
  (function () {
    var WA = g.WebAssembly;
    if (!WA || typeof WA.Module !== "function" || typeof WA.Instance !== "function") return;
    WA.compile = function (bytes) {
      try { return Promise.resolve(new WA.Module(bytes)); }
      catch (e) { return Promise.reject(e); }
    };
    WA.instantiate = function (bytesOrModule, importObject) {
      try {
        if (bytesOrModule instanceof WA.Module) {
          return Promise.resolve(new WA.Instance(bytesOrModule, importObject));
        }
        var mod = new WA.Module(bytesOrModule);
        return Promise.resolve({ module: mod, instance: new WA.Instance(mod, importObject) });
      } catch (e) { return Promise.reject(e); }
    };
    // Streaming forms: the source is a Response (or Promise of one) whose body is
    // the wasm bytes. Read it to an ArrayBuffer, then compile synchronously.
    function streamBytes(source) {
      return Promise.resolve(source).then(function (resp) {
        if (resp && typeof resp.arrayBuffer === "function") return resp.arrayBuffer();
        return resp;
      });
    }
    WA.compileStreaming = function (source) {
      return streamBytes(source).then(function (b) { return new WA.Module(b); });
    };
    WA.instantiateStreaming = function (source, importObject) {
      return streamBytes(source).then(function (b) {
        var mod = new WA.Module(b);
        return { module: mod, instance: new WA.Instance(mod, importObject) };
      });
    };
  })();

  // ---------------------------------------------------------------------------
  // V8-style structured stack traces: Error.captureStackTrace + prepareStackTrace
  // with CallSite objects. JSC only gives a string stack and ignores
  // prepareStackTrace, but packages like depd/stack-trace/source-map-support use
  // captureStackTrace(obj) then read obj.stack under a custom prepareStackTrace.
  // We make captureStackTrace install a lazy getter that honors it.
  // ---------------------------------------------------------------------------
  (function () {
    if (typeof g.Error !== "function" || g.Error.__veloxStackPatched) return;
    if (typeof g.Error.stackTraceLimit !== "number") g.Error.stackTraceLimit = 10;

    function parseCallSites(stackStr) {
      var lines = String(stackStr || "").split("\n");
      var sites = [];
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line === "Error") continue;
        line = line.replace(/^at\s+/, ""); // tolerate V8-style lines too
        var at = line.lastIndexOf("@");
        var fn = at > 0 ? line.slice(0, at) : "";
        var loc = at >= 0 ? line.slice(at + 1) : line;
        var m = /^(.*?):(\d+):(\d+)$/.exec(loc) || /^(.*?):(\d+)$/.exec(loc);
        var file = m ? m[1] : (loc || null);
        var ln = m ? parseInt(m[2], 10) : null;
        var col = m && m[3] ? parseInt(m[3], 10) : null;
        if (fn === "global code" || fn === "module code") fn = "";
        (function (fn, file, ln, col, raw) {
          sites.push({
            getFileName: function () { return file && file !== "[native code]" ? file : null; },
            getLineNumber: function () { return ln; },
            getColumnNumber: function () { return col; },
            getFunctionName: function () { return fn || null; },
            getMethodName: function () { return fn || null; },
            getTypeName: function () { return null; },
            getThis: function () { return undefined; },
            getFunction: function () { return undefined; },
            getEvalOrigin: function () { return undefined; },
            isNative: function () { return file === "[native code]"; },
            isEval: function () { return false; },
            isConstructor: function () { return false; },
            isToplevel: function () { return !fn; },
            isAsync: function () { return false; },
            isPromiseAll: function () { return false; },
            toString: function () { return raw; },
          });
        })(fn, file, ln, col, line);
      }
      return sites;
    }

    g.Error.captureStackTrace = function captureStackTrace(target, constructorOpt) {
      // Capture the current call stack as a string.
      var holder = {};
      var raw = (new g.Error()).stack || "";
      // Drop the frame for this captureStackTrace call itself.
      var lines = String(raw).split("\n");
      if (lines.length && /captureStackTrace/.test(lines[0])) lines.shift();
      raw = lines.join("\n");
      Object.defineProperty(target, "stack", {
        configurable: true,
        enumerable: false,
        get: function () {
          var prep = g.Error.prepareStackTrace;
          if (typeof prep === "function") {
            try { return prep(target, parseCallSites(raw)); } catch (e) { /* fall through */ }
          }
          var head = (target && target.name ? target.name : "Error") +
            (target && target.message ? ": " + target.message : "");
          return head + "\n" + raw;
        },
        set: function (v) {
          Object.defineProperty(target, "stack", { value: v, writable: true, configurable: true, enumerable: false });
        },
      });
      return target;
    };
    g.Error.__veloxStackPatched = true;
  })();

  // ---------------------------------------------------------------------------
  // WebSocket — the browser-style client global, lazily backed by the `ws`
  // builtin (which needs net/crypto, set up by the time it's first accessed).
  // ---------------------------------------------------------------------------
  if (typeof g.WebSocket === "undefined") {
    Object.defineProperty(g, "WebSocket", {
      configurable: true,
      get: function () {
        var req = g.__velox_builtin_require || (typeof require === "function" ? require : null);
        if (!req) return undefined;
        var WS = req("ws").WebSocket;
        Object.defineProperty(g, "WebSocket", { value: WS, writable: true, configurable: true });
        return WS;
      },
    });
  }

  // ---------------------------------------------------------------------------
  // MessageChannel / MessagePort (same-thread, in-process) — Web globals used by
  // undici and other packages. Cross-thread transfer isn't supported here.
  // ---------------------------------------------------------------------------
  if (typeof g.MessagePort === "undefined") {
    var portListeners = new WeakMap();
    function MessagePort() { this._other = null; this._onmessage = null; this._started = false; this._queue = []; }
    MessagePort.prototype.postMessage = function (data) {
      var other = this._other;
      if (!other) return;
      g.queueMicrotask(function () {
        var ev = { data: data, type: "message", target: other };
        if (other._started || other._onmessage) {
          if (other._onmessage) other._onmessage(ev);
          var ls = portListeners.get(other);
          if (ls && ls.message) ls.message.slice().forEach(function (fn) { fn(ev); });
        } else other._queue.push(ev);
      });
    };
    MessagePort.prototype.start = function () {
      this._started = true;
      var self = this, q = this._queue; this._queue = [];
      q.forEach(function (ev) { if (self._onmessage) self._onmessage(ev); var ls = portListeners.get(self); if (ls && ls.message) ls.message.forEach(function (fn) { fn(ev); }); });
    };
    MessagePort.prototype.close = function () { this._other = null; };
    MessagePort.prototype.addEventListener = function (type, fn) {
      var ls = portListeners.get(this); if (!ls) { ls = {}; portListeners.set(this, ls); }
      (ls[type] || (ls[type] = [])).push(fn);
      if (type === "message") this.start();
    };
    MessagePort.prototype.removeEventListener = function (type, fn) {
      var ls = portListeners.get(this); if (ls && ls[type]) ls[type] = ls[type].filter(function (f) { return f !== fn; });
    };
    MessagePort.prototype.dispatchEvent = function () { return true; };
    Object.defineProperty(MessagePort.prototype, "onmessage", {
      get: function () { return this._onmessage; },
      set: function (fn) { this._onmessage = fn; this.start(); },
      configurable: true,
    });
    function MessageChannel() {
      this.port1 = new MessagePort();
      this.port2 = new MessagePort();
      this.port1._other = this.port2;
      this.port2._other = this.port1;
    }
    g.MessagePort = MessagePort;
    g.MessageChannel = MessageChannel;
  }

  // ---------------------------------------------------------------------------
  // queueMicrotask(cb) — run `cb` on the microtask queue. We piggyback on
  // Promise.resolve().then(...) which JSC drains after each turn. A thrown error
  // is reported but must not break the promise chain.
  // ---------------------------------------------------------------------------
  if (typeof g.queueMicrotask === "undefined") {
    g.queueMicrotask = function queueMicrotask(cb) {
      if (typeof cb !== "function") {
        throw new TypeError("queueMicrotask requires a function argument");
      }
      Promise.resolve().then(function () {
        try {
          cb();
        } catch (err) {
          // Surface the error without rejecting the microtask's promise.
          g.reportError(err);
        }
      });
    };
  }

  // ---------------------------------------------------------------------------
  // setImmediate(cb, ...args) / clearImmediate(id) — emulated with a 0ms timer.
  // Returns the timer handle so it can be cleared.
  // ---------------------------------------------------------------------------
  if (typeof g.setImmediate === "undefined") {
    g.setImmediate = function setImmediate(cb) {
      var args = Array.prototype.slice.call(arguments, 1);
      return setTimeout.apply(null, [cb, 0].concat(args));
    };
  }
  if (typeof g.clearImmediate === "undefined") {
    g.clearImmediate = function clearImmediate(id) {
      return clearTimeout(id);
    };
  }

  // ---------------------------------------------------------------------------
  // DOMException — minimal class used by AbortError and friends. Carries name,
  // message and a numeric code for the well-known legacy names.
  // ---------------------------------------------------------------------------
  if (typeof g.DOMException === "undefined") {
    // Legacy code table (subset that matters for us).
    var DOM_CODES = {
      IndexSizeError: 1,
      HierarchyRequestError: 3,
      WrongDocumentError: 4,
      InvalidCharacterError: 5,
      NoModificationAllowedError: 7,
      NotFoundError: 8,
      NotSupportedError: 9,
      InvalidStateError: 11,
      SyntaxError: 12,
      InvalidModificationError: 13,
      NamespaceError: 14,
      InvalidAccessError: 15,
      TypeMismatchError: 17,
      SecurityError: 18,
      NetworkError: 19,
      AbortError: 20,
      URLMismatchError: 21,
      QuotaExceededError: 22,
      TimeoutError: 23,
      InvalidNodeTypeError: 24,
      DataCloneError: 25,
    };

    var DOMException = function DOMException(message, name) {
      var err = Error.call(this, message);
      this.message = message === undefined ? "" : String(message);
      this.name = name === undefined ? "Error" : String(name);
      this.code = Object.prototype.hasOwnProperty.call(DOM_CODES, this.name)
        ? DOM_CODES[this.name]
        : 0;
      if (err.stack) this.stack = err.stack;
      return this;
    };
    DOMException.prototype = Object.create(Error.prototype);
    DOMException.prototype.constructor = DOMException;
    DOMException.prototype.name = "Error";
    // Expose the legacy numeric constants on the constructor.
    for (var k in DOM_CODES) {
      if (Object.prototype.hasOwnProperty.call(DOM_CODES, k)) {
        DOMException[k.replace(/Error$/, "").toUpperCase() + "_ERR"] =
          DOM_CODES[k];
      }
    }
    g.DOMException = DOMException;
  }

  // ---------------------------------------------------------------------------
  // reportError(err) — print an uncaught-style error via console.error.
  // ---------------------------------------------------------------------------
  if (typeof g.reportError === "undefined") {
    g.reportError = function reportError(err) {
      try {
        console.error(err);
      } catch (_) {
        // console may be unavailable in extreme cases; swallow.
      }
    };
  }

  // ---------------------------------------------------------------------------
  // atob / btoa — base64 of binary strings. Built on Buffer (already present),
  // which is the simplest correct option on this runtime.
  // ---------------------------------------------------------------------------
  if (typeof g.btoa === "undefined") {
    g.btoa = function btoa(str) {
      var s = String(str);
      // btoa only accepts code points 0..255 (binary string).
      for (var i = 0; i < s.length; i++) {
        if (s.charCodeAt(i) > 0xff) {
          throw new g.DOMException(
            "The string to be encoded contains characters outside of the Latin1 range.",
            "InvalidCharacterError",
          );
        }
      }
      return Buffer.from(s, "binary").toString("base64");
    };
  }
  if (typeof g.atob === "undefined") {
    g.atob = function atob(b64) {
      return Buffer.from(String(b64), "base64").toString("binary");
    };
  }

  // ---------------------------------------------------------------------------
  // performance — high-res-ish timer relative to startup. Bare JSC gives us no
  // sub-millisecond clock, so we lean on Date.now().
  // ---------------------------------------------------------------------------
  if (typeof g.performance === "undefined") {
    var timeOrigin = Date.now();
    g.performance = {
      timeOrigin: timeOrigin,
      now: function now() {
        return typeof globalThis.__velox_hrtime_ns === "function"
          ? globalThis.__velox_hrtime_ns() / 1e6
          : Date.now() - timeOrigin;
      },
      // No-op measurement API surface for compatibility.
      mark: function mark() {},
      measure: function measure() {},
      getEntriesByName: function getEntriesByName() {
        return [];
      },
      getEntriesByType: function getEntriesByType() {
        return [];
      },
      getEntries: function getEntries() {
        return [];
      },
      clearMarks: function clearMarks() {},
      clearMeasures: function clearMeasures() {},
      clearResourceTimings: function clearResourceTimings() {},
      setResourceTimingBufferSize: function setResourceTimingBufferSize() {},
      // Node/undici call this to record a resource-timing entry after fetch;
      // velox doesn't keep the entry buffer, so it's a no-op (the symbol must
      // exist — undici's fetch finalizer invokes it unconditionally).
      markResourceTiming: function markResourceTiming() {},
    };
  }

  // ---------------------------------------------------------------------------
  // Event — minimal DOM Event.
  // ---------------------------------------------------------------------------
  if (typeof g.Event === "undefined") {
    g.Event = class Event {
      constructor(type, eventInitDict) {
        var init = eventInitDict || {};
        this.type = String(type);
        this.bubbles = !!init.bubbles;
        this.cancelable = !!init.cancelable;
        this.composed = !!init.composed;
        this.defaultPrevented = false;
        this.target = null;
        this.currentTarget = null;
        this.timeStamp =
          typeof g.performance !== "undefined" ? g.performance.now() : Date.now();
        // Internal propagation flag.
        this._stopped = false;
      }
      preventDefault() {
        if (this.cancelable) this.defaultPrevented = true;
      }
      stopPropagation() {
        this._stopped = true;
      }
      stopImmediatePropagation() {
        this._stopped = true;
        this._immediateStopped = true;
      }
    };
  }

  // CustomEvent — an Event carrying a `detail` payload.
  if (typeof g.CustomEvent === "undefined") {
    g.CustomEvent = class CustomEvent extends g.Event {
      constructor(type, eventInitDict) {
        super(type, eventInitDict);
        this.detail = eventInitDict && "detail" in eventInitDict ? eventInitDict.detail : null;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // EventTarget — minimal addEventListener/removeEventListener/dispatchEvent
  // with `{ once }` support.
  // ---------------------------------------------------------------------------
  if (typeof g.EventTarget === "undefined") {
    g.EventTarget = class EventTarget {
      constructor() {
        // type -> array of { listener, once }
        this._listeners = new Map();
      }
      addEventListener(type, listener, opts) {
        if (typeof listener !== "function" && typeof listener !== "object") {
          return;
        }
        if (listener == null) return;
        type = String(type);
        var once = false;
        if (typeof opts === "object" && opts !== null) once = !!opts.once;
        var list = this._listeners.get(type);
        if (!list) {
          list = [];
          this._listeners.set(type, list);
        }
        // De-dupe identical listener references (DOM semantics).
        for (var i = 0; i < list.length; i++) {
          if (list[i].listener === listener) return;
        }
        list.push({ listener: listener, once: once });
      }
      removeEventListener(type, listener) {
        type = String(type);
        var list = this._listeners.get(type);
        if (!list) return;
        for (var i = 0; i < list.length; i++) {
          if (list[i].listener === listener) {
            list.splice(i, 1);
            return;
          }
        }
      }
      dispatchEvent(event) {
        event.target = this;
        event.currentTarget = this;
        var list = this._listeners.get(event.type);
        if (list) {
          // Copy so once-removal / mutation during dispatch is safe.
          var snapshot = list.slice();
          for (var i = 0; i < snapshot.length; i++) {
            var entry = snapshot[i];
            if (entry.once) this.removeEventListener(event.type, entry.listener);
            try {
              if (typeof entry.listener === "function") {
                entry.listener.call(this, event);
              } else if (typeof entry.listener.handleEvent === "function") {
                entry.listener.handleEvent(event);
              }
            } catch (err) {
              g.reportError(err);
            }
            if (event._immediateStopped) break;
          }
        }
        event.currentTarget = null;
        return !event.defaultPrevented;
      }
    };
  }

  // ---------------------------------------------------------------------------
  // AbortSignal / AbortController.
  // ---------------------------------------------------------------------------
  if (typeof g.AbortSignal === "undefined") {
    var AbortSignal = class AbortSignal extends g.EventTarget {
      constructor() {
        super();
        this.aborted = false;
        this.reason = undefined;
        this.onabort = null;
      }

      throwIfAborted() {
        if (this.aborted) throw this.reason;
      }

      // Internal: flip to aborted exactly once and fire 'abort'.
      _abort(reason) {
        if (this.aborted) return;
        this.aborted = true;
        this.reason =
          reason !== undefined
            ? reason
            : new g.DOMException("This operation was aborted", "AbortError");
        var event = new g.Event("abort");
        // onabort handler fires alongside listeners.
        if (typeof this.onabort === "function") {
          try {
            this.onabort.call(this, event);
          } catch (err) {
            g.reportError(err);
          }
        }
        this.dispatchEvent(event);
      }

      // Static: an already-aborted signal.
      static abort(reason) {
        var s = new AbortSignal();
        s.aborted = true;
        s.reason =
          reason !== undefined
            ? reason
            : new g.DOMException("This operation was aborted", "AbortError");
        return s;
      }

      // Static: a signal that aborts (TimeoutError) after `ms`.
      static timeout(ms) {
        var s = new AbortSignal();
        setTimeout(function () {
          s._abort(new g.DOMException("The operation timed out", "TimeoutError"));
        }, ms);
        return s;
      }

      // Static: aborts as soon as any of the given signals aborts.
      static any(signals) {
        var result = new AbortSignal();
        var arr = Array.from(signals);
        for (var i = 0; i < arr.length; i++) {
          var src = arr[i];
          if (src.aborted) {
            result._abort(src.reason);
            return result;
          }
        }
        var onAbort = function () {
          // `this` is the source signal that fired.
          result._abort(this.reason);
          // Detach from the rest.
          for (var j = 0; j < arr.length; j++) {
            arr[j].removeEventListener("abort", onAbort);
          }
        };
        for (var k = 0; k < arr.length; k++) {
          arr[k].addEventListener("abort", onAbort);
        }
        return result;
      }
    };
    g.AbortSignal = AbortSignal;
  }

  if (typeof g.AbortController === "undefined") {
    g.AbortController = class AbortController {
      constructor() {
        this.signal = new g.AbortSignal();
      }
      abort(reason) {
        this.signal._abort(reason);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // structuredClone(value) — deep clone with cycle support. Handles plain
  // objects, arrays, Map, Set, Date, RegExp, ArrayBuffer and typed arrays.
  // Functions (and other uncloneables) throw a DataCloneError.
  // ---------------------------------------------------------------------------
  if (typeof g.structuredClone === "undefined") {
    g.structuredClone = function structuredClone(value) {
      var seen = new Map();

      function clone(val) {
        // Primitives (and null) are returned as-is.
        if (val === null || typeof val !== "object") {
          if (typeof val === "function") {
            throw new g.DOMException(
              "A function could not be cloned.",
              "DataCloneError",
            );
          }
          if (typeof val === "symbol") {
            throw new g.DOMException(
              "A Symbol could not be cloned.",
              "DataCloneError",
            );
          }
          return val;
        }

        // Cycle / shared-reference guard.
        if (seen.has(val)) return seen.get(val);

        // Error — clone name/message/stack/cause (per the HTML clone steps).
        if (val instanceof Error) {
          var Ctor = g[val.name] && g[val.name].prototype instanceof Error ? g[val.name] : Error;
          var errClone = new Ctor(val.message);
          if (val.name !== errClone.name) try { errClone.name = val.name; } catch (e) {}
          if ("stack" in val) try { errClone.stack = val.stack; } catch (e) {}
          if ("cause" in val) try { errClone.cause = clone(val.cause); } catch (e) {}
          seen.set(val, errClone);
          return errClone;
        }

        // Date.
        if (val instanceof Date) {
          return new Date(val.getTime());
        }

        // RegExp.
        if (val instanceof RegExp) {
          var re = new RegExp(val.source, val.flags);
          re.lastIndex = val.lastIndex;
          return re;
        }

        // ArrayBuffer.
        if (val instanceof ArrayBuffer) {
          return val.slice(0);
        }

        // Typed arrays / DataView (ArrayBuffer views).
        if (ArrayBuffer.isView(val)) {
          if (val instanceof DataView) {
            return new DataView(
              val.buffer.slice(0),
              val.byteOffset,
              val.byteLength,
            );
          }
          // TypedArray: copy the underlying bytes into a fresh buffer.
          var Ctor = val.constructor;
          var copy = new Ctor(val.length);
          var out = copy;
          seen.set(val, out);
          out.set(val);
          return out;
        }

        // Map.
        if (val instanceof Map) {
          var mapCopy = new Map();
          seen.set(val, mapCopy);
          val.forEach(function (v, key) {
            mapCopy.set(clone(key), clone(v));
          });
          return mapCopy;
        }

        // Set.
        if (val instanceof Set) {
          var setCopy = new Set();
          seen.set(val, setCopy);
          val.forEach(function (v) {
            setCopy.add(clone(v));
          });
          return setCopy;
        }

        // Reject things we know we can't clone meaningfully.
        if (
          val instanceof WeakMap ||
          val instanceof WeakSet ||
          val instanceof Promise
        ) {
          throw new g.DOMException(
            "An object could not be cloned.",
            "DataCloneError",
          );
        }

        // Array.
        if (Array.isArray(val)) {
          var arrCopy = [];
          seen.set(val, arrCopy);
          for (var i = 0; i < val.length; i++) {
            arrCopy[i] = clone(val[i]);
          }
          return arrCopy;
        }

        // Plain object (drop the prototype, like the real algorithm does for
        // generic objects — output is a bare {} with cloned own enum props).
        var objCopy = {};
        seen.set(val, objCopy);
        var keys = Object.keys(val);
        for (var j = 0; j < keys.length; j++) {
          objCopy[keys[j]] = clone(val[keys[j]]);
        }
        return objCopy;
      }

      return clone(value);
    };
  }

  // navigator — minimal Web/Node-compatible global (Node 21+, Deno, and Bun all
  // ship one). hardwareConcurrency is a lazy getter so it can reach `require`
  // (installed after this prelude).
  if (typeof g.navigator === "undefined") {
    var nav = {};
    Object.defineProperty(nav, "hardwareConcurrency", {
      enumerable: true,
      get: function () {
        try {
          var os = require("node:os");
          return os.availableParallelism ? os.availableParallelism() : os.cpus().length;
        } catch (e) {
          return 1;
        }
      },
    });
    var ver = (g.process && g.process.versions && g.process.versions.velox) || "0.1.0";
    var locale = "en-US";
    try {
      locale = new Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
    } catch (e) {}
    Object.defineProperty(nav, "userAgent", { enumerable: true, value: "velox/" + ver });
    Object.defineProperty(nav, "platform", {
      enumerable: true,
      value: (g.process && g.process.platform) || "",
    });
    Object.defineProperty(nav, "language", { enumerable: true, value: locale });
    Object.defineProperty(nav, "languages", {
      enumerable: true,
      value: Object.freeze([locale]),
    });
    Object.defineProperty(nav, "onLine", { enumerable: true, value: true });
    g.navigator = nav;
  }

  // ---------------------------------------------------------------------------
  // BroadcastChannel — same-runtime pub/sub. Channels sharing a name form a
  // group; postMessage delivers a MessageEvent asynchronously to every OTHER
  // open channel in the group (never back to itself). worker_threads are
  // separate runtimes, so cross-thread delivery isn't supported here.
  // ---------------------------------------------------------------------------
  if (typeof g.BroadcastChannel === "undefined") {
    var bcRegistry = new Map(); // name -> Set of open channels
    var BroadcastChannel = class BroadcastChannel extends g.EventTarget {
      constructor(name) {
        super();
        this._name = String(name);
        this._closed = false;
        this._onmessage = null;
        this._onmessageerror = null;
        var group = bcRegistry.get(this._name);
        if (!group) { group = new Set(); bcRegistry.set(this._name, group); }
        group.add(this);
      }
      get name() { return this._name; }
      postMessage(value) {
        if (this._closed) throw new DOMException("BroadcastChannel is closed", "InvalidStateError");
        var group = bcRegistry.get(this._name);
        if (!group) return;
        var cloned;
        try {
          cloned = typeof g.structuredClone === "function" ? g.structuredClone(value) : value;
        } catch (e) {
          cloned = value;
        }
        var self = this;
        var targets = [];
        group.forEach(function (ch) { if (ch !== self && !ch._closed) targets.push(ch); });
        g.queueMicrotask(function () {
          for (var i = 0; i < targets.length; i++) {
            var ch = targets[i];
            if (ch._closed) continue;
            var ev = typeof g.MessageEvent === "function"
              ? new g.MessageEvent("message", { data: cloned })
              : { type: "message", data: cloned };
            ch.dispatchEvent(ev);
          }
        });
      }
      close() {
        if (this._closed) return;
        this._closed = true;
        var group = bcRegistry.get(this._name);
        if (group) {
          group.delete(this);
          if (group.size === 0) bcRegistry.delete(this._name);
        }
      }
      get onmessage() { return this._onmessage; }
      set onmessage(fn) {
        if (this._onmessage) this.removeEventListener("message", this._onmessage);
        this._onmessage = typeof fn === "function" ? fn : null;
        if (this._onmessage) this.addEventListener("message", this._onmessage);
      }
      get onmessageerror() { return this._onmessageerror; }
      set onmessageerror(fn) {
        if (this._onmessageerror) this.removeEventListener("messageerror", this._onmessageerror);
        this._onmessageerror = typeof fn === "function" ? fn : null;
        if (this._onmessageerror) this.addEventListener("messageerror", this._onmessageerror);
      }
    };
    g.BroadcastChannel = BroadcastChannel;
  }
})();

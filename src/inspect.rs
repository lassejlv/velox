//! A Node.js `util.inspect`-style value formatter, delivered as a JavaScript
//! prelude. Evaluating [`INSPECT_PRELUDE`] installs `globalThis.__velox_inspect`,
//! which renders a single value into a readable, Node-like string. The `console`
//! shim calls it to format each argument (functions, `undefined`, circular refs,
//! `Map`/`Set`, etc.) instead of `JSON.stringify`, which can't represent those.

/// JavaScript prelude that installs `globalThis.__velox_inspect(value)`,
/// a Node-like formatter used by `console`.
pub const INSPECT_PRELUDE: &str = r#"
(function () {
  var MAX_DEPTH = 2;

  function isIdentifier(key) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
  }

  function quoteString(s) {
    var out = "'";
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === "'") out += "\\'";
      else if (c === "\\") out += "\\\\";
      else if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else {
        var code = s.charCodeAt(i);
        if (code < 0x20) {
          out += "\\x" + code.toString(16).padStart(2, "0");
        } else {
          out += c;
        }
      }
    }
    return out + "'";
  }

  function funcName(fn) {
    try {
      var src = Function.prototype.toString.call(fn);
      var isClass = /^\s*class[\s{]/.test(src);
      var name = fn.name;
      if (isClass) {
        return name ? "[class " + name + "]" : "[class (anonymous)]";
      }
      return name ? "[Function: " + name + "]" : "[Function (anonymous)]";
    } catch (e) {
      return "[Function]";
    }
  }

  function ctorName(value) {
    try {
      var proto = Object.getPrototypeOf(value);
      if (proto === null) return null; // null-prototype object
      var ctor = proto.constructor;
      if (typeof ctor === "function" && ctor.name) return ctor.name;
    } catch (e) {}
    return undefined;
  }

  function inspect(value, depth, seen, topLevel) {
    var t = typeof value;

    if (value === null) return "null";
    if (t === "undefined") return "undefined";
    if (t === "boolean") return String(value);
    if (t === "number") {
      if (Object.is(value, -0)) return "-0";
      return String(value); // NaN, Infinity, -Infinity, normal
    }
    if (t === "bigint") return String(value) + "n";
    if (t === "symbol") return value.toString();
    if (t === "string") {
      return topLevel ? value : quoteString(value);
    }
    if (t === "function") {
      return funcName(value);
    }

    // Objects from here.
    if (seen.has(value)) {
      return "[Circular *1]";
    }

    // Special built-ins (check before generic object handling).
    var tag;
    try {
      tag = Object.prototype.toString.call(value);
    } catch (e) {
      tag = "[object Object]";
    }

    if (value instanceof Date || tag === "[object Date]") {
      try { return value.toISOString(); } catch (e) { return "Invalid Date"; }
    }
    if (value instanceof RegExp || tag === "[object RegExp]") {
      try { return String(value); } catch (e) { return "/?/"; }
    }
    if (value instanceof Error || tag === "[object Error]") {
      try {
        var stack = value.stack;
        if (typeof stack === "string" && stack.length) {
          return stack.split("\n")[0];
        }
        var nm = value.name || "Error";
        var msg = value.message;
        return msg ? nm + ": " + msg : nm;
      } catch (e) {
        return "[Error]";
      }
    }

    var isArray = Array.isArray(value);
    var isMap = (typeof Map !== "undefined") && (value instanceof Map);
    var isSet = (typeof Set !== "undefined") && (value instanceof Set);

    // Depth limit.
    if (depth > MAX_DEPTH) {
      if (isArray) return "[Array]";
      if (isMap) return "[Map]";
      if (isSet) return "[Set]";
      var cn = ctorName(value);
      if (cn && cn !== "Object") return "[" + cn + "]";
      return "[Object]";
    }

    seen.add(value);
    var result;
    try {
      if (isArray) {
        result = formatArray(value, depth, seen);
      } else if (isMap) {
        result = formatMap(value, depth, seen);
      } else if (isSet) {
        result = formatSet(value, depth, seen);
      } else {
        result = formatObject(value, depth, seen);
      }
    } finally {
      seen.delete(value);
    }
    return result;
  }

  function formatArray(arr, depth, seen) {
    var parts = [];
    var len = arr.length;
    var emptyRun = 0;
    for (var i = 0; i < len; i++) {
      if (!(i in arr)) {
        emptyRun++;
        continue;
      }
      if (emptyRun > 0) {
        parts.push("<" + emptyRun + " empty item" + (emptyRun > 1 ? "s" : "") + ">");
        emptyRun = 0;
      }
      var v;
      try { v = arr[i]; } catch (e) { v = "[getter error]"; }
      parts.push(inspect(v, depth + 1, seen, false));
    }
    if (emptyRun > 0) {
      parts.push("<" + emptyRun + " empty item" + (emptyRun > 1 ? "s" : "") + ">");
    }
    // Extra non-index own enumerable props.
    var keys;
    try { keys = Object.keys(arr); } catch (e) { keys = []; }
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      if (/^(0|[1-9][0-9]*)$/.test(key) && Number(key) < len) continue;
      parts.push(formatKey(key) + ": " + safeInspect(arr, key, depth, seen));
    }
    if (parts.length === 0) return "[]";
    return "[ " + parts.join(", ") + " ]";
  }

  function formatKey(key) {
    return isIdentifier(key) ? key : quoteString(key);
  }

  function safeInspect(obj, key, depth, seen) {
    var v;
    try { v = obj[key]; } catch (e) { return "[getter error]"; }
    return inspect(v, depth + 1, seen, false);
  }

  function formatObject(obj, depth, seen) {
    var parts = [];
    var keys;
    try { keys = Object.keys(obj); } catch (e) { keys = []; }
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      parts.push(formatKey(key) + ": " + safeInspect(obj, key, depth, seen));
    }

    var prefix = "";
    var cn = ctorName(obj);
    if (cn === null) {
      prefix = "[Object: null prototype] ";
    } else if (cn !== undefined && cn !== "Object") {
      prefix = cn + " ";
    }

    if (parts.length === 0) {
      return prefix ? prefix + "{}" : "{}";
    }
    return prefix + "{ " + parts.join(", ") + " }";
  }

  function formatMap(map, depth, seen) {
    var parts = [];
    try {
      map.forEach(function (v, k) {
        parts.push(
          inspect(k, depth + 1, seen, false) + " => " + inspect(v, depth + 1, seen, false)
        );
      });
    } catch (e) {}
    var head = "Map(" + map.size + ")";
    if (parts.length === 0) return head + " {}";
    return head + " { " + parts.join(", ") + " }";
  }

  function formatSet(set, depth, seen) {
    var parts = [];
    try {
      set.forEach(function (v) {
        parts.push(inspect(v, depth + 1, seen, false));
      });
    } catch (e) {}
    var head = "Set(" + set.size + ")";
    if (parts.length === 0) return head + " {}";
    return head + " { " + parts.join(", ") + " }";
  }

  globalThis.__velox_inspect = function (value) {
    try {
      return inspect(value, 0, new WeakSet(), true);
    } catch (e) {
      try { return String(value); } catch (e2) { return "[unprintable]"; }
    }
  };
})();
"#;

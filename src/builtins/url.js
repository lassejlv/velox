// Installs globalThis.URL and globalThis.URLSearchParams — a pragmatic WHATWG
// URL implementation (bare JavaScriptCore has neither). Covers absolute
// http(s)/ws(s)/ftp/file URLs and common relative resolution; not full spec
// (no IDNA, limited percent-encoding normalization).

(function () {
  if (typeof globalThis.URL !== "undefined") return;

  function dec(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function enc(s) { return encodeURIComponent(s); }

  var SPECIAL = { "http:": "80", "https:": "443", "ws:": "80", "wss:": "443", "ftp:": "21" };
  function isSpecial(proto) { return Object.prototype.hasOwnProperty.call(SPECIAL, proto); }
  function needsSlashes(proto) { return isSpecial(proto) || proto === "file:"; }

  // --- IDNA: Punycode (RFC 3492) toASCII for non-ASCII host labels ----------
  function punyAdapt(delta, numPoints, firstTime) {
    delta = firstTime ? Math.floor(delta / 700) : delta >> 1;
    delta += Math.floor(delta / numPoints);
    var k = 0;
    for (; delta > 455; k += 36) delta = Math.floor(delta / 35);
    return k + Math.floor((36 * delta) / (delta + 38));
  }
  function digitToBasic(d) { return d + 22 + (d < 26 ? 75 : 0); } // 0-25→a-z, 26-35→0-9
  function punycodeEncode(input) {
    var codePoints = [];
    for (var i = 0; i < input.length; i++) {
      var c = input.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
        var c2 = input.charCodeAt(i + 1);
        codePoints.push((c - 0xd800) * 0x400 + (c2 - 0xdc00) + 0x10000); i++;
      } else codePoints.push(c);
    }
    var n = 128, delta = 0, bias = 72, output = [];
    var basic = codePoints.filter(function (c) { return c < 128; });
    var b = basic.length, h = b;
    basic.forEach(function (c) { output.push(String.fromCharCode(c)); });
    if (b > 0) output.push("-");
    while (h < codePoints.length) {
      var m = Infinity;
      codePoints.forEach(function (c) { if (c >= n && c < m) m = c; });
      delta += (m - n) * (h + 1);
      n = m;
      codePoints.forEach(function (c) {
        if (c < n) delta++;
        if (c === n) {
          var q = delta;
          for (var k = 36; ; k += 36) {
            var t = k <= bias ? 1 : (k >= bias + 26 ? 26 : k - bias);
            if (q < t) break;
            output.push(String.fromCharCode(digitToBasic(t + ((q - t) % (36 - t)))));
            q = Math.floor((q - t) / (36 - t));
          }
          output.push(String.fromCharCode(digitToBasic(q)));
          bias = punyAdapt(delta, h + 1, h === b);
          delta = 0; h++;
        }
      });
      delta++; n++;
    }
    return output.join("");
  }
  function domainToASCII(domain) {
    return domain.split(".").map(function (label) {
      return /[^\x00-\x7f]/.test(label) ? "xn--" + punycodeEncode(label) : label;
    }).join(".");
  }

  // --- WHATWG IPv4 host parser (dotted-decimal/hex/octal → canonical) --------
  function parseIPv4Number(part) {
    var radix = 10;
    if (part.length >= 2 && part[0] === "0" && (part[1] === "x" || part[1] === "X")) {
      radix = 16; part = part.slice(2); if (part === "") return 0;
    } else if (part.length >= 2 && part[0] === "0") {
      radix = 8; part = part.slice(1);
    }
    var re = radix === 10 ? /^[0-9]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9a-fA-F]+$/;
    if (!re.test(part)) return null;
    var n = parseInt(part, radix);
    return isNaN(n) ? null : n;
  }
  function parseIPv4(host) {
    var parts = host.split(".");
    if (parts.length && parts[parts.length - 1] === "") parts.pop(); // trailing dot
    if (parts.length === 0 || parts.length > 4) return null;
    var numbers = [];
    for (var i = 0; i < parts.length; i++) {
      var n = parseIPv4Number(parts[i]);
      if (n === null) return null;
      numbers.push(n);
    }
    for (var j = 0; j < numbers.length - 1; j++) if (numbers[j] > 255) return null;
    if (numbers[numbers.length - 1] >= Math.pow(256, 5 - numbers.length)) return null;
    var ipv4 = numbers.pop(), counter = 0;
    numbers.forEach(function (n) { ipv4 += n * Math.pow(256, 3 - counter); counter++; });
    var out = [];
    for (var k = 0; k < 4; k++) { out.unshift(ipv4 % 256); ipv4 = Math.floor(ipv4 / 256); }
    return out.join(".");
  }

  // Process a special-scheme host: IDN→punycode, then IPv4 normalization.
  function processHost(host, special) {
    if (host === "" || host[0] === "[") return host; // empty or IPv6 literal
    if (special && /[^\x00-\x7f]/.test(host)) host = domainToASCII(host);
    host = host.toLowerCase();
    if (special) { var ip = parseIPv4(host); if (ip !== null) return ip; }
    return host;
  }

  // WHATWG path normalization: remove single-dot (".", "%2e") and double-dot
  // ("..") segments, but PRESERVE empty segments (so "//a" stays "//a"). A
  // trailing dot segment leaves a trailing slash.
  function isSingleDot(s) { var l = s.toLowerCase(); return l === "." || l === "%2e"; }
  function isDoubleDot(s) {
    var l = s.toLowerCase();
    return l === ".." || l === ".%2e" || l === "%2e." || l === "%2e%2e";
  }
  function normalizePath(path) {
    if (!path) return path;
    var lead = path[0] === "/";
    var body = lead ? path.slice(1) : path;
    var parts = body.split("/");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      var last = i === parts.length - 1;
      if (isDoubleDot(seg)) { if (out.length) out.pop(); if (last) out.push(""); continue; }
      if (isSingleDot(seg)) { if (last) out.push(""); continue; }
      out.push(seg);
    }
    var result = out.join("/");
    return lead ? "/" + result : result;
  }

  class URLSearchParams {
    constructor(init) {
      this._list = [];
      if (init == null || init === "") return;
      if (typeof init === "string") {
        var q = init[0] === "?" ? init.slice(1) : init;
        if (!q) return;
        var self = this;
        q.split("&").forEach(function (pair) {
          if (pair === "") return;
          var i = pair.indexOf("=");
          var k = i === -1 ? pair : pair.slice(0, i);
          var v = i === -1 ? "" : pair.slice(i + 1);
          self._list.push([dec(k.replace(/\+/g, " ")), dec(v.replace(/\+/g, " "))]);
        });
      } else if (init instanceof URLSearchParams) {
        this._list = init._list.map(function (e) { return [e[0], e[1]]; });
      } else if (Array.isArray(init)) {
        for (var j = 0; j < init.length; j++) this._list.push([String(init[j][0]), String(init[j][1])]);
      } else if (typeof init === "object") {
        for (var key in init) if (Object.prototype.hasOwnProperty.call(init, key)) this._list.push([key, String(init[key])]);
      }
    }
    append(k, v) { this._list.push([String(k), String(v)]); }
    delete(k) { k = String(k); this._list = this._list.filter(function (e) { return e[0] !== k; }); }
    get(k) { k = String(k); var e = this._list.find(function (e) { return e[0] === k; }); return e ? e[1] : null; }
    getAll(k) { k = String(k); return this._list.filter(function (e) { return e[0] === k; }).map(function (e) { return e[1]; }); }
    has(k) { k = String(k); return this._list.some(function (e) { return e[0] === k; }); }
    set(k, v) {
      k = String(k); v = String(v);
      var found = false;
      this._list = this._list.filter(function (e) {
        if (e[0] !== k) return true;
        if (!found) { e[1] = v; found = true; return true; }
        return false;
      });
      if (!found) this._list.push([k, v]);
    }
    sort() { this._list.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); }
    forEach(cb, thisArg) { this._list.forEach(function (e) { cb.call(thisArg, e[1], e[0], this); }, this); }
    keys() { return this._list.map(function (e) { return e[0]; })[Symbol.iterator](); }
    values() { return this._list.map(function (e) { return e[1]; })[Symbol.iterator](); }
    entries() { return this._list.map(function (e) { return [e[0], e[1]]; })[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    get size() { return this._list.length; }
    toString() {
      return this._list.map(function (e) { return enc(e[0]) + "=" + enc(e[1]); }).join("&");
    }
  }

  function parseAuthority(url, s) {
    // s = authority[/path][?query][#hash]
    var end = s.length;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === "/" || ch === "?" || ch === "#") { end = i; break; }
    }
    var authority = s.slice(0, end);
    var rest = s.slice(end);
    var at = authority.lastIndexOf("@");
    if (at !== -1) {
      var userinfo = authority.slice(0, at);
      authority = authority.slice(at + 1);
      var ci = userinfo.indexOf(":");
      // Userinfo is percent-encoded with the userinfo encode set.
      url._username = percentEncode(ci === -1 ? userinfo : userinfo.slice(0, ci), USERINFO_ENCODE);
      url._password = ci === -1 ? "" : percentEncode(userinfo.slice(ci + 1), USERINFO_ENCODE);
    }
    var colon = authority.lastIndexOf(":");
    var special = isSpecial(url._protocol);
    if (colon !== -1 && authority.indexOf("]", colon) === -1) {
      url._hostname = processHost(authority.slice(0, colon), special);
      url._port = authority.slice(colon + 1);
      if (url._port === SPECIAL[url._protocol]) url._port = "";
    } else {
      url._hostname = processHost(authority, special);
    }
    // Special schemes (and file with a host requirement aside) must have a host.
    if (url._hostname === "" && isSpecial(url._protocol)) {
      throw new TypeError("Invalid URL: missing host");
    }
    parsePathQueryHash(url, rest);
  }

  // Percent-encode per the WHATWG URL component encode sets: always encode C0
  // controls, space, and bytes > 0x7E (as UTF-8); `extra` lists the additional
  // ASCII characters a given component encodes. Already-encoded "%xx" is kept.
  function percentEncode(str, extra) {
    var out = "";
    for (var i = 0; i < str.length; i++) {
      var ch = str[i];
      var cp = str.charCodeAt(i);
      // Pass through valid existing %xx escapes untouched.
      if (ch === "%" && /^[0-9a-fA-F]{2}/.test(str.slice(i + 1, i + 3))) { out += str.slice(i, i + 3); i += 2; continue; }
      if (cp <= 0x20 || cp > 0x7e || extra.indexOf(ch) !== -1) {
        // Encode this character's UTF-8 bytes.
        var bytes = unescape(encodeURIComponent(ch));
        for (var b = 0; b < bytes.length; b++) {
          out += "%" + ("0" + bytes.charCodeAt(b).toString(16).toUpperCase()).slice(-2);
        }
      } else {
        out += ch;
      }
    }
    return out;
  }
  var PATH_ENCODE = "\"<>`{}?#";
  var QUERY_ENCODE = "\"#<>";
  var FRAGMENT_ENCODE = "\"<>`";
  // Userinfo encode set = path set + these separators.
  var USERINFO_ENCODE = PATH_ENCODE + "/:;=@[\\]^|";

  function parsePathQueryHash(url, s) {
    var hash = "", search = "", path = s;
    var h = path.indexOf("#");
    if (h !== -1) { hash = path.slice(h); path = path.slice(0, h); }
    var q = path.indexOf("?");
    if (q !== -1) { search = path.slice(q); path = path.slice(0, q); }
    url._pathname = percentEncode(path, PATH_ENCODE);
    url._search = search ? "?" + percentEncode(search.slice(1), QUERY_ENCODE) : "";
    url._hash = hash ? "#" + percentEncode(hash.slice(1), FRAGMENT_ENCODE) : "";
  }

  class URL {
    constructor(input, base) {
      // WHATWG: strip leading/trailing C0 controls + space, and remove all ASCII
      // tab (U+0009) and newline (U+000A/U+000D) anywhere in the input.
      input = String(input).replace(/^[\x00-\x20]+|[\x00-\x20]+$/g, "").replace(/[\t\n\r]/g, "");
      var baseUrl = base == null ? null : base instanceof URL ? base : new URL(String(base));

      this._username = ""; this._password = "";
      this._hostname = ""; this._port = "";
      this._pathname = ""; this._search = ""; this._hash = "";
      this._sp = null;

      var m = /^([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(input);
      if (m) {
        this._protocol = m[1].toLowerCase() + ":";
        var rest = input.slice(m[0].length);
        // In special schemes, backslashes are treated as forward slashes.
        if (isSpecial(this._protocol)) rest = rest.replace(/\\/g, "/");
        if (rest.slice(0, 2) === "//") parseAuthority(this, rest.slice(2));
        else parsePathQueryHash(this, rest);
      } else {
        if (!baseUrl) throw new TypeError("Invalid URL: " + input);
        this._protocol = baseUrl._protocol;
        this._hostname = baseUrl._hostname; this._port = baseUrl._port;
        this._username = baseUrl._username; this._password = baseUrl._password;
        if (isSpecial(this._protocol)) input = input.replace(/\\/g, "/");
        if (input.slice(0, 2) === "//") parseAuthority(this, input.slice(2));
        else if (input[0] === "/") parsePathQueryHash(this, input);
        else if (input[0] === "?") { this._pathname = baseUrl._pathname; parsePathQueryHash(this, baseUrl._pathname + input); }
        else if (input[0] === "#") { this._pathname = baseUrl._pathname; this._search = baseUrl._search; this._hash = input; }
        else {
          var dir = baseUrl._pathname.replace(/[^/]*$/, "");
          parsePathQueryHash(this, dir + input);
        }
      }

      if (this._pathname === "" && needsSlashes(this._protocol)) this._pathname = "/";
      if (this._pathname) this._pathname = normalizePath(this._pathname);
    }

    get protocol() { return this._protocol; }
    set protocol(v) { this._protocol = String(v).replace(/:*$/, ":"); }
    get username() { return this._username; }
    set username(v) { this._username = String(v); }
    get password() { return this._password; }
    set password(v) { this._password = String(v); }
    get hostname() { return this._hostname; }
    set hostname(v) { this._hostname = String(v).toLowerCase(); }
    get port() { return this._port; }
    set port(v) { v = String(v); this._port = v === "" ? "" : String(parseInt(v, 10) || ""); }
    get host() { return this._hostname + (this._port ? ":" + this._port : ""); }
    set host(v) {
      v = String(v); var i = v.indexOf(":");
      if (i === -1) { this._hostname = v.toLowerCase(); this._port = ""; }
      else { this._hostname = v.slice(0, i).toLowerCase(); this._port = v.slice(i + 1); }
    }
    get pathname() { return this._pathname; }
    set pathname(v) { v = String(v); this._pathname = needsSlashes(this._protocol) && v[0] !== "/" ? "/" + v : v; }
    get search() {
      // If searchParams was materialized, it is the source of truth (live).
      if (this._sp) { var s = this._sp.toString(); return s ? "?" + s : ""; }
      return this._search;
    }
    set search(v) { v = String(v); this._search = v === "" ? "" : v[0] === "?" ? v : "?" + v; this._sp = null; }
    get hash() { return this._hash; }
    set hash(v) { v = String(v); this._hash = v === "" ? "" : v[0] === "#" ? v : "#" + v; }
    get searchParams() {
      if (!this._sp) this._sp = new URLSearchParams(this._search);
      return this._sp;
    }
    get origin() {
      if (isSpecial(this._protocol)) return this._protocol + "//" + this.host;
      return "null";
    }
    get href() {
      var s = this._protocol + (needsSlashes(this._protocol) ? "//" : "");
      if (this._username) { s += this._username; if (this._password) s += ":" + this._password; s += "@"; }
      s += this.host + this._pathname;
      var search = this._sp ? (this._sp.toString() ? "?" + this._sp.toString() : "") : this._search;
      return s + search + this._hash;
    }
    set href(v) {
      var u = new URL(v);
      this._protocol = u._protocol; this._username = u._username; this._password = u._password;
      this._hostname = u._hostname; this._port = u._port; this._pathname = u._pathname;
      this._search = u._search; this._hash = u._hash; this._sp = null;
    }
    toString() { return this.href; }
    toJSON() { return this.href; }
  }

  URL.canParse = function (input, base) {
    try { new URL(input, base); return true; } catch (e) { return false; }
  };
  // URL.parse (Node 22.1+ / WHATWG) — like `new URL` but returns null instead of
  // throwing on an invalid input.
  URL.parse = function (input, base) {
    try { return new URL(input, base); } catch (e) { return null; }
  };

  globalThis.URL = URL;
  globalThis.URLSearchParams = URLSearchParams;
})();

// web_fetch.js — velox prelude installing the WHATWG Fetch API classes as
// globals on bare JavaScriptCore. This is a plain-script IIFE (NOT a module):
// it runs at startup and installs each global via `globalThis.X = ...`, but only
// when that global is not already defined.
//
// Globals installed (each guarded): Headers, Blob, File, FormData, Request,
// Response.
//
// Available from earlier preludes / the host: Buffer, TextEncoder, TextDecoder,
// URL, URLSearchParams, structuredClone, Promise, Symbol.asyncIterator. We lean
// on Buffer for all byte handling (utf8 encode/decode, base64, concat).
(function () {
  "use strict";

  var g = globalThis;

  // ===========================================================================
  // Byte helpers — normalize the many body source types down to a single
  // contiguous Buffer, and decode back to strings/ArrayBuffers on demand.
  // ===========================================================================

  // Encode a JS string to a utf8 Buffer.
  function utf8Encode(str) {
    return Buffer.from(String(str), "utf8");
  }

  // Decode a Buffer (or anything Buffer.from accepts) to a utf8 string.
  function utf8Decode(buf) {
    return Buffer.from(buf).toString("utf8");
  }

  // Copy an ArrayBuffer/TypedArray/DataView into a fresh Buffer (no aliasing).
  function bufferFromBinary(value) {
    if (value instanceof ArrayBuffer) {
      return Buffer.from(new Uint8Array(value.slice(0)));
    }
    if (ArrayBuffer.isView(value)) {
      // Respect byteOffset/byteLength for views over a larger buffer.
      var view = new Uint8Array(
        value.buffer,
        value.byteOffset,
        value.byteLength,
      );
      return Buffer.from(view); // Buffer.from(Uint8Array) copies.
    }
    return null;
  }

  // Turn a Buffer into a standalone ArrayBuffer sized exactly to its contents.
  function bufferToArrayBuffer(buf) {
    var out = new ArrayBuffer(buf.length);
    new Uint8Array(out).set(buf);
    return out;
  }

  // Detect our own Blob instances (set up below).
  function isBlob(value) {
    return value != null && value instanceof g.Blob;
  }

  // ===========================================================================
  // Headers — case-insensitive multi-map. Names are stored lowercased; for each
  // name we keep an array of values so duplicates can be combined (get) or
  // exposed individually (getSetCookie).
  // ===========================================================================
  if (typeof g.Headers === "undefined") {
    var Headers = function Headers(init) {
      // Map<lowercased-name, string[]>.
      this._map = new Map();
      if (init === undefined || init === null) return;

      if (init instanceof Headers) {
        var self = this;
        init._map.forEach(function (values, name) {
          self._map.set(name, values.slice());
        });
        return;
      }
      if (Array.isArray(init)) {
        // Array of [name, value] pairs.
        for (var i = 0; i < init.length; i++) {
          var pair = init[i];
          if (!pair || pair.length !== 2) {
            throw new TypeError("Headers init pair must have two elements");
          }
          this.append(pair[0], pair[1]);
        }
        return;
      }
      if (typeof init === "object") {
        var keys = Object.keys(init);
        for (var k = 0; k < keys.length; k++) {
          this.append(keys[k], init[keys[k]]);
        }
        return;
      }
      throw new TypeError("Invalid Headers init");
    };

    Headers.prototype.append = function append(name, value) {
      var key = String(name).toLowerCase();
      var val = String(value);
      var existing = this._map.get(key);
      if (existing) existing.push(val);
      else this._map.set(key, [val]);
    };

    Headers.prototype.set = function set(name, value) {
      this._map.set(String(name).toLowerCase(), [String(value)]);
    };

    Headers.prototype.get = function get(name) {
      var values = this._map.get(String(name).toLowerCase());
      if (!values) return null;
      // Browsers combine duplicate values with ", ".
      return values.join(", ");
    };

    // Non-combined Set-Cookie values (each cookie kept separate).
    Headers.prototype.getSetCookie = function getSetCookie() {
      var values = this._map.get("set-cookie");
      return values ? values.slice() : [];
    };

    Headers.prototype.has = function has(name) {
      return this._map.has(String(name).toLowerCase());
    };

    Headers.prototype["delete"] = function del(name) {
      this._map["delete"](String(name).toLowerCase());
    };

    // Sorted, combined [name, value] list — the iteration order browsers use.
    Headers.prototype._sortedEntries = function _sortedEntries() {
      var names = Array.from(this._map.keys()).sort();
      var out = [];
      for (var i = 0; i < names.length; i++) {
        out.push([names[i], this._map.get(names[i]).join(", ")]);
      }
      return out;
    };

    Headers.prototype.forEach = function forEach(cb, thisArg) {
      var entries = this._sortedEntries();
      for (var i = 0; i < entries.length; i++) {
        cb.call(thisArg, entries[i][1], entries[i][0], this);
      }
    };

    Headers.prototype.entries = function entries() {
      return this._sortedEntries()[Symbol.iterator]();
    };

    Headers.prototype.keys = function keys() {
      return this._sortedEntries()
        .map(function (e) {
          return e[0];
        })
        [Symbol.iterator]();
    };

    Headers.prototype.values = function values() {
      return this._sortedEntries()
        .map(function (e) {
          return e[1];
        })
        [Symbol.iterator]();
    };

    Headers.prototype[Symbol.iterator] = Headers.prototype.entries;

    g.Headers = Headers;
  }

  // ===========================================================================
  // Blob — backed by a single concatenated Buffer. `parts` is an array whose
  // elements may be strings, ArrayBuffers, TypedArrays/DataViews, or other Blobs.
  // ===========================================================================
  if (typeof g.Blob === "undefined") {
    var Blob = function Blob(parts, options) {
      options = options || {};
      var chunks = [];
      if (parts != null) {
        if (!Array.isArray(parts) && typeof parts[Symbol.iterator] !== "function") {
          throw new TypeError("Blob parts must be iterable");
        }
        var list = Array.isArray(parts) ? parts : Array.from(parts);
        for (var i = 0; i < list.length; i++) {
          var part = list[i];
          if (part == null) {
            chunks.push(utf8Encode(String(part))); // "null"/"undefined"
          } else if (typeof part === "string") {
            chunks.push(utf8Encode(part));
          } else if (isBlob(part)) {
            chunks.push(part._buffer);
          } else {
            var bin = bufferFromBinary(part);
            chunks.push(bin !== null ? bin : utf8Encode(String(part)));
          }
        }
      }
      // Single contiguous backing store.
      this._buffer = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
      this.type = options.type ? String(options.type).toLowerCase() : "";
      this.size = this._buffer.length;
    };

    Blob.prototype.arrayBuffer = function arrayBuffer() {
      return Promise.resolve(bufferToArrayBuffer(this._buffer));
    };

    Blob.prototype.bytes = function bytes() {
      var buf = this._buffer;
      return Promise.resolve(new Uint8Array(bufferToArrayBuffer(buf)));
    };

    Blob.prototype.text = function text() {
      return Promise.resolve(utf8Decode(this._buffer));
    };

    Blob.prototype.slice = function slice(start, end, contentType) {
      var size = this._buffer.length;
      // Normalize the (possibly negative / out-of-range) start/end like the spec.
      var relStart =
        start === undefined ? 0 : start < 0 ? Math.max(size + start, 0) : Math.min(start, size);
      var relEnd =
        end === undefined ? size : end < 0 ? Math.max(size + end, 0) : Math.min(end, size);
      var span = Math.max(relEnd - relStart, 0);
      var sliced = Buffer.alloc(span);
      this._buffer.copy(sliced, 0, relStart, relStart + span);
      var blob = new Blob([], { type: contentType !== undefined ? contentType : "" });
      blob._buffer = sliced;
      blob.size = sliced.length;
      return blob;
    };

    // Minimal stream(): yields the whole buffer as one chunk. Good enough for
    // `for await` consumers without a full ReadableStream implementation.
    Blob.prototype.stream = function stream() {
      var buffer = this._buffer;
      var iterator = {};
      iterator[Symbol.asyncIterator] = function () {
        var done = false;
        return {
          next: function () {
            if (done) return Promise.resolve({ value: undefined, done: true });
            done = true;
            return Promise.resolve({
              value: new Uint8Array(bufferToArrayBuffer(buffer)),
              done: false,
            });
          },
        };
      };
      return iterator;
    };

    Blob.prototype[Symbol.toStringTag] = "Blob";

    g.Blob = Blob;
  }

  // ===========================================================================
  // File extends Blob — adds `name` and `lastModified`.
  // ===========================================================================
  if (typeof g.File === "undefined") {
    var File = function File(parts, name, options) {
      options = options || {};
      g.Blob.call(this, parts, options);
      this.name = String(name);
      this.lastModified =
        options.lastModified !== undefined ? Number(options.lastModified) : Date.now();
    };
    File.prototype = Object.create(g.Blob.prototype);
    File.prototype.constructor = File;
    File.prototype[Symbol.toStringTag] = "File";
    g.File = File;
  }

  // ===========================================================================
  // FormData — ordered list of [name, value] entries. Values are either strings
  // or Blob/File. `append` with a filename wraps a Blob value in a File.
  // ===========================================================================
  if (typeof g.FormData === "undefined") {
    function normalizeFormValue(value, filename) {
      if (isBlob(value)) {
        // If a filename is supplied (or value is already a File), expose a File.
        if (filename !== undefined) {
          var f = new g.File([value._buffer], String(filename), { type: value.type });
          return f;
        }
        return value;
      }
      return String(value);
    }

    var FormData = function FormData() {
      this._entries = []; // Array<[name, value]>.
    };

    FormData.prototype.append = function append(name, value, filename) {
      this._entries.push([String(name), normalizeFormValue(value, filename)]);
    };

    FormData.prototype.set = function set(name, value, filename) {
      var key = String(name);
      var normalized = normalizeFormValue(value, filename);
      var replaced = false;
      var next = [];
      for (var i = 0; i < this._entries.length; i++) {
        if (this._entries[i][0] === key) {
          if (!replaced) {
            next.push([key, normalized]);
            replaced = true;
          }
          // drop other matches
        } else {
          next.push(this._entries[i]);
        }
      }
      if (!replaced) next.push([key, normalized]);
      this._entries = next;
    };

    FormData.prototype.get = function get(name) {
      var key = String(name);
      for (var i = 0; i < this._entries.length; i++) {
        if (this._entries[i][0] === key) return this._entries[i][1];
      }
      return null;
    };

    FormData.prototype.getAll = function getAll(name) {
      var key = String(name);
      var out = [];
      for (var i = 0; i < this._entries.length; i++) {
        if (this._entries[i][0] === key) out.push(this._entries[i][1]);
      }
      return out;
    };

    FormData.prototype.has = function has(name) {
      var key = String(name);
      for (var i = 0; i < this._entries.length; i++) {
        if (this._entries[i][0] === key) return true;
      }
      return false;
    };

    FormData.prototype["delete"] = function del(name) {
      var key = String(name);
      this._entries = this._entries.filter(function (e) {
        return e[0] !== key;
      });
    };

    FormData.prototype.entries = function entries() {
      return this._entries
        .map(function (e) {
          return [e[0], e[1]];
        })
        [Symbol.iterator]();
    };

    FormData.prototype.keys = function keys() {
      return this._entries
        .map(function (e) {
          return e[0];
        })
        [Symbol.iterator]();
    };

    FormData.prototype.values = function values() {
      return this._entries
        .map(function (e) {
          return e[1];
        })
        [Symbol.iterator]();
    };

    FormData.prototype.forEach = function forEach(cb, thisArg) {
      for (var i = 0; i < this._entries.length; i++) {
        cb.call(thisArg, this._entries[i][1], this._entries[i][0], this);
      }
    };

    FormData.prototype[Symbol.iterator] = FormData.prototype.entries;

    g.FormData = FormData;
  }

  // ===========================================================================
  // Body mixin — shared body normalization and accessors for Request/Response.
  //
  // We normalize any supported body source to { buffer: Buffer|null, type } at
  // construction time, then the accessors (text/json/arrayBuffer/bytes/blob)
  // read from that buffer exactly once (guarded by bodyUsed).
  // ===========================================================================

  // Returns { buffer: Buffer|null, contentType: string|null }.
  function extractBody(body) {
    if (body == null) {
      return { buffer: null, contentType: null };
    }
    if (typeof body === "string") {
      return { buffer: utf8Encode(body), contentType: "text/plain;charset=UTF-8" };
    }
    if (g.URLSearchParams && body instanceof g.URLSearchParams) {
      return {
        buffer: utf8Encode(body.toString()),
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
      };
    }
    if (isBlob(body)) {
      return {
        buffer: Buffer.from(body._buffer),
        contentType: body.type ? body.type : null,
      };
    }
    if (Buffer.isBuffer(body)) {
      return { buffer: Buffer.from(body), contentType: null };
    }
    var bin = bufferFromBinary(body);
    if (bin !== null) {
      return { buffer: bin, contentType: null };
    }
    // Fallback: stringify.
    return { buffer: utf8Encode(String(body)), contentType: "text/plain;charset=UTF-8" };
  }

  // Install the body accessor methods onto a prototype. `getState` returns the
  // internal { buffer, bodyUsed } record for a given instance.
  function defineBodyAccessors(proto) {
    function consume(self) {
      if (self.bodyUsed) {
        return Promise.reject(new TypeError("Body has already been consumed"));
      }
      self.bodyUsed = true;
      // Empty body reads as an empty buffer.
      return Promise.resolve(self._bodyBuffer || Buffer.alloc(0));
    }

    proto.arrayBuffer = function arrayBuffer() {
      return consume(this).then(function (buf) {
        return bufferToArrayBuffer(buf);
      });
    };

    proto.bytes = function bytes() {
      return consume(this).then(function (buf) {
        return new Uint8Array(bufferToArrayBuffer(buf));
      });
    };

    proto.text = function text() {
      return consume(this).then(function (buf) {
        return utf8Decode(buf);
      });
    };

    proto.json = function json() {
      return consume(this).then(function (buf) {
        return JSON.parse(utf8Decode(buf));
      });
    };

    proto.blob = function blob() {
      var type = this.headers.get("content-type") || "";
      return consume(this).then(function (buf) {
        var b = new g.Blob([], { type: type });
        b._buffer = Buffer.from(buf);
        b.size = b._buffer.length;
        return b;
      });
    };
  }

  // ===========================================================================
  // Request
  // ===========================================================================
  if (typeof g.Request === "undefined") {
    var Request = function Request(input, init) {
      init = init || {};

      var url, method, headers, body, redirect, signal;

      if (input instanceof Request) {
        url = input.url;
        method = input.method;
        headers = new g.Headers(input.headers);
        body = init.body !== undefined ? init.body : input._sourceBody;
        redirect = input.redirect;
        signal = input.signal;
      } else {
        // input is a URL or string.
        url = input instanceof g.URL ? input.href : String(input);
        method = "GET";
        headers = new g.Headers();
        body = init.body;
        redirect = "follow";
        signal = null;
      }

      if (init.method !== undefined) method = String(init.method).toUpperCase();
      else if (typeof method === "string") method = method.toUpperCase();
      if (init.headers !== undefined) headers = new g.Headers(init.headers);
      if (init.redirect !== undefined) redirect = init.redirect;
      if (init.signal !== undefined) signal = init.signal;

      this.url = url;
      this.method = method || "GET";
      this.headers = headers;
      this.redirect = redirect || "follow";
      this.signal = signal || null;
      this.bodyUsed = false;

      // Normalize the body to bytes; keep the original for clone().
      this._sourceBody = body;
      var extracted = extractBody(body);
      this._bodyBuffer = extracted.buffer;
      this.body = extracted.buffer; // simplistic: expose bytes (no ReadableStream)
      if (extracted.contentType && !this.headers.has("content-type")) {
        this.headers.set("content-type", extracted.contentType);
      }
    };

    defineBodyAccessors(Request.prototype);

    Request.prototype.clone = function clone() {
      if (this.bodyUsed) {
        throw new TypeError("Cannot clone a Request whose body is already used");
      }
      return new Request(this.url, {
        method: this.method,
        headers: new g.Headers(this.headers),
        body: this._sourceBody,
        redirect: this.redirect,
        signal: this.signal,
      });
    };

    Request.prototype[Symbol.toStringTag] = "Request";

    g.Request = Request;
  }

  // ===========================================================================
  // Response
  // ===========================================================================
  if (typeof g.Response === "undefined") {
    var Response = function Response(body, init) {
      init = init || {};

      var status = init.status !== undefined ? init.status : 200;
      this.status = status;
      this.statusText = init.statusText !== undefined ? String(init.statusText) : "";
      this.ok = status >= 200 && status <= 299;
      this.headers = new g.Headers(init.headers);
      this.bodyUsed = false;
      this.redirected = false;
      this.type = "default";
      this.url = init.url !== undefined ? String(init.url) : "";

      // Normalize the body to bytes and set a heuristic Content-Type if the
      // caller did not already supply one.
      this._sourceBody = body;
      var extracted = extractBody(body);
      this._bodyBuffer = extracted.buffer;
      this.body = extracted.buffer;
      if (extracted.contentType && !this.headers.has("content-type")) {
        this.headers.set("content-type", extracted.contentType);
      }
    };

    defineBodyAccessors(Response.prototype);

    // formData() — best-effort parse of urlencoded / multipart bodies.
    Response.prototype.formData = function formData() {
      var ct = this.headers.get("content-type") || "";
      var self = this;
      return this.text().then(function (text) {
        var fd = new g.FormData();
        if (ct.indexOf("application/x-www-form-urlencoded") !== -1) {
          var params = new g.URLSearchParams(text);
          params.forEach(function (value, key) {
            fd.append(key, value);
          });
        } else {
          // Multipart and other types are not parsed; return an empty FormData.
          void self;
        }
        return fd;
      });
    };

    Response.prototype.clone = function clone() {
      if (this.bodyUsed) {
        throw new TypeError("Cannot clone a Response whose body is already used");
      }
      var cloned = new Response(null, {
        status: this.status,
        statusText: this.statusText,
        headers: new g.Headers(this.headers),
        url: this.url,
      });
      cloned._sourceBody = this._sourceBody;
      cloned._bodyBuffer = this._bodyBuffer ? Buffer.from(this._bodyBuffer) : null;
      cloned.body = cloned._bodyBuffer;
      cloned.redirected = this.redirected;
      cloned.type = this.type;
      return cloned;
    };

    Response.prototype[Symbol.toStringTag] = "Response";

    // Static: Response.json(data, init) — serialize JSON with the proper type.
    Response.json = function json(data, init) {
      init = init || {};
      var headers = new g.Headers(init.headers);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      return new Response(JSON.stringify(data), {
        status: init.status !== undefined ? init.status : 200,
        statusText: init.statusText,
        headers: headers,
      });
    };

    // Static: Response.error() — a network-error response.
    Response.error = function error() {
      var res = new Response(null, { status: 0, statusText: "" });
      res.type = "error";
      res.ok = false;
      return res;
    };

    // Static: Response.redirect(url, status) — a redirect response.
    Response.redirect = function redirect(url, status) {
      status = status === undefined ? 302 : status;
      if ([301, 302, 303, 307, 308].indexOf(status) === -1) {
        throw new RangeError("Invalid redirect status code");
      }
      var res = new Response(null, { status: status });
      res.headers.set(
        "location",
        url instanceof g.URL ? url.href : String(url),
      );
      return res;
    };

    g.Response = Response;
  }
})();

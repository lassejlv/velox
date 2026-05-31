// The `Velox` global — a curated, batteries-included API surface, plus a global
// CommonJS-style `require` for `node:` builtins. Evaluated at startup after the
// other preludes (so `process`, `Buffer`, `fetch`, `Request`/`Response` exist).
//
// `node:` builtins are loaded lazily: `__velox_load_builtin(name)` returns the
// shim source, which we evaluate once as a CommonJS module and cache. Velox.fs,
// Velox.path, … are getters over that loader, so nothing is paid until touched.
(function () {
  var cache = Object.create(null);

  function builtinRequire(spec) {
    spec = String(spec);
    var key = spec.indexOf('node:') === 0 ? spec.slice(5) : spec;
    if (key in cache) return cache[key];
    var src = __velox_load_builtin(key);
    if (!src) throw new Error("Cannot find module '" + spec + "'");
    var module = { exports: {} };
    cache[key] = module.exports; // seed cache before running, for cycles
    try {
      // eslint-disable-next-line no-new-func
      var fn = new Function('module', 'exports', 'require', src);
      fn(module, module.exports, builtinRequire);
    } catch (e) {
      delete cache[key];
      throw e;
    }
    cache[key] = module.exports;
    return module.exports;
  }

  // A global require for builtins. The bundle's own scoped `require` shadows this
  // inside modules; this serves CommonJS-style `require('node:fs')` in user code
  // that wasn't import-bundled, plus vm/eval contexts.
  globalThis.__velox_builtin_require = builtinRequire;
  if (typeof globalThis.require === 'undefined') globalThis.require = builtinRequire;

  // --- web-style serve() helpers (Bun/Deno-flavored) ---------------------------
  function collectBody(req, cb) {
    var chunks = [];
    req.on('data', function (c) { chunks.push(c); });
    req.on('end', function () { cb(globalThis.Buffer.concat(chunks)); });
    req.on('error', function () { cb(globalThis.Buffer.alloc(0)); });
  }
  function toRequest(req, body) {
    var host = (req.headers && req.headers.host) || 'localhost';
    var init = { method: req.method, headers: req.headers };
    if (req.method !== 'GET' && req.method !== 'HEAD' && body && body.length) init.body = body;
    return new Request('http://' + host + req.url, init);
  }
  function sendResponse(res, response) {
    if (response == null) { res.statusCode = 200; res.end(); return; }
    Promise.resolve(response).then(function (r) {
      var headers = {};
      if (r.headers && r.headers.forEach) r.headers.forEach(function (v, k) { headers[k] = v; });
      return r.arrayBuffer().then(function (buf) {
        res.writeHead(r.status || 200, headers);
        res.end(globalThis.Buffer.from(buf));
      });
    }).catch(function (e) {
      try { res.writeHead(500); res.end('Internal Server Error'); } catch (_) {}
      if (globalThis.console) console.error(e);
    });
  }

  function serve(portOrOpts, handler) {
    var opts = (portOrOpts && typeof portOrOpts === 'object') ? portOrOpts : { port: portOrOpts };
    var port = opts.port == null ? 3000 : opts.port;
    var http = opts.tls ? builtinRequire('node:https') : builtinRequire('node:http');
    var server;
    var webHandler = opts.fetch || (typeof handler === 'function' && handler.length <= 1 ? handler : null);
    var nodeHandler = (typeof handler === 'function' && handler.length >= 2) ? handler : opts.handler;

    if (nodeHandler) {
      server = opts.tls ? http.createServer(opts.tls, nodeHandler) : http.createServer(nodeHandler);
    } else if (webHandler) {
      var onReq = function (req, res) {
        collectBody(req, function (body) { sendResponse(res, webHandler(toRequest(req, body), { req: req, res: res })); });
      };
      server = opts.tls ? http.createServer(opts.tls, onReq) : http.createServer(onReq);
    } else if (opts.websocket) {
      // WebSocket-only server: plain HTTP requests get 426 Upgrade Required.
      server = http.createServer(function (req, res) { res.writeHead(426); res.end('Upgrade Required'); });
    } else {
      throw new TypeError('Velox.serve requires a handler (req,res), { fetch }, or { websocket }');
    }
    // Bun/Deno-style WebSocket support: `Velox.serve({ websocket: { open, message,
    // close }, ... })` attaches a WebSocketServer to the same HTTP server.
    if (opts.websocket) {
      var WS = builtinRequire('ws');
      var wss = new WS.WebSocketServer({ server: server });
      var h = opts.websocket;
      wss.on('connection', function (ws, req) {
        ws.data = {};
        if (h.open) h.open(ws, req);
        ws.on('message', function (data, isBinary) { if (h.message) h.message(ws, data, isBinary); });
        ws.on('close', function (code, reason) { if (h.close) h.close(ws, code, reason); });
        ws.on('error', function (e) { if (h.error) h.error(ws, e); });
      });
      server._wss = wss;
    }
    server.listen(port, opts.hostname, function () {
      if (opts.onListen) opts.onListen({ port: port, hostname: opts.hostname || 'localhost' });
    });
    return server;
  }

  // The Velox global is itself callable: `Velox(handler)` is shorthand for serve.
  var Velox = function (portOrOpts, handler) { return serve(portOrOpts, handler); };

  var props = {
    version: { value: '0.1.0', enumerable: true },
    require: { value: builtinRequire, enumerable: true },
    serve: { value: serve, enumerable: true },
    process: { get: function () { return globalThis.process; }, enumerable: true },
    Buffer: { get: function () { return globalThis.Buffer; }, enumerable: true },
    env: { get: function () { return globalThis.process.env; }, enumerable: true },
    args: { get: function () { return (globalThis.process.argv || []).slice(2); }, enumerable: true },
    cwd: { value: function () { return globalThis.process.cwd(); }, enumerable: true },
    exit: { value: function (code) { return globalThis.process.exit(code); }, enumerable: true },
    fetch: { value: function () { return globalThis.fetch.apply(null, arguments); }, enumerable: true },

    // file conveniences over node:fs (sync + promise flavors)
    readTextSync: { value: function (p) { return builtinRequire('node:fs').readFileSync(p, 'utf8'); }, enumerable: true },
    writeTextSync: { value: function (p, d) { return builtinRequire('node:fs').writeFileSync(p, d); }, enumerable: true },
    readBytesSync: { value: function (p) { return builtinRequire('node:fs').readFileSync(p); }, enumerable: true },
    readText: { value: function (p) { return builtinRequire('node:fs').promises.readFile(p, 'utf8'); }, enumerable: true },
    writeText: { value: function (p, d) { return builtinRequire('node:fs').promises.writeFile(p, d); }, enumerable: true },
  };
  Object.defineProperties(Velox, props);

  // Lazy module accessors: Velox.fs, Velox.path, Velox.url, Velox.os, …
  ['fs', 'path', 'url', 'os', 'crypto', 'http', 'https', 'net', 'tls', 'stream',
    'zlib', 'dns', 'child_process', 'util', 'events', 'assert', 'querystring', 'vm']
    .forEach(function (name) {
      Object.defineProperty(Velox, name, {
        get: function () { return builtinRequire('node:' + name); },
        enumerable: true,
      });
    });

  globalThis.Velox = Velox;
})();

// node:https — HTTPS client built on the TLS-aware http client. (HTTPS *server*
// TLS termination is not supported yet.)
var http = require("node:http");

// Forward the request(url[, options][, callback]) / request(options[, callback])
// overloads to the http client, injecting `_tls: true` so the connection uses
// TLS even when the URL/options don't carry an https: scheme.
function request(url, options, cb) {
  if (url && typeof url === "object" && !(typeof URL !== "undefined" && url instanceof URL)) {
    // request(options[, callback])
    return http.request(Object.assign({}, url, { _tls: true }), options);
  }
  // request(url[, options][, callback])
  if (typeof options === "function") { cb = options; options = undefined; }
  return http.request(url, Object.assign({}, options || {}, { _tls: true }), cb);
}
function get(url, options, cb) {
  var req = request(url, options, cb);
  req.end();
  return req;
}
function createServer(options, requestListener) {
  if (typeof options === "function") { requestListener = options; options = {}; }
  options = options || {};
  var server = http.createServer(requestListener);
  // Terminate TLS on the underlying net server. Empty cert/key → self-signed.
  server._net._tlsOptions = {
    cert: options.cert ? String(options.cert) : "",
    key: options.key ? String(options.key) : "",
  };
  return server;
}

function Agent() {}
module.exports = {
  request: request,
  get: get,
  createServer: createServer,
  Agent: Agent,
  globalAgent: new Agent(),
  Server: http.Server,
  STATUS_CODES: http.STATUS_CODES,
  METHODS: http.METHODS,
  ClientRequest: http.ClientRequest,
  IncomingMessage: http.IncomingMessage,
};
module.exports.default = module.exports;

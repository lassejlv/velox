// node:https — HTTPS client built on the TLS-aware http client. (HTTPS *server*
// TLS termination is not supported yet.)
var http = require("node:http");

function withTls(options) {
  if (typeof options === "string" || (typeof URL !== "undefined" && options instanceof URL)) {
    return options; // a URL string/object already carries the https:// scheme
  }
  return Object.assign({}, options, { _tls: true });
}

function request(options, cb) {
  return http.request(withTls(options), cb);
}
function get(options, cb) {
  var req = request(options, cb);
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

// Legacy `_http_*` module surface (pre-`node:http` internals that npm packages
// and Node tests still require directly). Everything re-exports node:http.
var http = require('node:http');
module.exports = {
  Agent: http.Agent,
  globalAgent: http.globalAgent,
  ClientRequest: http.ClientRequest,
  IncomingMessage: http.IncomingMessage,
  OutgoingMessage: http.OutgoingMessage || http.ServerResponse,
  ServerResponse: http.ServerResponse,
  Server: http.Server,
  STATUS_CODES: http.STATUS_CODES,
  METHODS: http.METHODS,
  CRLF: '\r\n',
  chunkExpression: /(?:^|\W)chunked(?:$|\W)/i,
  continueExpression: /(?:^|\W)100-continue(?:$|\W)/i,
  _connectionListener: function () {},
};
module.exports.default = module.exports;

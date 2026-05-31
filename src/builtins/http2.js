// node:http2 — a stub so frameworks that `require('http2')` at load time
// (fastify, etc.) import cleanly. Full HTTP/2 is not implemented; the server
// factories throw if actually used (callers opt in via an `http2: true` option).

var constants = {
  HTTP2_HEADER_PATH: ':path',
  HTTP2_HEADER_METHOD: ':method',
  HTTP2_HEADER_STATUS: ':status',
  HTTP2_HEADER_AUTHORITY: ':authority',
  HTTP2_HEADER_SCHEME: ':scheme',
  HTTP2_HEADER_CONTENT_TYPE: 'content-type',
  HTTP2_HEADER_CONTENT_LENGTH: 'content-length',
  HTTP2_METHOD_GET: 'GET',
  HTTP2_METHOD_POST: 'POST',
  NGHTTP2_NO_ERROR: 0,
  NGHTTP2_CANCEL: 8,
  HTTP_STATUS_OK: 200,
  HTTP_STATUS_NOT_FOUND: 404,
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,
};

function unsupported() {
  throw new Error('node:http2 is not implemented in velox (use http/https; HTTP/2 servers are unsupported)');
}

module.exports = {
  constants: constants,
  createServer: unsupported,
  createSecureServer: unsupported,
  connect: unsupported,
  getDefaultSettings: function () { return {}; },
  getPackedSettings: function () { return Buffer.alloc(0); },
  getUnpackedSettings: function () { return {}; },
  sensitiveHeaders: Symbol('nodejs.http2.sensitiveHeaders'),
  Http2ServerRequest: function () {},
  Http2ServerResponse: function () {},
};
module.exports.default = module.exports;

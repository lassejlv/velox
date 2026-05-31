// node:stream/promises — the promise-based pipeline()/finished(). Without this
// dedicated subpath, `require('node:stream/promises')` would fall back to the
// base `stream` module and hand back the *callback* pipeline (which returns no
// promise, so `await pipeline(...)` resolves before piping completes).

var stream = require('node:stream');

module.exports = {
  pipeline: stream.promises.pipeline,
  finished: stream.promises.finished,
};
module.exports.default = module.exports;

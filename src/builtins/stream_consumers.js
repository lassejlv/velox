// node:stream/consumers — consume a stream (Node Readable, Web ReadableStream,
// or any async iterable) fully into a single value.
'use strict';

async function collect(stream) {
  var chunks = [];
  if (stream && typeof stream.getReader === 'function') {
    // Web ReadableStream.
    var reader = stream.getReader();
    try {
      while (true) {
        var r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    // Node Readable / async iterable.
    for await (var chunk of stream) chunks.push(chunk);
  }
  return chunks;
}

function toBuffer(chunks) {
  var bufs = chunks.map(function (c) {
    if (Buffer.isBuffer(c)) return c;
    if (typeof c === 'string') return Buffer.from(c, 'utf8');
    if (ArrayBuffer.isView(c)) return Buffer.from(c.buffer, c.byteOffset, c.byteLength);
    if (c instanceof ArrayBuffer) return Buffer.from(c);
    return Buffer.from(String(c), 'utf8');
  });
  return Buffer.concat(bufs);
}

async function buffer(stream) {
  return toBuffer(await collect(stream));
}
async function text(stream) {
  return (await buffer(stream)).toString('utf8');
}
async function json(stream) {
  return JSON.parse(await text(stream));
}
async function arrayBuffer(stream) {
  var b = await buffer(stream);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}
async function blob(stream) {
  return new Blob([await buffer(stream)]);
}

module.exports = {
  buffer: buffer,
  text: text,
  json: json,
  arrayBuffer: arrayBuffer,
  blob: blob,
};
module.exports.default = module.exports;

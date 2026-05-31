// node:tty — terminal detection + minimal stream stubs.

exports.isatty = function (fd) {
  return typeof __velox_isatty === 'function' ? !!__velox_isatty(fd) : false;
};

function ReadStream(fd) {
  this.fd = fd;
  this.isRaw = false;
  this.isTTY = exports.isatty(fd);
}
ReadStream.prototype.setRawMode = function () { return this; };

function WriteStream(fd) {
  this.fd = fd;
  this.columns = 80;
  this.rows = 24;
  this.isTTY = exports.isatty(fd);
}
WriteStream.prototype.write = function (chunk) {
  var p = globalThis.process;
  var stream = this.fd === 2 ? (p && p.stderr) : (p && p.stdout);
  return stream ? stream.write(chunk) : false;
};
WriteStream.prototype.getColorDepth = function () { return exports.isatty(this.fd) ? 8 : 1; };
WriteStream.prototype.hasColors = function () { return exports.isatty(this.fd); };

exports.ReadStream = ReadStream;
exports.WriteStream = WriteStream;

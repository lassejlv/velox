// node:tls — TLS client sockets, built on net with the host's TLS transport.
var net = require("node:net");

function connect(port, host, options, cb) {
  // Normalize (port[, host][, options][, cb]) and (options[, cb]).
  if (typeof port === "object" && port !== null) { cb = host; options = port; }
  else {
    if (typeof host === "function") { cb = host; host = undefined; options = {}; }
    else if (typeof host === "object") { cb = options; options = host; host = undefined; }
    else if (typeof options === "function") { cb = options; options = {}; }
    options = options || {};
    options.port = port;
    if (host) options.host = host;
  }
  options = Object.assign({}, options, { tls: true });
  if (options.host == null && options.servername) options.host = options.servername;
  var socket = new net.Socket();
  if (typeof cb === "function") socket.once("secureConnect", cb);
  socket.once("connect", function () {
    socket.authorized = true;
    socket.encrypted = true;
    socket.emit("secureConnect");
  });
  socket.connect(options);
  return socket;
}

// tls.Server — a net.Server subclass. velox's HTTPS server drives TLS itself, so
// this is mostly a real constructor for `instanceof` checks (supertest does
// `app instanceof tls.Server` to choose http vs https) and for libraries that
// subclass it. createServer wires the secureConnection→connection alias.
function Server(options, secureConnectionListener) {
  if (!(this instanceof Server)) return new Server(options, secureConnectionListener);
  if (typeof options === "function") { secureConnectionListener = options; options = {}; }
  net.Server.call(this, options);
  if (typeof secureConnectionListener === "function") {
    this.on("secureConnection", secureConnectionListener);
    this.on("connection", function (socket) {
      socket.authorized = true;
      socket.encrypted = true;
      this.emit("secureConnection", socket);
    });
  }
}
Server.prototype = Object.create(net.Server.prototype);
Server.prototype.constructor = Server;
Server.prototype.setSecureContext = function () {};
Server.prototype.addContext = function () {};

function createServer(options, secureConnectionListener) {
  return new Server(options, secureConnectionListener);
}

module.exports = {
  connect: connect,
  Server: Server,
  createServer: createServer,
  TLSSocket: net.Socket,
  rootCertificates: [],
  DEFAULT_MIN_VERSION: "TLSv1.2",
  DEFAULT_MAX_VERSION: "TLSv1.3",
  createSecureContext: function () { return {}; },
  checkServerIdentity: function () { return undefined; },
};
module.exports.default = module.exports;

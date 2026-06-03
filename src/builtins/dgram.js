// node:dgram — UDP datagram sockets over the native reactor (src/udp.rs).
var EventEmitter = require('node:events').EventEmitter;
var Buffer = globalThis.Buffer;

function nextTick(fn) {
  if (typeof process !== 'undefined' && process.nextTick) process.nextTick(fn);
  else Promise.resolve().then(fn);
}

// id -> Socket, for the native message dispatch.
var sockets = Object.create(null);
globalThis.__velox_on_udp = function (id, dataLatin1, addr, port) {
  var s = sockets[id];
  if (!s) return;
  var msg = Buffer.from(dataLatin1, 'latin1');
  s.emit('message', msg, {
    address: addr,
    family: addr.indexOf(':') !== -1 ? 'IPv6' : 'IPv4',
    port: port,
    size: msg.length,
  });
};

function Socket(type, listener) {
  EventEmitter.call(this);
  if (type && typeof type === 'object') { listener = type.listener; this.type = type.type || 'udp4'; }
  else this.type = type || 'udp4';
  if (typeof listener === 'function') this.on('message', listener);
  this._id = null;
  this._bound = false;
}
Socket.prototype = Object.create(EventEmitter.prototype);
Socket.prototype.constructor = Socket;

Socket.prototype._ensureBound = function () {
  if (this._bound) return;
  this._id = __velox_udp_bind(0, ''); // auto-bind to an ephemeral port
  sockets[this._id] = this;
  this._bound = true;
};

// bind([port][, address][, callback])  |  bind({ port, address }, callback)
Socket.prototype.bind = function (port, address, callback) {
  var self = this;
  if (port && typeof port === 'object') { var o = port; callback = address; port = o.port; address = o.address; }
  if (typeof port === 'function') { callback = port; port = 0; address = undefined; }
  if (typeof address === 'function') { callback = address; address = undefined; }
  try {
    this._id = __velox_udp_bind(port || 0, address || '');
    sockets[this._id] = this;
    this._bound = true;
  } catch (e) {
    nextTick(function () { self.emit('error', e); });
    return this;
  }
  if (typeof callback === 'function') this.once('listening', callback);
  nextTick(function () { self.emit('listening'); });
  return this;
};

// send(msg, [offset, length,] port [, address] [, callback])
Socket.prototype.send = function (msg, a2, a3, a4, a5, a6) {
  // Node validates the message type synchronously (ERR_INVALID_ARG_TYPE).
  if (typeof msg !== 'string' && !Buffer.isBuffer(msg) &&
      !ArrayBuffer.isView(msg) && !Array.isArray(msg)) {
    throw require('node:util')._veloxErr.errInvalidArgType(
      'The "msg" argument must be of type string or an instance of Buffer, TypedArray, or DataView.',
      msg);
  }
  var offset = 0, length, port, address, callback;
  if (Buffer.isBuffer(msg) && typeof a2 === 'number' && typeof a3 === 'number') {
    offset = a2; length = a3; port = a4; address = a5; callback = a6;
  } else {
    port = a2; address = a3; callback = a4;
  }
  if (typeof address === 'function') { callback = address; address = undefined; }

  var self = this;
  var buf;
  if (Buffer.isBuffer(msg)) buf = msg;
  else if (Array.isArray(msg)) buf = Buffer.concat(msg.map(function (m) { return Buffer.isBuffer(m) ? m : Buffer.from(String(m)); }));
  else buf = Buffer.from(String(msg), 'utf8');
  if (length !== undefined) buf = buf.subarray(offset, offset + length);

  this._ensureBound();
  try {
    __velox_udp_send(this._id, buf.toString('latin1'), port, address || '127.0.0.1');
    if (typeof callback === 'function') nextTick(function () { callback(null); });
  } catch (e) {
    if (typeof callback === 'function') nextTick(function () { callback(e); });
    else nextTick(function () { self.emit('error', e); });
  }
  return this;
};

// Legacy alias (pre-0.10): same path as send, which validates the msg type.
Socket.prototype.sendto = function (msg, offset, length, port, address, callback) {
  return this.send(msg, offset, length, port, address, callback);
};

Socket.prototype.address = function () {
  var s = this._id != null ? __velox_udp_address(this._id) : '';
  var idx = s.lastIndexOf(':');
  if (idx === -1) return { address: '0.0.0.0', port: 0, family: 'IPv4' };
  var host = s.slice(0, idx);
  return { address: host, port: parseInt(s.slice(idx + 1), 10) || 0, family: host.indexOf(':') !== -1 ? 'IPv6' : 'IPv4' };
};

Socket.prototype.close = function (callback) {
  var self = this;
  if (typeof callback === 'function') this.once('close', callback);
  if (this._id != null) { __velox_udp_close(this._id); delete sockets[this._id]; this._bound = false; }
  nextTick(function () { self.emit('close'); });
  return this;
};

Socket.prototype.setBroadcast = function (on) { if (this._id != null) __velox_udp_set_broadcast(this._id, !!on); };
Socket.prototype.setTTL = function () { return this; };
Socket.prototype.setMulticastTTL = function () { return this; };
Socket.prototype.setMulticastLoopback = function () { return this; };
Socket.prototype.setMulticastInterface = function () { return this; };
Socket.prototype.addMembership = function () {};
Socket.prototype.dropMembership = function () {};
Socket.prototype.connect = function (port, address, callback) {
  // velox sends are connectionless; record the remote and fire 'connect'.
  if (typeof address === 'function') { callback = address; address = undefined; }
  this._remotePort = port; this._remoteAddress = address || '127.0.0.1';
  this._ensureBound();
  var self = this;
  if (typeof callback === 'function') this.once('connect', callback);
  nextTick(function () { self.emit('connect'); });
  return this;
};
Socket.prototype.remoteAddress = function () {
  if (this._remotePort == null) throw new Error('Not connected');
  return { address: this._remoteAddress, port: this._remotePort, family: 'IPv4' };
};
Socket.prototype.disconnect = function () { this._remotePort = null; };
Socket.prototype.ref = function () { return this; };
Socket.prototype.unref = function () { return this; };

function createSocket(type, listener) { return new Socket(type, listener); }

module.exports = { createSocket: createSocket, Socket: Socket };
module.exports.default = module.exports;

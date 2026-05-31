// node:dns — name resolution backed by the native __velox_dns_lookup bridge,
// which is a thin wrapper over the system getaddrinfo. Because getaddrinfo is
// all we have, resolve/resolve4/resolve6 are implemented on top of lookup
// rather than issuing real record (A/AAAA/etc.) queries.

// --- native call -----------------------------------------------------------

// Returns an array of { address, family } (family is 4 or 6). Throws ENOTFOUND
// on failure. `family` is 0 (any), 4, or 6.
function nativeLookup(hostname, family) {
  // Fast-path the loopback name so it works even without a resolver.
  if (hostname === 'localhost') {
    if (family === 6) return [{ address: '::1', family: 6 }];
    if (family === 4) return [{ address: '127.0.0.1', family: 4 }];
    return [{ address: '127.0.0.1', family: 4 }];
  }
  return JSON.parse(__velox_dns_lookup(String(hostname), family | 0));
}

// Build a Node-style dns error with a `code`/`errno`/`hostname`.
function dnsError(code, syscall, hostname) {
  var err = new Error(code + ' ' + syscall + ' ' + hostname);
  err.code = code;
  err.errno = code;
  err.syscall = syscall;
  err.hostname = hostname;
  return err;
}

// --- lookup ----------------------------------------------------------------

function lookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  if (typeof options === 'number') options = { family: options };
  options = options || {};
  var family = options.family || 0;

  queueMicrotask(function () {
    var results;
    try { results = nativeLookup(hostname, family); }
    catch (e) {
      if (!e.code) e = dnsError('ENOTFOUND', 'getaddrinfo', String(hostname));
      cb(e);
      return;
    }
    if (!results || results.length === 0) {
      cb(dnsError('ENOTFOUND', 'getaddrinfo', String(hostname)));
      return;
    }
    if (options.all) {
      cb(null, results);
    } else {
      cb(null, results[0].address, results[0].family);
    }
  });
}

// --- resolve family (lookup-backed) ----------------------------------------

// Shared helper: look up addresses, filter to `family`, hand back string[].
function resolveFamily(hostname, family, cb) {
  queueMicrotask(function () {
    var results;
    try { results = nativeLookup(hostname, family); }
    catch (e) {
      if (!e.code) e = dnsError('ENOTFOUND', 'queryA', String(hostname));
      cb(e);
      return;
    }
    var addrs = [];
    for (var i = 0; i < results.length; i++) {
      if (!family || results[i].family === family) addrs.push(results[i].address);
    }
    if (addrs.length === 0) { cb(dnsError('ENODATA', 'queryA', String(hostname))); return; }
    cb(null, addrs);
  });
}

function resolve4(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; }
  resolveFamily(hostname, 4, cb);
}
function resolve6(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; }
  resolveFamily(hostname, 6, cb);
}
function resolve(hostname, rrtype, cb) {
  if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
  if (rrtype === 'AAAA') { resolveFamily(hostname, 6, cb); return; }
  resolveFamily(hostname, 4, cb);
}

// --- promises --------------------------------------------------------------

var promises = {
  lookup: function (hostname, options) {
    return new Promise(function (resolve, reject) {
      lookup(hostname, options || {}, function (err, address, family) {
        if (err) { reject(err); return; }
        // promises.lookup resolves to an object (or array when options.all).
        if (options && options.all) resolve(address);
        else resolve({ address: address, family: family });
      });
    });
  },
  resolve: function (hostname, rrtype) {
    return new Promise(function (res, rej) {
      resolve(hostname, rrtype, function (err, addrs) { err ? rej(err) : res(addrs); });
    });
  },
  resolve4: function (hostname) {
    return new Promise(function (res, rej) {
      resolve4(hostname, function (err, addrs) { err ? rej(err) : res(addrs); });
    });
  },
  resolve6: function (hostname) {
    return new Promise(function (res, rej) {
      resolve6(hostname, function (err, addrs) { err ? rej(err) : res(addrs); });
    });
  },
};

// --- Resolver --------------------------------------------------------------

// Minimal Resolver: each method just delegates to the module-level functions.
function Resolver() {}
Resolver.prototype.resolve = function (hostname, rrtype, cb) { return resolve(hostname, rrtype, cb); };
Resolver.prototype.resolve4 = function (hostname, options, cb) { return resolve4(hostname, options, cb); };
Resolver.prototype.resolve6 = function (hostname, options, cb) { return resolve6(hostname, options, cb); };
Resolver.prototype.getServers = function () { return []; };
Resolver.prototype.setServers = function () {};
Resolver.prototype.cancel = function () {};

function Resolver_promises() {}
Resolver_promises.prototype.resolve = promises.resolve;
Resolver_promises.prototype.resolve4 = promises.resolve4;
Resolver_promises.prototype.resolve6 = promises.resolve6;
Resolver_promises.prototype.getServers = function () { return []; };
Resolver_promises.prototype.setServers = function () {};
promises.Resolver = Resolver_promises;

// --- exports ---------------------------------------------------------------

module.exports = {
  lookup: lookup,
  resolve: resolve,
  resolve4: resolve4,
  resolve6: resolve6,
  Resolver: Resolver,
  promises: promises,

  // flag constants
  ADDRCONFIG: 1024,
  V4MAPPED: 8,
  ALL: 16,

  // error code constants
  NOTFOUND: 'ENOTFOUND',
  NODATA: 'ENODATA',
  FORMERR: 'EFORMERR',
  SERVFAIL: 'ESERVFAIL',
  REFUSED: 'EREFUSED',
  BADQUERY: 'EBADQUERY',
  BADNAME: 'EBADNAME',
  BADFAMILY: 'EBADFAMILY',
  TIMEOUT: 'ETIMEOUT',
  CONNREFUSED: 'ECONNREFUSED',
  CANCELLED: 'ECANCELLED',
};
module.exports.default = module.exports;

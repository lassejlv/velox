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

// --- real record queries (TXT/MX/SRV/NS/CNAME/SOA/CAA/PTR) via UDP DNS -------
// A/AAAA stay getaddrinfo-backed (keeps the localhost fast-path); other rrtypes
// issue an actual DNS query through __velox_dns_resolve.
function resolveRecord(hostname, rrtype, cb) {
  queueMicrotask(function () {
    var out;
    try { out = JSON.parse(__velox_dns_resolve(String(hostname), rrtype)); }
    catch (e) {
      if (!e.code) e = dnsError('ENOTFOUND', 'query' + rrtype, String(hostname));
      cb(e);
      return;
    }
    // resolveSoa yields a single object; the rest yield arrays.
    cb(null, rrtype === 'SOA' ? out[0] : out);
  });
}

function resolve(hostname, rrtype, cb) {
  if (typeof rrtype === 'function') { cb = rrtype; rrtype = 'A'; }
  if (rrtype === 'A') { resolveFamily(hostname, 4, cb); return; }
  if (rrtype === 'AAAA') { resolveFamily(hostname, 6, cb); return; }
  resolveRecord(hostname, rrtype, cb);
}
function resolveTxt(hostname, cb) { resolveRecord(hostname, 'TXT', cb); }
function resolveMx(hostname, cb) { resolveRecord(hostname, 'MX', cb); }
function resolveSrv(hostname, cb) { resolveRecord(hostname, 'SRV', cb); }
function resolveNs(hostname, cb) { resolveRecord(hostname, 'NS', cb); }
function resolveCname(hostname, cb) { resolveRecord(hostname, 'CNAME', cb); }
function resolveSoa(hostname, cb) { resolveRecord(hostname, 'SOA', cb); }
function resolveCaa(hostname, cb) { resolveRecord(hostname, 'CAA', cb); }
function resolvePtr(hostname, cb) { resolveRecord(hostname, 'PTR', cb); }
function resolveAny(hostname, cb) { resolveRecord(hostname, 'ANY', cb); }
// reverse(ip) — PTR lookup of the reversed-nibble in-addr.arpa name (IPv4).
function reverse(ip, cb) {
  var name;
  if (ip.indexOf(':') === -1) name = ip.split('.').reverse().join('.') + '.in-addr.arpa';
  else { cb(dnsError('ENOTIMP', 'getHostByAddr', ip)); return; }
  resolveRecord(name, 'PTR', cb);
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
// Promisify the record-query functions onto the promises API.
function promisify1(fn) {
  return function (hostname) {
    return new Promise(function (res, rej) { fn(hostname, function (err, r) { err ? rej(err) : res(r); }); });
  };
}
promises.resolveTxt = promisify1(resolveTxt);
promises.resolveMx = promisify1(resolveMx);
promises.resolveSrv = promisify1(resolveSrv);
promises.resolveNs = promisify1(resolveNs);
promises.resolveCname = promisify1(resolveCname);
promises.resolveSoa = promisify1(resolveSoa);
promises.resolveCaa = promisify1(resolveCaa);
promises.resolvePtr = promisify1(resolvePtr);
promises.resolveAny = promisify1(resolveAny);
promises.reverse = promisify1(reverse);

// --- Resolver --------------------------------------------------------------

// Minimal Resolver: each method just delegates to the module-level functions.
function Resolver() {}
Resolver.prototype.resolve = function (hostname, rrtype, cb) { return resolve(hostname, rrtype, cb); };
Resolver.prototype.resolve4 = function (hostname, options, cb) { return resolve4(hostname, options, cb); };
Resolver.prototype.resolve6 = function (hostname, options, cb) { return resolve6(hostname, options, cb); };
Resolver.prototype.resolveTxt = function (h, cb) { return resolveTxt(h, cb); };
Resolver.prototype.resolveMx = function (h, cb) { return resolveMx(h, cb); };
Resolver.prototype.resolveSrv = function (h, cb) { return resolveSrv(h, cb); };
Resolver.prototype.resolveNs = function (h, cb) { return resolveNs(h, cb); };
Resolver.prototype.resolveCname = function (h, cb) { return resolveCname(h, cb); };
Resolver.prototype.resolveSoa = function (h, cb) { return resolveSoa(h, cb); };
Resolver.prototype.resolveCaa = function (h, cb) { return resolveCaa(h, cb); };
Resolver.prototype.resolvePtr = function (h, cb) { return resolvePtr(h, cb); };
Resolver.prototype.resolveAny = function (h, cb) { return resolveAny(h, cb); };
Resolver.prototype.reverse = function (ip, cb) { return reverse(ip, cb); };
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
  resolveTxt: resolveTxt,
  resolveMx: resolveMx,
  resolveSrv: resolveSrv,
  resolveNs: resolveNs,
  resolveCname: resolveCname,
  resolveSoa: resolveSoa,
  resolveCaa: resolveCaa,
  resolvePtr: resolvePtr,
  resolveAny: resolveAny,
  reverse: reverse,
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

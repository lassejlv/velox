// node:crypto — hashing, HMAC, and secure random, backed by native primitives.
// Data is handed to/from the host as latin1 strings (binary-safe).

var Buffer = globalThis.Buffer;

function toLatin1(data, enc) {
  if (Buffer.isBuffer(data)) return data.toString("latin1");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("latin1");
  return Buffer.from(String(data), enc || "utf8").toString("latin1");
}

function Hash(algo) {
  this._algo = String(algo).toLowerCase();
  this._parts = [];
}
Hash.prototype.update = function (data, enc) {
  this._parts.push(toLatin1(data, enc));
  return this;
};
Hash.prototype.digest = function (enc) {
  var out = Buffer.from(__velox_hash(this._algo, this._parts.join("")), "latin1");
  return enc ? out.toString(enc) : out;
};
Hash.prototype.copy = function () {
  var h = new Hash(this._algo);
  h._parts = this._parts.slice();
  return h;
};

function Hmac(algo, key) {
  this._algo = String(algo).toLowerCase();
  this._key = toLatin1(key);
  this._parts = [];
}
Hmac.prototype.update = function (data, enc) {
  this._parts.push(toLatin1(data, enc));
  return this;
};
Hmac.prototype.digest = function (enc) {
  var out = Buffer.from(__velox_hmac(this._algo, this._key, this._parts.join("")), "latin1");
  return enc ? out.toString(enc) : out;
};

function createHash(algo) { return new Hash(algo); }

// Node 21 one-shot hash: crypto.hash(algorithm, data[, outputEncoding]).
// Default output is a hex string; pass "buffer" for a Buffer.
function hash(algo, data, outputEncoding) {
  var enc = outputEncoding === undefined ? 'hex' : outputEncoding;
  var h = new Hash(algo).update(data);
  return enc === 'buffer' ? h.digest() : h.digest(enc);
}
function createHmac(algo, key) { return new Hmac(algo, key); }

function randomBytes(size, cb) {
  size = size >>> 0;
  var buf = Buffer.from(__velox_random_bytes(size), "latin1");
  if (typeof cb === "function") {
    queueMicrotask(function () { cb(null, buf); });
    return undefined;
  }
  return buf;
}
function randomFillSync(buf, offset, size) {
  offset = offset || 0;
  size = size === undefined ? buf.length - offset : size;
  var rnd = Buffer.from(__velox_random_bytes(size), "latin1");
  rnd.copy(buf, offset);
  return buf;
}
function randomFill(buf, offset, size, cb) {
  if (typeof offset === "function") { cb = offset; offset = 0; size = buf.length; }
  else if (typeof size === "function") { cb = size; size = buf.length - offset; }
  queueMicrotask(function () { cb(null, randomFillSync(buf, offset, size)); });
}
function randomInt(min, max, cb) {
  if (max === undefined || typeof max === "function") { cb = max; max = min; min = 0; }
  var range = max - min;
  var r = Buffer.from(__velox_random_bytes(6), "latin1");
  var value = min + (r.readUIntBE(0, 6) % range);
  if (typeof cb === "function") { queueMicrotask(function () { cb(null, value); }); return; }
  return value;
}
// --- primality (checkPrime, Miller-Rabin) -----------------------------------

function toCandidateBigInt(candidate) {
  if (typeof candidate === "bigint") return candidate;
  if (Buffer.isBuffer(candidate) || ArrayBuffer.isView(candidate)) {
    var hex = Buffer.from(candidate.buffer || candidate, candidate.byteOffset, candidate.byteLength).toString("hex");
    return hex ? BigInt("0x" + hex) : 0n;
  }
  if (typeof candidate === "number") return BigInt(candidate);
  throw new TypeError('The "candidate" argument must be a BigInt, Buffer, or TypedArray.');
}
function powmod(a, e, m) {
  var r = 1n;
  a %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * a) % m;
    e >>= 1n;
    a = (a * a) % m;
  }
  return r;
}
// Strong-witness Miller-Rabin: deterministic for n < 3.3e24 with bases 2..37.
function isProbablePrime(n) {
  if (n < 2n) return false;
  var small = [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n];
  for (var i = 0; i < small.length; i++) {
    if (n === small[i]) return true;
    if (n % small[i] === 0n) return false;
  }
  var d = n - 1n, r = 0n;
  while (d % 2n === 0n) { d /= 2n; r++; }
  for (var w = 0; w < small.length; w++) {
    var a = small[w];
    if (a >= n) continue;
    var x = powmod(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    var composite = true;
    for (var j = 1n; j < r; j++) {
      x = (x * x) % n;
      if (x === n - 1n) { composite = false; break; }
    }
    if (composite) return false;
  }
  return true;
}
function checkPrimeSync(candidate) {
  return isProbablePrime(toCandidateBigInt(candidate));
}
function checkPrime(candidate, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  try {
    var r = checkPrimeSync(candidate);
    queueMicrotask(function () { cb(null, r); });
  } catch (e) {
    queueMicrotask(function () { cb(e); });
  }
}

// crypto.generatePrimeSync(size[, options]) — a random probable prime of `size`
// bits. Returns an ArrayBuffer (big-endian) by default, or a BigInt with
// { bigint: true }; { safe: true } requires (n-1)/2 also prime. (Pure-BigInt
// Miller-Rabin, so large sizes are slow — fine for the common small cases.)
function generatePrimeSync(size, options) {
  options = options || {};
  if (typeof size !== "number" || size < 2) {
    throw new RangeError('The "size" argument must be a number >= 2.');
  }
  var bytes = Math.ceil(size / 8);
  var topBits = size % 8 || 8;
  for (;;) {
    var buf = randomBytes(bytes);
    buf[0] &= 0xff >> (8 - topBits); // clear bits above `size`
    buf[0] |= 1 << (topBits - 1); // set the high bit → exactly `size` bits
    buf[bytes - 1] |= 1; // odd
    var n = BigInt("0x" + buf.toString("hex"));
    if (!isProbablePrime(n)) continue;
    if (options.safe && !isProbablePrime((n - 1n) / 2n)) continue;
    if (options.bigint) return n;
    var hex = n.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    var out = Buffer.from(hex, "hex");
    if (out.length < bytes) out = Buffer.concat([Buffer.alloc(bytes - out.length), out]);
    return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
  }
}
function generatePrime(size, options, cb) {
  if (typeof options === "function") { cb = options; options = {}; }
  try {
    var r = generatePrimeSync(size, options);
    queueMicrotask(function () { cb(null, r); });
  } catch (e) {
    queueMicrotask(function () { cb(e); });
  }
}

function randomUUID() {
  var b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  var h = b.toString("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}
function getRandomValues(view) {
  var bytes = Buffer.from(__velox_random_bytes(view.byteLength), "latin1");
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
  return view;
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
function createHashAlgos() {
  return ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"];
}

// --- key derivation --------------------------------------------------------

function pbkdf2Sync(password, salt, iterations, keylen, digest) {
  var out = __velox_pbkdf2(
    String(digest || "sha1"),
    toLatin1(password),
    toLatin1(salt),
    iterations >>> 0,
    keylen >>> 0
  );
  return Buffer.from(out, "latin1");
}
function pbkdf2(password, salt, iterations, keylen, digest, cb) {
  if (typeof digest === "function") { cb = digest; digest = undefined; }
  queueMicrotask(function () {
    try { cb(null, pbkdf2Sync(password, salt, iterations, keylen, digest)); }
    catch (e) { cb(e); }
  });
}
function scryptSync(password, salt, keylen, options) {
  options = options || {};
  var N = options.N || options.cost || 16384;
  var r = options.r || options.blockSize || 8;
  var p = options.p || options.parallelization || 1;
  var out = __velox_scrypt(toLatin1(password), toLatin1(salt), N, r, p, keylen >>> 0);
  return Buffer.from(out, "latin1");
}
function scrypt(password, salt, keylen, options, cb) {
  if (typeof options === "function") { cb = options; options = undefined; }
  queueMicrotask(function () {
    try { cb(null, scryptSync(password, salt, keylen, options)); }
    catch (e) { cb(e); }
  });
}

// --- ciphers (AES-CBC/CTR/GCM) ---------------------------------------------

function Cipheriv(algo, key, iv, op) {
  this._algo = String(algo).toLowerCase();
  this._key = toLatin1(key);
  this._iv = iv == null ? "" : toLatin1(iv);
  this._op = op;
  this._chunks = [];
  this._aad = "";
  this._authTag = null; // decrypt: caller-supplied tag
  this._tag = null;     // encrypt: produced tag
  // AEAD ciphers carry a 16-byte auth tag and accept setAAD/getAuthTag.
  this._isGcm = /gcm$/.test(this._algo) || this._algo === "chacha20-poly1305";
}
Cipheriv.prototype.setAAD = function (buf) { this._aad += toLatin1(buf); return this; };
Cipheriv.prototype.setAutoPadding = function () { return this; };
Cipheriv.prototype.setAuthTag = function (tag) { this._authTag = toLatin1(tag); return this; };
Cipheriv.prototype.getAuthTag = function () {
  if (this._tag == null) throw new Error("getAuthTag must be called after final()");
  return Buffer.from(this._tag, "latin1");
};
Cipheriv.prototype.update = function (data, inputEnc, outputEnc) {
  this._chunks.push(toLatin1(data, inputEnc));
  return outputEnc ? "" : Buffer.alloc(0); // output is produced at final()
};
Cipheriv.prototype.final = function (outputEnc) {
  var input = this._chunks.join("");
  if (this._op === "decrypt" && this._isGcm) {
    if (this._authTag == null) throw new Error("auth tag required for GCM decryption");
    input += this._authTag;
  }
  var out = Buffer.from(
    __velox_cipher(this._op, this._algo, this._key, this._iv, input, this._aad),
    "latin1"
  );
  if (this._op === "encrypt" && this._isGcm) {
    this._tag = out.slice(out.length - 16).toString("latin1");
    out = out.slice(0, out.length - 16);
  }
  return outputEnc ? out.toString(outputEnc) : out;
};

function createCipheriv(algo, key, iv) { return new Cipheriv(algo, key, iv, "encrypt"); }
function createDecipheriv(algo, key, iv) { return new Cipheriv(algo, key, iv, "decrypt"); }

// --- Ed25519 asymmetric signing --------------------------------------------

function keyToPem(key) {
  if (typeof key === "string") return key;
  if (key && typeof key.key === "string") return key.key;
  if (key && typeof key.export === "function") return String(key.export({ type: "pkcs8", format: "pem" }));
  return String(key);
}
function encodeKey(pem, opts, kind) {
  // Honor { type, format } export options; default is a PEM string (KeyObject if
  // no encoding requested, matching Node when options.publicKeyEncoding is unset).
  if (!opts) return pem;
  if (opts.format === "der") return Buffer.from(pem);
  return pem;
}
function generateKeyPairSync(type, options) {
  var t = String(type).toLowerCase();
  options = options || {};
  var kp;
  if (t === "ed25519" || t === "ed448") kp = JSON.parse(__velox_gen_ed25519());
  else if (t === "x25519") kp = JSON.parse(__velox_gen_x25519());
  else if (t === "ec") kp = JSON.parse(__velox_gen_ec());
  else if (t === "rsa" || t === "rsa-pss") {
    var bits = options.modulusLength || 2048;
    kp = JSON.parse(__velox_gen_rsa(bits));
  } else throw new Error("unsupported key type '" + type + "' (ed25519, x25519, ec, rsa)");
  return {
    publicKey: encodeKey(kp.publicKey, options.publicKeyEncoding, "public"),
    privateKey: encodeKey(kp.privateKey, options.privateKeyEncoding, "private"),
  };
}
function generateKeyPair(type, options, cb) {
  if (typeof options === "function") { cb = options; options = undefined; }
  queueMicrotask(function () {
    try { var kp = generateKeyPairSync(type, options); cb(null, kp.publicKey, kp.privateKey); }
    catch (e) { cb(e); }
  });
}
function sign(algorithm, data, key) {
  return Buffer.from(__velox_sign_ed25519(keyToPem(key), toLatin1(data)), "latin1");
}
function verify(algorithm, data, key, signature) {
  return __velox_verify_ed25519(keyToPem(key), toLatin1(data), toLatin1(signature));
}

// Classic streaming sign/verify (update().sign()/verify()).
function Sign(algorithm) { this._parts = []; }
Sign.prototype.update = function (data, enc) { this._parts.push(toLatin1(data, enc)); return this; };
Sign.prototype.sign = function (key, outputEnc) {
  var buf = Buffer.from(__velox_sign_ed25519(keyToPem(key), this._parts.join("")), "latin1");
  return outputEnc ? buf.toString(outputEnc) : buf;
};
function Verify(algorithm) { this._parts = []; }
Verify.prototype.update = function (data, enc) { this._parts.push(toLatin1(data, enc)); return this; };
Verify.prototype.verify = function (key, signature, sigEnc) {
  var sig = Buffer.isBuffer(signature) ? signature : Buffer.from(String(signature), sigEnc || "hex");
  return __velox_verify_ed25519(keyToPem(key), this._parts.join(""), sig.toString("latin1"));
};
function createSign(algorithm) { return new Sign(algorithm); }
function createVerify(algorithm) { return new Verify(algorithm); }
// --- HKDF (RFC 5869, built on HMAC) -----------------------------------------

function hashLen(digest) {
  return createHash(digest).update("").digest().length;
}
function hkdfSync(digest, ikm, salt, info, keylen) {
  digest = String(digest);
  var hl = hashLen(digest);
  var ikmBuf = Buffer.isBuffer(ikm) ? ikm : Buffer.from(ikm);
  var saltBuf = (salt && salt.length) ? (Buffer.isBuffer(salt) ? salt : Buffer.from(salt)) : Buffer.alloc(hl);
  var infoBuf = info ? (Buffer.isBuffer(info) ? info : Buffer.from(info)) : Buffer.alloc(0);
  keylen = keylen >>> 0;
  if (keylen > 255 * hl) throw new RangeError("Invalid key length");
  // Extract.
  var prk = createHmac(digest, saltBuf).update(ikmBuf).digest();
  // Expand.
  var out = Buffer.alloc(0);
  var t = Buffer.alloc(0);
  for (var i = 1; out.length < keylen; i++) {
    t = createHmac(digest, prk).update(Buffer.concat([t, infoBuf, Buffer.from([i])])).digest();
    out = Buffer.concat([out, t]);
  }
  var result = out.subarray(0, keylen);
  // Node returns an ArrayBuffer.
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.length);
}
function hkdf(digest, ikm, salt, info, keylen, cb) {
  queueMicrotask(function () {
    try { cb(null, hkdfSync(digest, ikm, salt, info, keylen)); }
    catch (e) { cb(e); }
  });
}

// --- KeyObjects (thin PEM wrappers) -----------------------------------------

// --- JWK <-> PEM (EC P-256 and OKP ed25519/x25519 public keys) -------------
function b64uEnc(buf) { return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function b64uDec(s) { s = String(s).replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Buffer.from(s, "base64"); }
function derOfPem(pem) { return Buffer.from(String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64"); }
function derLenBytes(n) { if (n < 128) return Buffer.from([n]); var b = []; while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); } return Buffer.from([0x80 | b.length].concat(b)); }
function derSeqWrap(c) { return Buffer.concat([Buffer.from([0x30]), derLenBytes(c.length), c]); }
function derBitStrWrap(c) { var x = Buffer.concat([Buffer.from([0x00]), c]); return Buffer.concat([Buffer.from([0x03]), derLenBytes(x.length), x]); }
function pemWrap(label, der) { var b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n"); if (b64[b64.length - 1] !== "\n") b64 += "\n"; return "-----BEGIN " + label + "-----\n" + b64 + "-----END " + label + "-----\n"; }
var EC_ALGID_P256 = "301306072a8648ce3d020106082a8648ce3d030107";
var OKP_ALGID = { Ed25519: "300506032b6570", X25519: "300506032b656e" };
function keyToJwk(ko) {
  var type = ko.asymmetricKeyType, der = derOfPem(ko._pem);
  if (type === "ec") { var point = der.slice(der.length - 65); return { kty: "EC", crv: "P-256", x: b64uEnc(point.slice(1, 33)), y: b64uEnc(point.slice(33, 65)) }; }
  if (type === "ed25519" || type === "x25519") { var raw = der.slice(der.length - 32); return { kty: "OKP", crv: type === "ed25519" ? "Ed25519" : "X25519", x: b64uEnc(raw) }; }
  throw new Error("JWK export not supported for key type " + type);
}
function jwkToPem(jwk) {
  if (jwk.kty === "EC") { var point = Buffer.concat([Buffer.from([0x04]), b64uDec(jwk.x), b64uDec(jwk.y)]); return pemWrap("PUBLIC KEY", derSeqWrap(Buffer.concat([Buffer.from(EC_ALGID_P256, "hex"), derBitStrWrap(point)]))); }
  if (jwk.kty === "OKP") { return pemWrap("PUBLIC KEY", derSeqWrap(Buffer.concat([Buffer.from(OKP_ALGID[jwk.crv] || OKP_ALGID.Ed25519, "hex"), derBitStrWrap(b64uDec(jwk.x))]))); }
  throw new Error("JWK import not supported for kty " + jwk.kty);
}

function pemOf(input) {
  if (typeof input === "string") return input;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) return Buffer.from(input).toString();
  if (input && input.format === "jwk" && input.key && typeof input.key === "object") return jwkToPem(input.key);
  if (input && typeof input.export === "function") return String(input.export({ type: "pkcs8", format: "pem" }));
  if (input && input.key != null) return pemOf(input.key);
  return String(input);
}
function detectKeyType(pem) {
  if (/BEGIN [A-Z ]*RSA/.test(pem)) return "rsa";
  if (/BEGIN [A-Z ]*EC/.test(pem)) return "ec";
  // ed25519/x25519 use generic PKCS#8/SPKI — decode the DER and match the curve
  // OID (RFC 8410): ed25519 = 2b6570, x25519 = 2b656e, x448 = 2b656f.
  try {
    var b64 = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    var hex = Buffer.from(b64, "base64").toString("hex");
    if (hex.indexOf("2b656e") >= 0) return "x25519";
    if (hex.indexOf("2b6570") >= 0) return "ed25519";
    if (hex.indexOf("2b656f") >= 0) return "x448";
    if (hex.indexOf("2a864886f70d010101") >= 0) return "rsa"; // rsaEncryption OID
    if (hex.indexOf("2a8648ce3d") >= 0) return "ec"; // EC OID prefix
  } catch (e) {}
  return undefined;
}

// crypto.diffieHellman({ privateKey, publicKey }) — X25519 key agreement.
function diffieHellman(options) {
  if (!options || !options.privateKey || !options.publicKey) {
    throw new TypeError('The "options.privateKey" and "options.publicKey" properties are required');
  }
  var priv = options.privateKey, pub = options.publicKey;
  var privPem = typeof priv.export === "function" ? String(priv.export({ type: "pkcs8", format: "pem" })) : String(priv);
  var pubPem = typeof pub.export === "function" ? String(pub.export({ type: "spki", format: "pem" })) : String(pub);
  var kt = priv.asymmetricKeyType || detectKeyType(privPem);
  if (kt !== "x25519") {
    throw new Error("crypto.diffieHellman currently supports X25519 keys only");
  }
  return Buffer.from(__velox_x25519_dh(privPem, pubPem), "latin1");
}
function KeyObject(type, pem) {
  this.type = type; // 'public' | 'private' | 'secret'
  this._pem = pem;
  this._secret = null;
  this.asymmetricKeyType = type === "secret" ? undefined : detectKeyType(pem || "");
}
KeyObject.prototype.export = function (options) {
  options = options || {};
  if (this.type === "secret") {
    return options.format === "buffer" || !options.format ? this._secret : this._secret.toString(options.format || "buffer");
  }
  if (options.format === "jwk") return keyToJwk(this);
  if (options.format === "der") return Buffer.from(this._pem); // best-effort
  return this._pem;
};
// Validate that `input` looks like an asymmetric key (PEM/DER/KeyObject), not an
// arbitrary string — Node throws here, and callers (e.g. jsonwebtoken) rely on
// it: they `try { createPrivateKey(secret) } catch { createSecretKey(secret) }`
// to distinguish an HMAC secret from a real private key.
function assertAsymmetricKey(input) {
  if (input instanceof KeyObject || Buffer.isBuffer(input) || input instanceof Uint8Array) return;
  if (input && input.format === "jwk" && input.key && typeof input.key === "object") return; // JWK input
  if (input && input.kty) return; // a bare JWK object
  var pem = (input && input.key != null) ? input.key : input;
  if (typeof pem === "string") {
    if (pem.indexOf("-----BEGIN") === -1) {
      var e = new Error("error:1E08010C:DECODER routines::unsupported");
      e.code = "ERR_OSSL_UNSUPPORTED";
      throw e;
    }
    return;
  }
  if (input && typeof input.export === "function") return;
  throw new TypeError('The "key" argument must be of type string, Buffer, or KeyObject.');
}
function createPublicKey(input) { assertAsymmetricKey(input); return new KeyObject("public", pemOf(input)); }
function createPrivateKey(input) { assertAsymmetricKey(input); return new KeyObject("private", pemOf(input)); }
function createSecretKey(key, enc) {
  var ko = new KeyObject("secret", null);
  ko._secret = Buffer.isBuffer(key) ? key : Buffer.from(key, enc || "utf8");
  return ko;
}

// generateKeySync(type, { length }) — a random symmetric secret KeyObject.
// `length` is in BITS for 'hmac' (any byte-multiple) and 'aes' (128/192/256).
function generateKeySync(type, options) {
  var t = String(type).toLowerCase();
  if (t !== "hmac" && t !== "aes") throw new Error("Unsupported key type: " + type);
  var bits = options && options.length;
  if (typeof bits !== "number") throw new TypeError("options.length must be a number of bits");
  if (t === "aes" && bits !== 128 && bits !== 192 && bits !== 256) throw new RangeError("AES key length must be 128, 192, or 256 bits");
  return createSecretKey(randomBytes(Math.ceil(bits / 8)));
}
function generateKey(type, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  try { var key = generateKeySync(type, options); process.nextTick(function () { callback(null, key); }); }
  catch (e) { process.nextTick(function () { callback(e); }); }
}

// --- classic finite-field Diffie-Hellman (BigInt modexp) -------------------
function dhBufToBig(buf) { var h = Buffer.isBuffer(buf) ? buf.toString("hex") : Buffer.from(buf).toString("hex"); return h === "" ? 0n : BigInt("0x" + h); }
function dhBigToBuf(n) { var h = n.toString(16); if (h.length % 2) h = "0" + h; return Buffer.from(h, "hex"); }
function dhModPow(base, exp, mod) { var r = 1n; base %= mod; while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; exp >>= 1n; base = (base * base) % mod; } return r; }
function dhEncode(buf, enc) { return enc && enc !== "buffer" ? buf.toString(enc) : buf; }
function dhToBig(v, enc) { return dhBufToBig(typeof v === "string" ? Buffer.from(v, enc || "utf8") : v); }

// RFC 3526 MODP group 14 (2048-bit), generator 2 — for getDiffieHellman('modp14').
var MODP14 = "FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF";
var MODP_GROUPS = { modp14: { p: MODP14, g: 2 } };

function DiffieHellman(prime, generator, genEnc, primeEnc) {
  this._prime = typeof prime === "bigint" ? prime : dhToBig(prime, primeEnc);
  this._gen = generator == null ? 2n : typeof generator === "number" ? BigInt(generator) : typeof generator === "bigint" ? generator : dhToBig(generator, genEnc);
  this._priv = null;
  this._pub = null;
}
DiffieHellman.prototype.generateKeys = function (enc) {
  var bytes = dhBigToBuf(this._prime).length;
  this._priv = (dhBufToBig(randomBytes(bytes)) % (this._prime - 2n)) + 1n;
  this._pub = dhModPow(this._gen, this._priv, this._prime);
  return dhEncode(dhBigToBuf(this._pub), enc);
};
DiffieHellman.prototype.computeSecret = function (other, inEnc, outEnc) {
  var o = dhToBig(other, inEnc);
  return dhEncode(dhBigToBuf(dhModPow(o, this._priv, this._prime)), outEnc);
};
DiffieHellman.prototype.getPrime = function (enc) { return dhEncode(dhBigToBuf(this._prime), enc); };
DiffieHellman.prototype.getGenerator = function (enc) { return dhEncode(dhBigToBuf(this._gen), enc); };
DiffieHellman.prototype.getPublicKey = function (enc) { return dhEncode(dhBigToBuf(this._pub), enc); };
DiffieHellman.prototype.getPrivateKey = function (enc) { return dhEncode(dhBigToBuf(this._priv), enc); };
DiffieHellman.prototype.setPublicKey = function (k, enc) { this._pub = dhToBig(k, enc); return this; };
DiffieHellman.prototype.setPrivateKey = function (k, enc) { this._priv = dhToBig(k, enc); return this; };

function createDiffieHellman(sizeOrPrime, primeEnc, generator, genEnc) {
  if (typeof sizeOrPrime === "number") {
    // createDiffieHellman(primeLength[, generator]) — generate a safe prime.
    var gen = typeof primeEnc === "number" ? primeEnc : 2;
    return new DiffieHellman(generatePrimeSync(sizeOrPrime, { safe: true, bigint: true }), gen);
  }
  // createDiffieHellman(prime[, primeEncoding][, generator][, generatorEncoding])
  var pEnc = typeof primeEnc === "string" && primeEnc !== "buffer" ? primeEnc : undefined;
  return new DiffieHellman(sizeOrPrime, generator, genEnc, pEnc);
}
function getDiffieHellman(groupName) {
  var grp = MODP_GROUPS[groupName];
  if (!grp) throw new Error("Unknown DH group: " + groupName);
  return new DiffieHellman(Buffer.from(grp.p, "hex"), grp.g);
}

// --- ECDH key agreement (P-256) --------------------------------------------

function normalizeCurve(curve) {
  var c = String(curve).toLowerCase();
  if (c === "prime256v1" || c === "secp256r1" || c === "p-256" || c === "p256") return "p256";
  throw new Error("unsupported ECDH curve '" + curve + "' (only prime256v1/secp256r1 supported)");
}
function bufFromKey(key, enc) {
  if (Buffer.isBuffer(key)) return key;
  if (key instanceof Uint8Array) return Buffer.from(key);
  return Buffer.from(String(key), enc || "hex");
}
function ECDH(curve) {
  this._curve = normalizeCurve(curve);
  this._priv = null; // Buffer (32 bytes)
  this._pub = null;  // Buffer (65 bytes, uncompressed)
}
ECDH.prototype.generateKeys = function (encoding, format) {
  var kp = JSON.parse(__velox_ecdh_generate());
  this._priv = Buffer.from(kp.priv, "latin1");
  this._pub = Buffer.from(kp.pub, "latin1");
  return this.getPublicKey(encoding, format);
};
ECDH.prototype.getPublicKey = function (encoding, format) {
  if (!this._pub) throw new Error("No public key - did you forget to generateKeys()?");
  var compressed = format === "compressed";
  var pub = compressed
    ? Buffer.from(__velox_ecdh_pub(this._priv.toString("latin1"), true), "latin1")
    : this._pub;
  return encoding ? pub.toString(encoding) : pub;
};
ECDH.prototype.getPrivateKey = function (encoding) {
  if (!this._priv) throw new Error("No private key");
  return encoding ? this._priv.toString(encoding) : this._priv;
};
ECDH.prototype.setPrivateKey = function (key, encoding) {
  this._priv = bufFromKey(key, encoding);
  this._pub = Buffer.from(__velox_ecdh_pub(this._priv.toString("latin1"), false), "latin1");
  return this;
};
ECDH.prototype.setPublicKey = function (key, encoding) {
  this._pub = bufFromKey(key, encoding);
  return this;
};
ECDH.prototype.computeSecret = function (otherPublicKey, inputEncoding, outputEncoding) {
  if (!this._priv) throw new Error("No private key - call generateKeys() or setPrivateKey() first");
  var other = bufFromKey(otherPublicKey, inputEncoding);
  var secret = Buffer.from(
    __velox_ecdh_compute(this._priv.toString("latin1"), other.toString("latin1")),
    "latin1"
  );
  return outputEncoding ? secret.toString(outputEncoding) : secret;
};
function createECDH(curve) { return new ECDH(curve); }

// publicEncrypt/privateDecrypt — RSA-OAEP (the default padding). `key` may be a
// PEM string/Buffer/KeyObject, or { key, oaepHash, padding }. Other paddings
// aren't supported (OAEP is the secure default and what Web Crypto uses).
function rsaKeyAndHash(key) {
  var hash = "sha256";
  if (key && typeof key === "object" && !Buffer.isBuffer(key) && typeof key.export !== "function" && key.key != null) {
    if (key.oaepHash) hash = String(key.oaepHash).toLowerCase().replace(/-/g, "");
    return { pem: pemOf(key.key), hash: hash };
  }
  return { pem: pemOf(key), hash: hash };
}
function publicEncrypt(key, buffer) {
  var k = rsaKeyAndHash(key);
  var data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return Buffer.from(__velox_rsa_encrypt(k.pem, data.toString("latin1"), k.hash), "latin1");
}
function privateDecrypt(key, buffer) {
  var k = rsaKeyAndHash(key);
  var data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  return Buffer.from(__velox_rsa_decrypt(k.pem, data.toString("latin1"), k.hash), "latin1");
}

function getCiphers() {
  return [
    "aes-128-cbc", "aes-192-cbc", "aes-256-cbc",
    "aes-128-ctr", "aes-192-ctr", "aes-256-ctr",
    "aes-128-gcm", "aes-256-gcm",
    "chacha20-poly1305",
  ];
}

// The named curves velox's EC/ECDH support covers (P-256 via the p256 crate;
// the OpenSSL aliases are listed too since libraries match on either name).
function getCurves() {
  return ["prime256v1", "secp256r1", "P-256"];
}

// X509Certificate — parses a PEM/DER certificate via the native __velox_x509_parse
// (x509-cert crate) and exposes Node's read-only certificate surface. Binary
// fields (raw DER, SPKI) cross from the native as hex.
function x509DerToPem(der, label) {
  var b64 = Buffer.from(der).toString("base64");
  var lines = b64.replace(/(.{64})/g, "$1\n");
  if (lines[lines.length - 1] !== "\n") lines += "\n";
  return "-----BEGIN " + label + "-----\n" + lines + "-----END " + label + "-----\n";
}
function x509MatchHost(pattern, host) {
  if (pattern === host) return true;
  if (pattern.indexOf("*.") === 0) {
    var rest = pattern.slice(1); // ".example.com"
    var dot = host.indexOf(".");
    return dot > 0 && host.slice(dot) === rest;
  }
  return false;
}
function X509Certificate(input) {
  if (!(this instanceof X509Certificate)) return new X509Certificate(input);
  var latin1;
  if (typeof input === "string") latin1 = Buffer.from(input, "utf8").toString("latin1");
  else if (Buffer.isBuffer(input)) latin1 = input.toString("latin1");
  else if (ArrayBuffer.isView(input)) latin1 = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("latin1");
  else if (input instanceof ArrayBuffer) latin1 = Buffer.from(input).toString("latin1");
  else throw new TypeError("The \"buffer\" argument must be a string, Buffer, TypedArray, or DataView");
  var info = JSON.parse(__velox_x509_parse(latin1));
  this.subject = info.subject;
  this.issuer = info.issuer;
  this.serialNumber = info.serialNumber;
  this.validFrom = info.validFrom;
  this.validTo = info.validTo;
  this.validFromDate = new Date(info.validFromMs);
  this.validToDate = new Date(info.validToMs);
  this.fingerprint = info.fingerprint;
  this.fingerprint256 = info.fingerprint256;
  this.fingerprint512 = info.fingerprint512;
  this.subjectAltName = info.subjectAltName == null ? undefined : info.subjectAltName;
  this.keyUsage = info.keyUsage == null ? undefined : info.keyUsage;
  this.ca = info.ca;
  this.raw = Buffer.from(info.rawHex, "hex");
  this._spkiDer = Buffer.from(info.publicKeyDerHex, "hex");
}
X509Certificate.prototype._sanHosts = function () {
  var names = [];
  if (this.subjectAltName) {
    this.subjectAltName.split(",").forEach(function (e) {
      e = e.trim();
      if (e.indexOf("DNS:") === 0) names.push(e.slice(4).toLowerCase());
    });
  }
  if (!names.length) {
    var cn = /CN=([^\n]+)/.exec(this.subject || "");
    if (cn) names.push(cn[1].trim().toLowerCase());
  }
  return names;
};
X509Certificate.prototype.checkHost = function (name) {
  if (name == null) return undefined;
  var host = String(name).toLowerCase();
  var hosts = this._sanHosts();
  for (var i = 0; i < hosts.length; i++) if (x509MatchHost(hosts[i], host)) return String(name);
  return undefined;
};
X509Certificate.prototype.checkEmail = function (email) {
  if (email == null || !this.subjectAltName) return undefined;
  var want = String(email).toLowerCase(), found;
  this.subjectAltName.split(",").forEach(function (e) {
    e = e.trim();
    if (e.indexOf("email:") === 0 && e.slice(6).toLowerCase() === want) found = String(email);
  });
  return found;
};
X509Certificate.prototype.checkIP = function (ip) {
  if (ip == null || !this.subjectAltName) return undefined;
  var want = String(ip), found;
  this.subjectAltName.split(",").forEach(function (e) {
    e = e.trim();
    if (e.indexOf("IP Address:") === 0 && e.slice(11) === want) found = String(ip);
  });
  return found;
};
X509Certificate.prototype.toString = function () { return this.raw.toString("latin1"); };
X509Certificate.prototype.toJSON = function () { return this.toString(); };
Object.defineProperty(X509Certificate.prototype, "publicKey", {
  configurable: true,
  get: function () {
    if (!this._publicKey) this._publicKey = createPublicKey(x509DerToPem(this._spkiDer, "PUBLIC KEY"));
    return this._publicKey;
  },
});

module.exports = {
  X509Certificate: X509Certificate,
  createHash: createHash,
  hash: hash,
  createHmac: createHmac,
  Hash: Hash,
  Hmac: Hmac,
  randomBytes: randomBytes,
  randomFillSync: randomFillSync,
  randomFill: randomFill,
  randomInt: randomInt,
  checkPrime: checkPrime,
  checkPrimeSync: checkPrimeSync,
  generatePrime: generatePrime,
  generatePrimeSync: generatePrimeSync,
  randomUUID: randomUUID,
  getRandomValues: getRandomValues,
  timingSafeEqual: timingSafeEqual,
  getHashes: createHashAlgos,
  pbkdf2: pbkdf2,
  pbkdf2Sync: pbkdf2Sync,
  scrypt: scrypt,
  scryptSync: scryptSync,
  createCipheriv: createCipheriv,
  createDecipheriv: createDecipheriv,
  createECDH: createECDH,
  diffieHellman: diffieHellman,
  ECDH: ECDH,
  hkdf: hkdf,
  hkdfSync: hkdfSync,
  createPublicKey: createPublicKey,
  createPrivateKey: createPrivateKey,
  createSecretKey: createSecretKey,
  generateKey: generateKey,
  generateKeySync: generateKeySync,
  createDiffieHellman: createDiffieHellman,
  getDiffieHellman: getDiffieHellman,
  DiffieHellman: DiffieHellman,
  KeyObject: KeyObject,
  Cipheriv: Cipheriv,
  Decipheriv: Cipheriv,
  getCiphers: getCiphers,
  getCurves: getCurves,
  publicEncrypt: publicEncrypt,
  privateDecrypt: privateDecrypt,
  generateKeyPairSync: generateKeyPairSync,
  generateKeyPair: generateKeyPair,
  sign: sign,
  verify: verify,
  createSign: createSign,
  createVerify: createVerify,
  Sign: Sign,
  Verify: Verify,
  constants: {},
  webcrypto: globalThis.crypto,
  subtle: globalThis.crypto ? globalThis.crypto.subtle : undefined,
};
module.exports.default = module.exports;

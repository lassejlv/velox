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
  this._isGcm = /gcm$/.test(this._algo);
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

function pemOf(input) {
  if (typeof input === "string") return input;
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) return Buffer.from(input).toString();
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
  if (options.format === "der") return Buffer.from(this._pem); // best-effort
  return this._pem;
};
// Validate that `input` looks like an asymmetric key (PEM/DER/KeyObject), not an
// arbitrary string — Node throws here, and callers (e.g. jsonwebtoken) rely on
// it: they `try { createPrivateKey(secret) } catch { createSecretKey(secret) }`
// to distinguish an HMAC secret from a real private key.
function assertAsymmetricKey(input) {
  if (input instanceof KeyObject || Buffer.isBuffer(input) || input instanceof Uint8Array) return;
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

function getCiphers() {
  return [
    "aes-128-cbc", "aes-192-cbc", "aes-256-cbc",
    "aes-128-ctr", "aes-192-ctr", "aes-256-ctr",
    "aes-128-gcm", "aes-256-gcm",
  ];
}

module.exports = {
  createHash: createHash,
  hash: hash,
  createHmac: createHmac,
  Hash: Hash,
  Hmac: Hmac,
  randomBytes: randomBytes,
  randomFillSync: randomFillSync,
  randomFill: randomFill,
  randomInt: randomInt,
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
  KeyObject: KeyObject,
  Cipheriv: Cipheriv,
  Decipheriv: Cipheriv,
  getCiphers: getCiphers,
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

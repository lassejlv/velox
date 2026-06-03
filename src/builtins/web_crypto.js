// Web Crypto `crypto.subtle` (SubtleCrypto), built on top of node:crypto.
// Evaluated after the Velox prelude so the global `require` is available; its
// methods lazily `require('node:crypto')` at call time. Replaces the minimal
// digest-only `subtle` installed by CRYPTO_PRELUDE.
(function () {
  if (!globalThis.crypto || (globalThis.crypto.subtle && globalThis.crypto.subtle.importKey)) return;

  var _c;
  function getCrypto() { return _c || (_c = require("node:crypto")); }

  // --- BufferSource / ArrayBuffer helpers -----------------------------------
  function toBuf(d) {
    if (Buffer.isBuffer(d)) return d;
    if (d instanceof ArrayBuffer) return Buffer.from(new Uint8Array(d));
    if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
    if (d && d._m && d._m.secret) return d._m.secret; // tolerate CryptoKey
    return Buffer.from(d);
  }
  function toAB(buf) {
    var b = toBuf(buf);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
  }
  function b64uToBuf(s) {
    s = String(s).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return Buffer.from(s, "base64");
  }
  function bufToB64u(b) {
    return toBuf(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  // --- algorithm normalization ----------------------------------------------
  function normAlg(a) { return typeof a === "string" ? { name: a } : (a || {}); }
  function hashObj(h) { var n = typeof h === "string" ? h : (h && h.name); return { name: String(n || "SHA-256") }; }
  function nodeHash(h) { return hashObj(h).name.toLowerCase().replace(/-/g, ""); } // 'SHA-256' -> 'sha256'

  // --- PEM <-> DER ----------------------------------------------------------
  function derToPem(der, label) {
    var b64 = toBuf(der).toString("base64");
    var lines = (b64.match(/.{1,64}/g) || [b64]).join("\n");
    return "-----BEGIN " + label + "-----\n" + lines + "\n-----END " + label + "-----\n";
  }
  function pemToDer(pem) {
    var body = String(pem).replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    return Buffer.from(body, "base64");
  }

  // Extract the EC private scalar from a PKCS8 DER: the ECPrivateKey carries
  // `INTEGER 1` (02 01 01) then `OCTET STRING(coordLen)` (04 <len>) holding the
  // scalar. Locate that exact prefix and return the following coordLen bytes.
  function ecPrivScalar(der, coordLen) {
    for (var i = 0; i + 4 + coordLen <= der.length; i++) {
      if (der[i] === 0x02 && der[i + 1] === 0x01 && der[i + 2] === 0x01 && der[i + 3] === 0x04 && der[i + 4] === coordLen) {
        return der.slice(i + 5, i + 5 + coordLen);
      }
    }
    return null;
  }

  // --- ECDSA: ASN.1 DER signature <-> raw r||s (IEEE P1363) ------------------
  function derToRaw(der, size) {
    var off = 2;
    if (der[1] & 0x80) off = 2 + (der[1] & 0x7f);
    function readInt(o) {
      var len = der[o + 1];
      var val = der.slice(o + 2, o + 2 + len);
      while (val.length > size && val[0] === 0) val = val.slice(1);
      var out = Buffer.alloc(size);
      val.copy(out, size - val.length);
      return [out, o + 2 + len];
    }
    var r = readInt(off);
    var s = readInt(r[1]);
    return Buffer.concat([r[0], s[0]]);
  }
  function rawToDer(raw, size) {
    function trim(b) {
      var i = 0;
      while (i < b.length - 1 && b[i] === 0) i++;
      b = b.slice(i);
      if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
      return b;
    }
    var r = trim(raw.slice(0, size));
    var s = trim(raw.slice(size, size * 2));
    var seqLen = 2 + r.length + 2 + s.length;
    return Buffer.concat([Buffer.from([0x30, seqLen, 0x02, r.length]), r, Buffer.from([0x02, s.length]), s]);
  }

  function timingSafeEq(a, b) {
    a = toBuf(a); b = toBuf(b);
    if (a.length !== b.length) return false;
    var diff = 0;
    for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  // --- CryptoKey ------------------------------------------------------------
  function CryptoKey(type, algorithm, extractable, usages, material) {
    this.type = type;
    this.algorithm = algorithm;
    this.extractable = !!extractable;
    this.usages = usages || [];
    this._m = material;
  }
  var PRIV_USAGES = { sign: 1, decrypt: 1, deriveKey: 1, deriveBits: 1, unwrapKey: 1 };
  function keypairCK(name, algorithm, extractable, usages, kp) {
    var pubAlg = Object.assign({ name: name }, algorithm);
    var privAlg = Object.assign({ name: name }, algorithm);
    var privU = (usages || []).filter(function (u) { return PRIV_USAGES[u]; });
    var pubU = (usages || []).filter(function (u) { return !PRIV_USAGES[u]; });
    return {
      publicKey: new CryptoKey("public", pubAlg, true, pubU, { pem: String(kp.publicKey) }),
      privateKey: new CryptoKey("private", privAlg, extractable, privU, { pem: String(kp.privateKey) }),
    };
  }

  function aesName(key) { return "aes-" + key._m.secret.length * 8; }

  // --- SubtleCrypto methods -------------------------------------------------
  function digest(algorithm, data) {
    try {
      var out = getCrypto().createHash(nodeHash(normAlg(algorithm).name)).update(toBuf(data)).digest();
      return Promise.resolve(toAB(out));
    } catch (e) { return Promise.reject(e); }
  }

  function importKey(format, keyData, algorithm, extractable, usages) {
    try {
      algorithm = normAlg(algorithm);
      var name = algorithm.name;
      if (format === "raw") {
        var buf = toBuf(keyData);
        var alg;
        if (name === "HMAC") alg = { name: "HMAC", hash: hashObj(algorithm.hash), length: buf.length * 8 };
        else if (name.indexOf("AES") === 0) alg = { name: name, length: buf.length * 8 };
        else if (name === "PBKDF2" || name === "HKDF") alg = { name: name };
        else throw new Error("Unsupported raw key import for " + name);
        return Promise.resolve(new CryptoKey("secret", alg, extractable, usages, { secret: buf }));
      }
      if (format === "jwk") {
        if (keyData.kty === "oct") return importKey("raw", b64uToBuf(keyData.k), algorithm, extractable, usages);
        // EC/OKP public keys: rebuild the SPKI PEM from the JWK coordinates.
        // (Private JWKs — those carrying `d` — aren't supported yet.)
        if (keyData.kty === "EC" && !keyData.d) return Promise.resolve(new CryptoKey("public", fullAsymAlg(algorithm), extractable, usages, { pem: ecJwkToSpkiPem(keyData) }));
        if (keyData.kty === "OKP" && !keyData.d) return Promise.resolve(new CryptoKey("public", fullAsymAlg(algorithm), extractable, usages, { pem: okpJwkToSpkiPem(keyData) }));
        throw new Error("Unsupported jwk key type " + keyData.kty + (keyData.d ? " (private)" : ""));
      }
      if (format === "pkcs8") return Promise.resolve(new CryptoKey("private", fullAsymAlg(algorithm), extractable, usages, { pem: derToPem(keyData, "PRIVATE KEY") }));
      if (format === "spki") return Promise.resolve(new CryptoKey("public", fullAsymAlg(algorithm), extractable, usages, { pem: derToPem(keyData, "PUBLIC KEY") }));
      throw new Error("Unsupported key format " + format);
    } catch (e) { return Promise.reject(e); }
  }
  function fullAsymAlg(a) {
    var out = { name: a.name };
    if (a.hash) out.hash = hashObj(a.hash);
    if (a.namedCurve) out.namedCurve = a.namedCurve;
    if (a.modulusLength) out.modulusLength = a.modulusLength;
    return out;
  }

  // Minimal DER encoders for rebuilding EC/OKP SubjectPublicKeyInfo from JWK.
  function derLen(n) {
    if (n < 128) return Buffer.from([n]);
    var bytes = [];
    while (n > 0) { bytes.unshift(n & 0xff); n = Math.floor(n / 256); }
    return Buffer.from([0x80 | bytes.length].concat(bytes));
  }
  function derSeq(content) { return Buffer.concat([Buffer.from([0x30]), derLen(content.length), content]); }
  function derBitString(content) { var c = Buffer.concat([Buffer.from([0x00]), content]); return Buffer.concat([Buffer.from([0x03]), derLen(c.length), c]); }
  // AlgorithmIdentifier DER (ecPublicKey + namedCurve OID, or the OKP curve OID).
  var EC_ALGID = {
    "P-256": "301306072a8648ce3d020106082a8648ce3d030107",
    "P-384": "301006072a8648ce3d020106052b81040022",
    "P-521": "301006072a8648ce3d020106052b81040023",
  };
  var OKP_ALGID = { "Ed25519": "300506032b6570", "X25519": "300506032b656e" };
  function ecCoordLen(crv) { return crv === "P-384" ? 48 : crv === "P-521" ? 66 : 32; }
  function ecJwkToSpkiPem(jwk) {
    var x = b64uToBuf(jwk.x), y = b64uToBuf(jwk.y);
    var point = Buffer.concat([Buffer.from([0x04]), x, y]);
    var spki = derSeq(Buffer.concat([Buffer.from(EC_ALGID[jwk.crv], "hex"), derBitString(point)]));
    return derToPem(spki, "PUBLIC KEY");
  }
  function okpJwkToSpkiPem(jwk) {
    var spki = derSeq(Buffer.concat([Buffer.from(OKP_ALGID[jwk.crv], "hex"), derBitString(b64uToBuf(jwk.x))]));
    return derToPem(spki, "PUBLIC KEY");
  }

  function exportKey(format, key) {
    try {
      if (format === "raw") {
        if (key._m.secret) return Promise.resolve(toAB(key._m.secret));
        throw new Error("raw export is only supported for secret keys");
      }
      if (format === "jwk") {
        if (key._m.secret) return Promise.resolve({ kty: "oct", k: bufToB64u(key._m.secret), key_ops: key.usages, ext: key.extractable });
        if (key._m.pem) {
          // Public-key JWK: the public point/key is the trailing element of the
          // SPKI, so slice it by length. (Private-key JWK isn't supported — Web
          // Crypto private keys are non-extractable by default anyway.)
          if (key.type !== "public") throw new Error("jwk export of a private key is not supported");
          var algName = key.algorithm.name;
          var der = pemToDer(key._m.pem);
          if (algName === "ECDSA" || algName === "ECDH") {
            var crv = key.algorithm.namedCurve;
            var pointLen = 1 + 2 * ecCoordLen(crv);
            var point = der.slice(der.length - pointLen);
            var cl = ecCoordLen(crv);
            return Promise.resolve({ kty: "EC", crv: crv, x: bufToB64u(point.slice(1, 1 + cl)), y: bufToB64u(point.slice(1 + cl)), key_ops: key.usages, ext: key.extractable });
          }
          if (algName === "Ed25519" || algName === "EdDSA" || algName === "X25519") {
            var raw = der.slice(der.length - 32);
            return Promise.resolve({ kty: "OKP", crv: algName === "EdDSA" ? "Ed25519" : algName, x: bufToB64u(raw), key_ops: key.usages, ext: key.extractable });
          }
          throw new Error("jwk export unsupported for " + algName);
        }
        throw new Error("jwk export is only supported for secret and public keys");
      }
      if (format === "pkcs8" || format === "spki") {
        if (key._m.pem) return Promise.resolve(toAB(pemToDer(key._m.pem)));
        throw new Error(format + " export requires an asymmetric key");
      }
      throw new Error("Unsupported export format " + format);
    } catch (e) { return Promise.reject(e); }
  }

  function sign(algorithm, key, data) {
    try {
      algorithm = normAlg(algorithm);
      var name = algorithm.name || key.algorithm.name;
      var buf = toBuf(data);
      var crypto = getCrypto();
      if (name === "HMAC") return Promise.resolve(toAB(crypto.createHmac(nodeHash(key.algorithm.hash), key._m.secret).update(buf).digest()));
      if (name === "RSASSA-PKCS1-v1_5" || name === "RSA-PSS") return Promise.resolve(toAB(crypto.sign("sha256", buf, key._m.pem)));
      if (name === "ECDSA") return Promise.resolve(toAB(derToRaw(toBuf(crypto.sign("sha256", buf, key._m.pem)), 32)));
      if (name === "Ed25519" || name === "EdDSA") return Promise.resolve(toAB(crypto.sign(null, buf, key._m.pem)));
      throw new Error("Unsupported sign algorithm " + name);
    } catch (e) { return Promise.reject(e); }
  }

  function verify(algorithm, key, signature, data) {
    try {
      algorithm = normAlg(algorithm);
      var name = algorithm.name || key.algorithm.name;
      var sig = toBuf(signature), buf = toBuf(data);
      var crypto = getCrypto();
      if (name === "HMAC") return Promise.resolve(timingSafeEq(crypto.createHmac(nodeHash(key.algorithm.hash), key._m.secret).update(buf).digest(), sig));
      if (name === "RSASSA-PKCS1-v1_5" || name === "RSA-PSS") return Promise.resolve(crypto.verify("sha256", buf, key._m.pem, sig));
      if (name === "ECDSA") return Promise.resolve(crypto.verify("sha256", buf, key._m.pem, rawToDer(sig, 32)));
      if (name === "Ed25519" || name === "EdDSA") return Promise.resolve(crypto.verify(null, buf, key._m.pem, sig));
      throw new Error("Unsupported verify algorithm " + name);
    } catch (e) { return Promise.reject(e); }
  }

  function encrypt(algorithm, key, data) {
    try {
      algorithm = normAlg(algorithm);
      var name = algorithm.name;
      var crypto = getCrypto();
      var pt = toBuf(data), k = key._m.secret;
      if (name === "AES-GCM") {
        var c = crypto.createCipheriv(aesName(key) + "-gcm", k, toBuf(algorithm.iv));
        if (algorithm.additionalData) c.setAAD(toBuf(algorithm.additionalData));
        var ct = Buffer.concat([c.update(pt), c.final()]);
        return Promise.resolve(toAB(Buffer.concat([ct, c.getAuthTag()])));
      }
      if (name === "AES-CBC") { var cc = crypto.createCipheriv(aesName(key) + "-cbc", k, toBuf(algorithm.iv)); return Promise.resolve(toAB(Buffer.concat([cc.update(pt), cc.final()]))); }
      if (name === "AES-CTR") { var ct2 = crypto.createCipheriv(aesName(key) + "-ctr", k, toBuf(algorithm.counter)); return Promise.resolve(toAB(Buffer.concat([ct2.update(pt), ct2.final()]))); }
      if (name === "RSA-OAEP") return Promise.resolve(toAB(crypto.publicEncrypt({ key: key._m.pem, oaepHash: nodeHash(key.algorithm.hash) }, pt)));
      throw new Error("Unsupported encrypt algorithm " + name);
    } catch (e) { return Promise.reject(e); }
  }

  function decrypt(algorithm, key, data) {
    try {
      algorithm = normAlg(algorithm);
      var name = algorithm.name;
      var crypto = getCrypto();
      var in_ = toBuf(data), k = key._m.secret;
      if (name === "AES-GCM") {
        var tag = in_.slice(in_.length - 16), ct = in_.slice(0, in_.length - 16);
        var d = crypto.createDecipheriv(aesName(key) + "-gcm", k, toBuf(algorithm.iv));
        if (algorithm.additionalData) d.setAAD(toBuf(algorithm.additionalData));
        d.setAuthTag(tag);
        return Promise.resolve(toAB(Buffer.concat([d.update(ct), d.final()])));
      }
      if (name === "AES-CBC") { var dc = crypto.createDecipheriv(aesName(key) + "-cbc", k, toBuf(algorithm.iv)); return Promise.resolve(toAB(Buffer.concat([dc.update(in_), dc.final()]))); }
      if (name === "AES-CTR") { var dt = crypto.createDecipheriv(aesName(key) + "-ctr", k, toBuf(algorithm.counter)); return Promise.resolve(toAB(Buffer.concat([dt.update(in_), dt.final()]))); }
      if (name === "RSA-OAEP") return Promise.resolve(toAB(crypto.privateDecrypt({ key: key._m.pem, oaepHash: nodeHash(key.algorithm.hash) }, in_)));
      throw new Error("Unsupported decrypt algorithm " + name);
    } catch (e) { return Promise.reject(e); }
  }

  function generateKey(algorithm, extractable, usages) {
    try {
      algorithm = normAlg(algorithm);
      var name = algorithm.name;
      var crypto = getCrypto();
      if (name === "HMAC") {
        var hlen = { sha1: 64, sha256: 64, sha384: 128, sha512: 128 }[nodeHash(algorithm.hash)] || 64;
        var len = algorithm.length ? (algorithm.length / 8 | 0) : hlen;
        return Promise.resolve(new CryptoKey("secret", { name: "HMAC", hash: hashObj(algorithm.hash), length: len * 8 }, extractable, usages, { secret: crypto.randomBytes(len) }));
      }
      if (name.indexOf("AES") === 0) {
        var alen = (algorithm.length || 256) / 8 | 0;
        return Promise.resolve(new CryptoKey("secret", { name: name, length: alen * 8 }, extractable, usages, { secret: crypto.randomBytes(alen) }));
      }
      if (name === "RSASSA-PKCS1-v1_5" || name === "RSA-PSS" || name === "RSA-OAEP")
        return Promise.resolve(keypairCK(name, fullAsymAlg(algorithm), extractable, usages, crypto.generateKeyPairSync("rsa", { modulusLength: algorithm.modulusLength || 2048 })));
      if (name === "ECDSA" || name === "ECDH")
        return Promise.resolve(keypairCK(name, fullAsymAlg(algorithm), extractable, usages, crypto.generateKeyPairSync("ec", { namedCurve: algorithm.namedCurve || "P-256" })));
      if (name === "Ed25519")
        return Promise.resolve(keypairCK(name, { name: name }, extractable, usages, crypto.generateKeyPairSync("ed25519")));
      throw new Error("Unsupported generateKey algorithm " + name);
    } catch (e) { return Promise.reject(e); }
  }

  function deriveBits(algorithm, baseKey, length) {
    try {
      algorithm = normAlg(algorithm);
      var name = algorithm.name;
      var crypto = getCrypto();
      var lenBytes = length / 8 | 0;
      if (name === "PBKDF2") return Promise.resolve(toAB(crypto.pbkdf2Sync(baseKey._m.secret, toBuf(algorithm.salt), algorithm.iterations, lenBytes, nodeHash(algorithm.hash))));
      if (name === "HKDF") return Promise.resolve(crypto.hkdfSync(nodeHash(algorithm.hash), baseKey._m.secret, toBuf(algorithm.salt), toBuf(algorithm.info || Buffer.alloc(0)), lenBytes));
      if (name === "ECDH") {
        // P-256 ECDH key agreement: raw scalar from the private PKCS8, raw point
        // (0x04||X||Y) from the public SPKI, computed via the node ECDH native.
        var crv = baseKey.algorithm.namedCurve || "P-256";
        if (crv !== "P-256") throw new Error("ECDH deriveBits supports P-256 only");
        var pubDer = pemToDer(algorithm.public._m.pem);
        var point = pubDer.slice(pubDer.length - 65); // uncompressed point
        var scalar = ecPrivScalar(pemToDer(baseKey._m.pem), 32);
        if (!scalar) throw new Error("could not extract EC private scalar");
        var ecdh = crypto.createECDH("prime256v1");
        ecdh.setPrivateKey(scalar);
        var secret = ecdh.computeSecret(point);
        // length null/undefined ⇒ the full field element (256 bits).
        return Promise.resolve(toAB(length == null ? secret : secret.slice(0, lenBytes)));
      }
      throw new Error("Unsupported deriveBits algorithm " + name);
    } catch (e) { return Promise.reject(e); }
  }
  function deriveKey(algorithm, baseKey, derivedKeyType, extractable, usages) {
    var dk = normAlg(derivedKeyType);
    var bits = dk.length || (dk.name && dk.name.indexOf("AES") === 0 ? dk.length || 256 : 256);
    return deriveBits(algorithm, baseKey, bits).then(function (ab) { return importKey("raw", ab, derivedKeyType, extractable, usages); });
  }

  // wrapKey/unwrapKey compose export+encrypt / decrypt+import.
  function wrapKey(format, key, wrappingKey, wrapAlgo) {
    return exportKey(format, key).then(function (exported) {
      var bytes = format === "jwk"
        ? toBuf(new TextEncoder().encode(JSON.stringify(exported)))
        : toBuf(exported);
      return encrypt(wrapAlgo, wrappingKey, bytes);
    });
  }
  function unwrapKey(format, wrappedKey, unwrappingKey, unwrapAlgo, unwrappedKeyAlgo, extractable, usages) {
    return decrypt(unwrapAlgo, unwrappingKey, wrappedKey).then(function (ab) {
      if (format === "jwk") {
        var jwk = JSON.parse(new TextDecoder().decode(new Uint8Array(ab)));
        return importKey("jwk", jwk, unwrappedKeyAlgo, extractable, usages);
      }
      return importKey(format, ab, unwrappedKeyAlgo, extractable, usages);
    });
  }

  function SubtleCrypto() {}
  SubtleCrypto.prototype = {
    digest: digest, importKey: importKey, exportKey: exportKey,
    sign: sign, verify: verify, encrypt: encrypt, decrypt: decrypt,
    generateKey: generateKey, deriveBits: deriveBits, deriveKey: deriveKey,
    wrapKey: wrapKey, unwrapKey: unwrapKey,
  };

  globalThis.CryptoKey = CryptoKey;
  globalThis.SubtleCrypto = SubtleCrypto;
  globalThis.crypto.subtle = new SubtleCrypto();
})();

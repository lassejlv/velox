//! Native crypto primitives: secure random bytes and message digests/HMAC.
//! The `node:crypto` shim (`src/builtins/crypto.js`) and the global `crypto`
//! object (`CRYPTO_PRELUDE`) are built on these. Data crosses as latin1 strings.

use std::ptr;

use aes::{Aes128, Aes192, Aes256};
use aes_gcm::aead::Aead;
use aes_gcm::{Aes128Gcm, Aes256Gcm, KeyInit as AeadKeyInit};
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{BlockDecryptMut, BlockEncryptMut, KeyIvInit, StreamCipher};
use digest::Digest;
use hmac::{Hmac, KeyInit, Mac};
use md5::Md5;
use objc2_javascript_core::{JSContextRef, JSObjectRef, JSValue, JSValueRef};
use sha1::Sha1;
use sha2::{Sha224, Sha256, Sha384, Sha512};

use crate::event_loop::{arg_slice, register};
use crate::node::{call_named, js_string, js_string_latin1, js_value_to_latin1};
use crate::runtime::js_value_to_string;

/// Installs `globalThis.crypto` (Web Crypto subset) on top of the natives.
pub const CRYPTO_PRELUDE: &str = r#"
(function () {
  if (globalThis.crypto && globalThis.crypto.getRandomValues) return;
  function getRandomValues(view) {
    var bytes = Buffer.from(__velox_random_bytes(view.byteLength), "latin1");
    new Uint8Array(view.buffer, view.byteOffset, view.byteLength).set(bytes);
    return view;
  }
  function randomUUID() {
    var b = Buffer.from(__velox_random_bytes(16), "latin1");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = b.toString("hex");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }
  globalThis.crypto = {
    getRandomValues: getRandomValues,
    randomUUID: randomUUID,
    subtle: {
      digest: function (algo, data) {
        var name = String(algo && algo.name ? algo.name : algo).toLowerCase().replace(/-/g, "");
        var latin1 = __velox_hash(name, Buffer.from(data).toString("latin1"));
        var out = Buffer.from(latin1, "latin1");
        return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
      },
    },
  };
})();
"#;

/// Full `crypto.subtle` (SubtleCrypto) built on top of `node:crypto`. Evaluated
/// after the Velox prelude so the global `require` is available; replaces the
/// digest-only `subtle` from `CRYPTO_PRELUDE`.
pub const WEB_CRYPTO_PRELUDE: &str = include_str!("builtins/web_crypto.js");

/// Register the native crypto functions.
pub fn install(ctx: JSContextRef) {
    unsafe {
        register(ctx, c"__velox_random_bytes", random_bytes);
        register(ctx, c"__velox_hash", hash_fn);
        register(ctx, c"__velox_hmac", hmac_fn);
        register(ctx, c"__velox_pbkdf2", pbkdf2_fn);
        register(ctx, c"__velox_scrypt", scrypt_fn);
        register(ctx, c"__velox_cipher", cipher_fn);
        register(ctx, c"__velox_gen_ed25519", gen_ed25519_fn);
        register(ctx, c"__velox_gen_ec", gen_ec_fn);
        register(ctx, c"__velox_gen_rsa", gen_rsa_fn);
        register(ctx, c"__velox_rsa_encrypt", rsa_encrypt_fn);
        register(ctx, c"__velox_rsa_decrypt", rsa_decrypt_fn);
        register(ctx, c"__velox_sign_ed25519", sign_ed25519_fn);
        register(ctx, c"__velox_verify_ed25519", verify_ed25519_fn);
        register(ctx, c"__velox_ecdh_generate", ecdh_generate_fn);
        register(ctx, c"__velox_ecdh_pub", ecdh_pub_fn);
        register(ctx, c"__velox_ecdh_compute", ecdh_compute_fn);
        register(ctx, c"__velox_gen_x25519", gen_x25519_fn);
        register(ctx, c"__velox_x25519_dh", x25519_dh_fn);
        register(ctx, c"__velox_x509_parse", x509_parse_fn);
    }
}

/// RFC 8410 PKCS#8 prefix for an X25519 private key (OID 1.3.101.110), followed
/// by the 32-byte scalar.
const X25519_PKCS8_PREFIX: &[u8] = &[
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20,
];
/// RFC 8410 SubjectPublicKeyInfo prefix for an X25519 public key, followed by
/// the 32-byte point.
const X25519_SPKI_PREFIX: &[u8] = &[
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x03, 0x21, 0x00,
];

/// `__velox_gen_x25519()` → JSON `{publicKey, privateKey}` (PEM).
unsafe extern "C-unwind" fn gen_x25519_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    match gen_x25519() {
        Ok((public_pem, private_pem)) => {
            let json = serde_json::json!({ "publicKey": public_pem, "privateKey": private_pem });
            unsafe { js_string(ctx, &json.to_string()) }
        }
        Err(e) => unsafe { throw(ctx, exception, &e) },
    }
}

fn gen_x25519() -> Result<(String, String), String> {
    use x25519_dalek::{PublicKey, StaticSecret};
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|_| "random failure".to_string())?;
    let secret = StaticSecret::from(seed);
    let public = PublicKey::from(&secret);
    let mut pkcs8 = X25519_PKCS8_PREFIX.to_vec();
    pkcs8.extend_from_slice(&secret.to_bytes());
    let mut spki = X25519_SPKI_PREFIX.to_vec();
    spki.extend_from_slice(public.as_bytes());
    Ok((
        pem_encode("PUBLIC KEY", &spki),
        pem_encode("PRIVATE KEY", &pkcs8),
    ))
}

/// `__velox_x25519_dh(privateKeyPem, publicKeyPem)` → the 32-byte shared secret
/// (latin1). The raw 32-byte scalar/point are the trailing bytes of each DER.
unsafe extern "C-unwind" fn x25519_dh_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let priv_pem = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let pub_pem = args
        .get(1)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    match x25519_dh(&priv_pem, &pub_pem) {
        Ok(secret) => unsafe { js_string_latin1(ctx, &secret) },
        Err(e) => unsafe { throw(ctx, exception, &e) },
    }
}

fn x25519_dh(priv_pem: &str, pub_pem: &str) -> Result<Vec<u8>, String> {
    use x25519_dalek::{PublicKey, StaticSecret};
    let priv_der = pem_decode(priv_pem)?;
    let pub_der = pem_decode(pub_pem)?;
    if priv_der.len() < 32 || pub_der.len() < 32 {
        return Err("invalid X25519 key".to_string());
    }
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&priv_der[priv_der.len() - 32..]);
    let mut point = [0u8; 32];
    point.copy_from_slice(&pub_der[pub_der.len() - 32..]);
    let secret = StaticSecret::from(seed);
    Ok(secret
        .diffie_hellman(&PublicKey::from(point))
        .to_bytes()
        .to_vec())
}

// --- ECDH key agreement (P-256, via the p256 crate) ------------------------

/// `__velox_ecdh_generate()` → JSON `{ priv, pub }` (latin1: 32-byte scalar,
/// 65-byte uncompressed SEC1 point).
unsafe extern "C-unwind" fn ecdh_generate_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    let mut rng = [0u8; 32];
    if getrandom::fill(&mut rng).is_err() {
        return unsafe { throw(ctx, exception, "ECDH key generation failed") };
    }
    // Reduce random bytes into a valid non-zero scalar by retrying via from_bytes.
    let secret = loop {
        if let Ok(s) = p256::SecretKey::from_slice(&rng) {
            break s;
        }
        // Perturb and retry (extremely rare for random 32 bytes to be invalid).
        rng[0] ^= 0x01;
    };
    let priv_bytes = secret.to_bytes();
    let pub_point = secret.public_key().to_encoded_point(false);
    let json = serde_json::json!({
        "priv": latin1_string(priv_bytes.as_slice()),
        "pub": latin1_string(pub_point.as_bytes()),
    });
    unsafe { js_string(ctx, &json.to_string()) }
}

/// `__velox_ecdh_pub(privLatin1, compressed)` → latin1 SEC1 public point.
unsafe extern "C-unwind" fn ecdh_pub_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    use p256::elliptic_curve::sec1::ToEncodedPoint;
    let args = arg_slice(argc, argv);
    let priv_bytes = arg_bytes(ctx, args, 0);
    let compressed = args
        .get(1)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(false);
    match p256::SecretKey::from_slice(&priv_bytes) {
        Ok(secret) => {
            let point = secret.public_key().to_encoded_point(compressed);
            unsafe { js_string_latin1(ctx, point.as_bytes()) }
        }
        Err(_) => unsafe { throw(ctx, exception, "invalid ECDH private key") },
    }
}

/// `__velox_ecdh_compute(privLatin1, otherPubLatin1)` → latin1 shared secret
/// (32-byte X coordinate), matching Node's `ECDH.computeSecret`.
unsafe extern "C-unwind" fn ecdh_compute_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let priv_bytes = arg_bytes(ctx, args, 0);
    let pub_bytes = arg_bytes(ctx, args, 1);
    let secret = match p256::SecretKey::from_slice(&priv_bytes) {
        Ok(s) => s,
        Err(_) => return unsafe { throw(ctx, exception, "invalid ECDH private key") },
    };
    let public = match p256::PublicKey::from_sec1_bytes(&pub_bytes) {
        Ok(p) => p,
        Err(_) => return unsafe { throw(ctx, exception, "invalid ECDH public key") },
    };
    let shared = p256::ecdh::diffie_hellman(secret.to_nonzero_scalar(), public.as_affine());
    unsafe { js_string_latin1(ctx, shared.raw_secret_bytes().as_slice()) }
}

/// Encode raw bytes as a latin1 `String` (one byte → one char) for JSON embedding.
fn latin1_string(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

// --- asymmetric signing: Ed25519 + ECDSA P-256 (via ring) ------------------

/// SubjectPublicKeyInfo DER prefix for an Ed25519 public key (RFC 8410).
const ED25519_SPKI_PREFIX: &[u8] = &[
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

/// SubjectPublicKeyInfo DER prefix for an EC P-256 (prime256v1) public key.
const P256_SPKI_PREFIX: &[u8] = &[
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

/// `__velox_gen_ed25519()` → JSON `{publicKey, privateKey}` (PEM).
unsafe extern "C-unwind" fn gen_ed25519_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    match gen_ed25519() {
        Ok((public_pem, private_pem)) => {
            let json = serde_json::json!({ "publicKey": public_pem, "privateKey": private_pem });
            unsafe { js_string(ctx, &json.to_string()) }
        }
        Err(e) => unsafe { throw(ctx, exception, &e) },
    }
}

/// `__velox_sign_ed25519(privateKeyPem, data)` → signature.
unsafe extern "C-unwind" fn sign_ed25519_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let key = arg_str(ctx, args, 0);
    let data = arg_bytes(ctx, args, 1);
    match sign_ed25519(&key, &data) {
        Ok(sig) => unsafe { js_string_latin1(ctx, &sig) },
        Err(e) => unsafe { throw(ctx, exception, &e) },
    }
}

/// `__velox_verify_ed25519(publicKeyPem, data, signature)` → boolean.
unsafe extern "C-unwind" fn verify_ed25519_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let key = arg_str(ctx, args, 0);
    let data = arg_bytes(ctx, args, 1);
    let sig = arg_bytes(ctx, args, 2);
    unsafe { JSValue::new_boolean(ctx, verify_ed25519(&key, &data, &sig)) }
}

fn gen_ed25519() -> Result<(String, String), String> {
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    let rng = SystemRandom::new();
    let pkcs8 =
        Ed25519KeyPair::generate_pkcs8(&rng).map_err(|_| "key generation failed".to_string())?;
    let keypair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref())
        .map_err(|_| "key generation failed".to_string())?;

    let private_pem = pem_encode("PRIVATE KEY", pkcs8.as_ref());
    let mut spki = ED25519_SPKI_PREFIX.to_vec();
    spki.extend_from_slice(keypair.public_key().as_ref());
    let public_pem = pem_encode("PUBLIC KEY", &spki);
    Ok((public_pem, private_pem))
}

/// `__velox_gen_ec()` → JSON `{publicKey, privateKey}` (PEM) for EC P-256.
unsafe extern "C-unwind" fn gen_ec_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    _argc: usize,
    _argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    match gen_ec() {
        Ok((public_pem, private_pem)) => {
            let json = serde_json::json!({ "publicKey": public_pem, "privateKey": private_pem });
            unsafe { js_string(ctx, &json.to_string()) }
        }
        Err(e) => unsafe { throw(ctx, exception, &e) },
    }
}

/// `__velox_gen_rsa(modulusLength)` → JSON `{publicKey, privateKey}` (PEM) for RSA.
unsafe extern "C-unwind" fn gen_rsa_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let bits = {
        let n = arg_num(ctx, args, 0) as usize;
        if n == 0 { 2048 } else { n }
    };
    match gen_rsa(bits) {
        Ok((public_pem, private_pem)) => {
            let json = serde_json::json!({ "publicKey": public_pem, "privateKey": private_pem });
            unsafe { js_string(ctx, &json.to_string()) }
        }
        Err(e) => unsafe { throw(ctx, exception, &e) },
    }
}

fn gen_rsa(bits: usize) -> Result<(String, String), String> {
    use rsa::pkcs1::LineEnding;
    use rsa::pkcs8::{EncodePrivateKey, EncodePublicKey};
    use rsa::{RsaPrivateKey, RsaPublicKey};

    if !(512..=4096).contains(&bits) {
        return Err(format!("unsupported RSA modulus length {bits}"));
    }
    let mut rng = rand::thread_rng();
    let private = RsaPrivateKey::new(&mut rng, bits).map_err(|e| format!("RSA keygen: {e}"))?;
    let public = RsaPublicKey::from(&private);
    // PKCS#8 private key + SPKI public key, both PEM — the shapes our ring-based
    // sign/verify already accept.
    let private_pem = private
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| e.to_string())?
        .to_string();
    let public_pem = public
        .to_public_key_pem(LineEnding::LF)
        .map_err(|e| e.to_string())?;
    Ok((public_pem, private_pem))
}

/// `__velox_rsa_encrypt(publicKeyPem, dataLatin1, hash)` → OAEP ciphertext
/// (latin1). Backs `crypto.publicEncrypt` (OAEP) and Web Crypto RSA-OAEP.
unsafe extern "C-unwind" fn rsa_encrypt_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let pem = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let data = args
        .get(1)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default();
    let hash = args
        .get(2)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_else(|| "sha256".to_string());
    match rsa_oaep_encrypt(&pem, &data, &hash) {
        Ok(ct) => unsafe { js_string_latin1(ctx, &ct) },
        Err(e) => unsafe { throw(ctx, exception, &e) },
    }
}

/// `__velox_rsa_decrypt(privateKeyPem, dataLatin1, hash)` → OAEP plaintext.
unsafe extern "C-unwind" fn rsa_decrypt_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let pem = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let data = args
        .get(1)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default();
    let hash = args
        .get(2)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_else(|| "sha256".to_string());
    match rsa_oaep_decrypt(&pem, &data, &hash) {
        Ok(pt) => unsafe { js_string_latin1(ctx, &pt) },
        Err(e) => unsafe { throw(ctx, exception, &e) },
    }
}

// OAEP MGF1/label hash. SHA-256 (the Web Crypto default) / 384 / 512; anything
// else falls back to SHA-256 (SHA-1 OAEP is legacy and not offered).
fn oaep_padding(hash: &str) -> rsa::Oaep {
    match hash.to_lowercase().replace('-', "").as_str() {
        "sha384" => rsa::Oaep::new::<sha2_oaep::Sha384>(),
        "sha512" => rsa::Oaep::new::<sha2_oaep::Sha512>(),
        _ => rsa::Oaep::new::<sha2_oaep::Sha256>(),
    }
}

fn rsa_oaep_encrypt(pem: &str, data: &[u8], hash: &str) -> Result<Vec<u8>, String> {
    use rsa::RsaPublicKey;
    use rsa::pkcs8::DecodePublicKey;
    let key = RsaPublicKey::from_public_key_pem(pem).map_err(|e| format!("RSA public key: {e}"))?;
    let mut rng = rand::thread_rng();
    key.encrypt(&mut rng, oaep_padding(hash), data)
        .map_err(|e| format!("RSA-OAEP encrypt: {e}"))
}

fn rsa_oaep_decrypt(pem: &str, data: &[u8], hash: &str) -> Result<Vec<u8>, String> {
    use rsa::RsaPrivateKey;
    use rsa::pkcs8::DecodePrivateKey;
    let key = RsaPrivateKey::from_pkcs8_pem(pem).map_err(|e| format!("RSA private key: {e}"))?;
    key.decrypt(oaep_padding(hash), data)
        .map_err(|e| format!("RSA-OAEP decrypt: {e}"))
}

fn gen_ec() -> Result<(String, String), String> {
    use ring::rand::SystemRandom;
    use ring::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, KeyPair};

    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng)
        .map_err(|_| "EC key generation failed".to_string())?;
    let keypair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng)
        .map_err(|_| "EC key generation failed".to_string())?;

    let private_pem = pem_encode("PRIVATE KEY", pkcs8.as_ref());
    let mut spki = P256_SPKI_PREFIX.to_vec();
    spki.extend_from_slice(keypair.public_key().as_ref());
    let public_pem = pem_encode("PUBLIC KEY", &spki);
    Ok((public_pem, private_pem))
}

/// Sign with whichever key type the PEM holds (Ed25519, ECDSA P-256, or RSA).
fn sign_ed25519(private_pem: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    use ring::rand::SystemRandom;
    use ring::signature::{
        ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, Ed25519KeyPair, RSA_PKCS1_SHA256, RsaKeyPair,
    };

    let der = pem_decode(private_pem)?;
    if let Ok(keypair) = Ed25519KeyPair::from_pkcs8(&der) {
        return Ok(keypair.sign(data).as_ref().to_vec());
    }
    let rng = SystemRandom::new();
    if let Ok(keypair) = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &der, &rng) {
        return keypair
            .sign(&rng, data)
            .map(|s| s.as_ref().to_vec())
            .map_err(|_| "signing failed".to_string());
    }
    if let Ok(keypair) = RsaKeyPair::from_pkcs8(&der) {
        let mut sig = vec![0u8; keypair.public().modulus_len()];
        keypair
            .sign(&RSA_PKCS1_SHA256, &rng, data, &mut sig)
            .map_err(|_| "RSA signing failed".to_string())?;
        return Ok(sig);
    }
    Err("unsupported private key (expected Ed25519, EC P-256, or RSA)".to_string())
}

/// Verify, dispatching on the public key's SPKI prefix / algorithm.
fn verify_ed25519(public_pem: &str, data: &[u8], signature: &[u8]) -> bool {
    use ring::signature::{
        ECDSA_P256_SHA256_ASN1, ED25519, RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey,
    };
    let Ok(der) = pem_decode(public_pem) else {
        return false;
    };
    if der.len() == 32 {
        return UnparsedPublicKey::new(&ED25519, &der)
            .verify(data, signature)
            .is_ok();
    }
    if der.starts_with(ED25519_SPKI_PREFIX) {
        let key = &der[ED25519_SPKI_PREFIX.len()..];
        return UnparsedPublicKey::new(&ED25519, key)
            .verify(data, signature)
            .is_ok();
    }
    if der.starts_with(P256_SPKI_PREFIX) {
        let key = &der[P256_SPKI_PREFIX.len()..];
        return UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, key)
            .verify(data, signature)
            .is_ok();
    }
    if let Some(pkcs1) = spki_to_rsa_pkcs1(&der) {
        return UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, &pkcs1)
            .verify(data, signature)
            .is_ok();
    }
    false
}

/// Extract the PKCS#1 `RSAPublicKey` DER from an X.509 SPKI DER (ring's RSA
/// verifier wants the bare PKCS#1 key, not the SPKI wrapper).
fn spki_to_rsa_pkcs1(spki: &[u8]) -> Option<Vec<u8>> {
    let (seq, _) = der_tlv(spki)?; // outer SEQUENCE value
    let (_algid, after_algid) = der_tlv(seq)?; // skip AlgorithmIdentifier
    let (bitstring, _) = der_tlv(after_algid)?; // BIT STRING value (with unused-bits byte)
    bitstring.get(1..).map(<[u8]>::to_vec) // drop the unused-bits byte
}

/// Read one DER TLV: returns `(value, rest_after_this_tlv)`.
fn der_tlv(input: &[u8]) -> Option<(&[u8], &[u8])> {
    if input.len() < 2 {
        return None;
    }
    let (len, header) = der_len(&input[1..])?;
    let start = 1 + header;
    let end = start.checked_add(len)?;
    if end > input.len() {
        return None;
    }
    Some((&input[start..end], &input[end..]))
}

/// Decode a DER length; returns `(length, bytes_consumed)`.
fn der_len(input: &[u8]) -> Option<(usize, usize)> {
    let first = *input.first()?;
    if first < 0x80 {
        return Some((first as usize, 1));
    }
    let n = (first & 0x7f) as usize;
    if n == 0 || n > 4 || input.len() < 1 + n {
        return None;
    }
    let mut len = 0usize;
    for &b in &input[1..1 + n] {
        len = (len << 8) | b as usize;
    }
    Some((len, 1 + n))
}

fn pem_encode(label: &str, der: &[u8]) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

fn pem_decode(pem: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let b64: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| e.to_string())
}

/// `__velox_pbkdf2(digest, password, salt, iterations, keylen)` → derived key.
unsafe extern "C-unwind" fn pbkdf2_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let digest = arg_str(ctx, args, 0);
    let password = arg_bytes(ctx, args, 1);
    let salt = arg_bytes(ctx, args, 2);
    let iterations = arg_num(ctx, args, 3) as u32;
    let keylen = arg_num(ctx, args, 4) as usize;
    match pbkdf2_derive(&digest, &password, &salt, iterations.max(1), keylen) {
        Some(out) => unsafe { js_string_latin1(ctx, &out) },
        None => unsafe {
            throw(
                ctx,
                exception,
                &format!("unsupported pbkdf2 digest: {digest}"),
            )
        },
    }
}

/// `__velox_scrypt(password, salt, N, r, p, keylen)` → derived key.
unsafe extern "C-unwind" fn scrypt_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let password = arg_bytes(ctx, args, 0);
    let salt = arg_bytes(ctx, args, 1);
    let n = arg_num(ctx, args, 2) as u64;
    let r = arg_num(ctx, args, 3) as u32;
    let p = arg_num(ctx, args, 4) as u32;
    let keylen = arg_num(ctx, args, 5) as usize;
    match scrypt_derive(&password, &salt, n, r, p, keylen) {
        Some(out) => unsafe { js_string_latin1(ctx, &out) },
        None => unsafe { throw(ctx, exception, "invalid scrypt parameters") },
    }
}

/// `__velox_cipher(op, algo, key, iv, data, aad)` → ciphertext/plaintext. For
/// GCM, the 16-byte auth tag is appended to (encrypt) / expected at the end of
/// (decrypt) the data.
unsafe extern "C-unwind" fn cipher_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let op = arg_str(ctx, args, 0);
    let algo = arg_str(ctx, args, 1);
    let key = arg_bytes(ctx, args, 2);
    let iv = arg_bytes(ctx, args, 3);
    let data = arg_bytes(ctx, args, 4);
    let aad = arg_bytes(ctx, args, 5);
    match aes_cipher(&op, &algo, &key, &iv, &data, &aad) {
        Ok(out) => unsafe { js_string_latin1(ctx, &out) },
        Err(e) => unsafe { throw(ctx, exception, &e) },
    }
}

fn pbkdf2_derive(
    digest: &str,
    password: &[u8],
    salt: &[u8],
    iters: u32,
    keylen: usize,
) -> Option<Vec<u8>> {
    use pbkdf2::pbkdf2_hmac;
    let mut out = vec![0u8; keylen];
    match normalize(digest).as_str() {
        "sha1" => pbkdf2_hmac::<Sha1>(password, salt, iters, &mut out),
        "sha224" => pbkdf2_hmac::<Sha224>(password, salt, iters, &mut out),
        "sha256" => pbkdf2_hmac::<Sha256>(password, salt, iters, &mut out),
        "sha384" => pbkdf2_hmac::<Sha384>(password, salt, iters, &mut out),
        "sha512" => pbkdf2_hmac::<Sha512>(password, salt, iters, &mut out),
        _ => return None,
    }
    Some(out)
}

fn scrypt_derive(
    password: &[u8],
    salt: &[u8],
    n: u64,
    r: u32,
    p: u32,
    keylen: usize,
) -> Option<Vec<u8>> {
    let log_n = (n as f64).log2().round() as u8;
    let params = scrypt::Params::new(log_n, r, p).ok()?;
    let mut out = vec![0u8; keylen];
    scrypt::scrypt(password, salt, &params, &mut out).ok()?;
    Some(out)
}

fn aes_cipher(
    op: &str,
    algo: &str,
    key: &[u8],
    iv: &[u8],
    data: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    let encrypt = op == "encrypt";
    macro_rules! cbc_mode {
        ($aes:ty) => {{
            if encrypt {
                let enc =
                    cbc::Encryptor::<$aes>::new_from_slices(key, iv).map_err(|e| e.to_string())?;
                Ok(enc.encrypt_padded_vec_mut::<Pkcs7>(data))
            } else {
                let dec =
                    cbc::Decryptor::<$aes>::new_from_slices(key, iv).map_err(|e| e.to_string())?;
                dec.decrypt_padded_vec_mut::<Pkcs7>(data)
                    .map_err(|e| e.to_string())
            }
        }};
    }
    macro_rules! ctr_mode {
        ($aes:ty) => {{
            let mut c =
                ctr::Ctr128BE::<$aes>::new_from_slices(key, iv).map_err(|e| e.to_string())?;
            let mut buf = data.to_vec();
            c.apply_keystream(&mut buf);
            Ok(buf)
        }};
    }
    macro_rules! gcm_mode {
        ($gcm:ty) => {{
            let cipher = <$gcm>::new_from_slice(key).map_err(|e| e.to_string())?;
            let nonce = aes_gcm::Nonce::from_slice(iv);
            let payload = aes_gcm::aead::Payload { msg: data, aad };
            if encrypt {
                cipher.encrypt(nonce, payload).map_err(|e| e.to_string())
            } else {
                cipher
                    .decrypt(nonce, payload)
                    .map_err(|_| "unable to authenticate data".to_string())
            }
        }};
    }
    match normalize_cipher(algo).as_str() {
        "aes-128-cbc" => cbc_mode!(Aes128),
        "aes-192-cbc" => cbc_mode!(Aes192),
        "aes-256-cbc" => cbc_mode!(Aes256),
        "aes-128-ctr" => ctr_mode!(Aes128),
        "aes-192-ctr" => ctr_mode!(Aes192),
        "aes-256-ctr" => ctr_mode!(Aes256),
        "aes-128-gcm" => gcm_mode!(Aes128Gcm),
        "aes-256-gcm" => gcm_mode!(Aes256Gcm),
        "chacha20-poly1305" => {
            use chacha20poly1305::aead::{Aead, KeyInit, Payload};
            let cipher = chacha20poly1305::ChaCha20Poly1305::new_from_slice(key)
                .map_err(|e| e.to_string())?;
            let nonce = chacha20poly1305::Nonce::from_slice(iv);
            let payload = Payload { msg: data, aad };
            if encrypt {
                cipher.encrypt(nonce, payload).map_err(|e| e.to_string())
            } else {
                cipher
                    .decrypt(nonce, payload)
                    .map_err(|_| "unable to authenticate data".to_string())
            }
        }
        other => Err(format!("unsupported cipher: {other}")),
    }
}

fn normalize_cipher(algo: &str) -> String {
    algo.to_ascii_lowercase()
}

fn arg_str(ctx: JSContextRef, args: &[JSValueRef], i: usize) -> String {
    args.get(i)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default()
}
fn arg_bytes(ctx: JSContextRef, args: &[JSValueRef], i: usize) -> Vec<u8> {
    args.get(i)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default()
}
fn arg_num(ctx: JSContextRef, args: &[JSValueRef], i: usize) -> f64 {
    args.get(i)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0)
}

/// `__velox_random_bytes(n)` → n secure random bytes as a latin1 string.
unsafe extern "C-unwind" fn random_bytes(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let n = args
        .first()
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0)
        .max(0.0) as usize;
    let n = n.min(64 * 1024 * 1024); // cap to keep things sane
    let mut buf = vec![0u8; n];
    let _ = getrandom::fill(&mut buf);
    unsafe { js_string_latin1(ctx, &buf) }
}

/// `__velox_hash(algo, latin1data)` → digest as a latin1 string.
unsafe extern "C-unwind" fn hash_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let algo = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let data = args
        .get(1)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default();
    // args[2] (optional): output length in bytes for XOF hashes (shake128/256).
    let out_len = args
        .get(2)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(0.0) as usize;
    match digest(&algo, &data, out_len) {
        Some(out) => unsafe { js_string_latin1(ctx, &out) },
        None => unsafe {
            throw(
                ctx,
                exception,
                &format!("Digest method not supported: {algo}"),
            )
        },
    }
}

/// `__velox_hmac(algo, latin1key, latin1data)` → HMAC as a latin1 string.
unsafe extern "C-unwind" fn hmac_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let algo = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    let key = args
        .get(1)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default();
    let data = args
        .get(2)
        .map(|v| unsafe { js_value_to_latin1(ctx, *v) })
        .unwrap_or_default();
    match hmac_digest(&algo, &key, &data) {
        Some(out) => unsafe { js_string_latin1(ctx, &out) },
        None => unsafe {
            throw(
                ctx,
                exception,
                &format!("HMAC algorithm not supported: {algo}"),
            )
        },
    }
}

fn digest(algo: &str, data: &[u8], out_len: usize) -> Option<Vec<u8>> {
    use sha3::digest::{ExtendableOutput, Update, XofReader};
    let shake = |mut x: sha3::Shake256, n: usize| -> Vec<u8> {
        x.update(data);
        let mut r = x.finalize_xof();
        let mut buf = vec![0u8; n];
        r.read(&mut buf);
        buf
    };
    let shake128 = |mut x: sha3::Shake128, n: usize| -> Vec<u8> {
        x.update(data);
        let mut r = x.finalize_xof();
        let mut buf = vec![0u8; n];
        r.read(&mut buf);
        buf
    };
    Some(match normalize(algo).as_str() {
        "md5" => Md5::digest(data).to_vec(),
        "sha1" => Sha1::digest(data).to_vec(),
        "sha224" => Sha224::digest(data).to_vec(),
        "sha256" => Sha256::digest(data).to_vec(),
        "sha384" => Sha384::digest(data).to_vec(),
        "sha512" => Sha512::digest(data).to_vec(),
        "sha3256" => sha3::Sha3_256::digest(data).to_vec(),
        "sha3384" => sha3::Sha3_384::digest(data).to_vec(),
        "sha3512" => sha3::Sha3_512::digest(data).to_vec(),
        "shake128" => shake128(
            sha3::Shake128::default(),
            if out_len > 0 { out_len } else { 16 },
        ),
        "shake256" => shake(
            sha3::Shake256::default(),
            if out_len > 0 { out_len } else { 32 },
        ),
        _ => return None,
    })
}

fn hmac_digest(algo: &str, key: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    macro_rules! mac {
        ($hash:ty) => {{
            let mut m = Hmac::<$hash>::new_from_slice(key).ok()?;
            m.update(data);
            m.finalize().into_bytes().to_vec()
        }};
    }
    Some(match normalize(algo).as_str() {
        "md5" => mac!(Md5),
        "sha1" => mac!(Sha1),
        "sha224" => mac!(Sha224),
        "sha256" => mac!(Sha256),
        "sha384" => mac!(Sha384),
        "sha512" => mac!(Sha512),
        _ => return None,
    })
}

fn normalize(algo: &str) -> String {
    algo.to_ascii_lowercase().replace('-', "")
}

/// Throw an `Error` (with a `.code`) by setting the callback's exception slot.
/// `__velox_x509_parse(latin1)` → JSON of an X.509 certificate's fields. The
/// argument is the cert as latin1-encoded bytes (PEM text or raw DER). Binary
/// outputs (`rawHex`, `publicKeyDerHex`) are hex so they survive the JSON hop.
/// Backs the `crypto.X509Certificate` shim in `builtins/crypto.js`.
unsafe extern "C-unwind" fn x509_parse_fn(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let bytes = match args.first() {
        Some(v) => unsafe { js_value_to_latin1(ctx, *v) },
        None => return unsafe { throw(ctx, exception, "X509Certificate: missing input") },
    };
    match x509_parse(&bytes) {
        Ok(json) => unsafe { js_string(ctx, &json) },
        Err(e) => unsafe { throw(ctx, exception, &e) },
    }
}

fn x509_hex_upper(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02X}"));
    }
    s
}

fn x509_fingerprint<D: digest::Digest>(der: &[u8]) -> String {
    D::digest(der)
        .iter()
        .map(|b| format!("{b:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// RFC 4514 names are most-specific-first and comma-joined; Node's `.subject`/
/// `.issuer` are least-specific-first and newline-joined.
fn x509_node_name(rfc4514: &str) -> String {
    rfc4514
        .split(',')
        .map(|s| s.trim())
        .rev()
        .collect::<Vec<_>>()
        .join("\n")
}

fn x509_fmt_time(t: &x509_cert::time::Time) -> (String, i128) {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let dt = t.to_date_time();
    let mon = MONTHS[(dt.month() as usize).clamp(1, 12) - 1];
    let s = format!(
        "{mon} {:>2} {:02}:{:02}:{:02} {} GMT",
        dt.day(),
        dt.hour(),
        dt.minutes(),
        dt.seconds(),
        dt.year()
    );
    (s, t.to_unix_duration().as_millis() as i128)
}

fn x509_parse_san(der: &[u8]) -> Option<String> {
    use x509_cert::der::Decode;
    use x509_cert::ext::pkix::name::GeneralName;
    let san = x509_cert::ext::pkix::SubjectAltName::from_der(der).ok()?;
    let parts: Vec<String> = san
        .0
        .iter()
        .filter_map(|gn| match gn {
            GeneralName::DnsName(d) => Some(format!("DNS:{}", d.as_str())),
            GeneralName::Rfc822Name(e) => Some(format!("email:{}", e.as_str())),
            GeneralName::UniformResourceIdentifier(u) => Some(format!("URI:{}", u.as_str())),
            GeneralName::IpAddress(ip) => {
                let b = ip.as_bytes();
                match b.len() {
                    4 => Some(format!("IP Address:{}.{}.{}.{}", b[0], b[1], b[2], b[3])),
                    16 => {
                        let segs: Vec<String> = b
                            .chunks(2)
                            .map(|c| format!("{:x}", ((c[0] as u16) << 8) | c[1] as u16))
                            .collect();
                        Some(format!("IP Address:{}", segs.join(":")))
                    }
                    _ => None,
                }
            }
            _ => None,
        })
        .collect();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

fn x509_parse(input: &[u8]) -> Result<String, String> {
    use x509_cert::Certificate;
    use x509_cert::der::{Decode, DecodePem, Encode};

    let cert = if input.starts_with(b"-----BEGIN") {
        Certificate::from_pem(input).map_err(|e| format!("X509 PEM parse: {e}"))?
    } else {
        Certificate::from_der(input).map_err(|e| format!("X509 DER parse: {e}"))?
    };
    let der = cert.to_der().map_err(|e| format!("X509 re-encode: {e}"))?;
    let tbs = &cert.tbs_certificate;

    let (valid_from, valid_from_ms) = x509_fmt_time(&tbs.validity.not_before);
    let (valid_to, valid_to_ms) = x509_fmt_time(&tbs.validity.not_after);
    let spki_der = tbs
        .subject_public_key_info
        .to_der()
        .map_err(|e| format!("X509 spki: {e}"))?;

    let mut san: Option<String> = None;
    let mut ext_key_usage: Option<Vec<String>> = None;
    let mut ca = false;
    if let Some(exts) = &tbs.extensions {
        for ext in exts {
            match ext.extn_id.to_string().as_str() {
                "2.5.29.17" => san = x509_parse_san(ext.extn_value.as_bytes()),
                "2.5.29.19" => {
                    if let Ok(bc) =
                        x509_cert::ext::pkix::BasicConstraints::from_der(ext.extn_value.as_bytes())
                    {
                        ca = bc.ca;
                    }
                }
                "2.5.29.37" => {
                    if let Ok(eku) =
                        x509_cert::ext::pkix::ExtendedKeyUsage::from_der(ext.extn_value.as_bytes())
                    {
                        ext_key_usage = Some(eku.0.iter().map(|o| o.to_string()).collect());
                    }
                }
                _ => {}
            }
        }
    }

    let json = serde_json::json!({
        "subject": x509_node_name(&tbs.subject.to_string()),
        "issuer": x509_node_name(&tbs.issuer.to_string()),
        "serialNumber": x509_hex_upper(tbs.serial_number.as_bytes()),
        "validFrom": valid_from,
        "validTo": valid_to,
        "validFromMs": valid_from_ms as f64,
        "validToMs": valid_to_ms as f64,
        "fingerprint": x509_fingerprint::<sha1::Sha1>(&der),
        "fingerprint256": x509_fingerprint::<Sha256>(&der),
        "fingerprint512": x509_fingerprint::<Sha512>(&der),
        "subjectAltName": san,
        "keyUsage": ext_key_usage,
        "ca": ca,
        "rawHex": x509_hex_upper(&der),
        "publicKeyDerHex": x509_hex_upper(&spki_der),
    });
    Ok(json.to_string())
}

unsafe fn throw(ctx: JSContextRef, exception: *mut JSValueRef, message: &str) -> JSValueRef {
    unsafe {
        let args = [js_string(ctx, "ERR_CRYPTO"), js_string(ctx, message)];
        let error = call_named(ctx, c"__velox_fs_error", &args);
        if !exception.is_null() {
            *exception = error;
        }
        JSValue::new_undefined(ctx)
    }
}

// RSA key generation + RS256 sign/verify (via the `rsa` crate for keygen, `ring`
// for sign/verify). 2048-bit, since ring won't sign with smaller RSA keys.
//
//   cargo run -- examples/rsa-keygen.ts

const crypto = require("node:crypto");

console.time("rsa-2048 keygen");
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
console.timeEnd("rsa-2048 keygen");

const data = Buffer.from("the quick brown fox");
const sig = crypto.sign("sha256", data, privateKey);
console.log("RS256 verify        :", crypto.verify("sha256", data, publicKey, sig));
console.log("rejects tampered    :", !crypto.verify("sha256", Buffer.from("tampered"), publicKey, sig));

// Streaming Sign/Verify API too.
const s = crypto.createSign("RSA-SHA256").update(data).sign(privateKey);
console.log("createSign/Verify   :", crypto.createVerify("RSA-SHA256").update(data).verify(publicKey, s));

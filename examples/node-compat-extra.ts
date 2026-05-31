// Node compat regression — extras: console formatting/methods, fs fds,
// Buffer numerics, crypto key objects, util helpers. Run:
//   cargo run -- examples/node-compat-extra.ts
const results: [string, boolean, string][] = [];
function check(name: string, fn: () => any) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => results.push([name, true, ""]), (e) => results.push([name, false, String(e?.message || e)])); results.push([name, true, ""]); }
  catch (e: any) { results.push([name, false, String(e?.message || e)]); }
}

const fs = require("node:fs");
const util = require("node:util");

// console methods exist
check("console.dir", () => { if (typeof console.dir !== "function") throw new Error("no dir"); console.dir({ a: 1 }); });
check("console.table", () => { if (typeof console.table !== "function") throw new Error("no table"); });
check("console.group/groupEnd", () => { if (typeof console.group !== "function" || typeof console.groupEnd !== "function") throw new Error("no group"); });
check("console.assert", () => { if (typeof console.assert !== "function") throw new Error("no assert"); console.assert(true); });
check("console.count", () => { if (typeof console.count !== "function") throw new Error("no count"); });
check("console.time/timeEnd", () => { if (typeof console.time !== "function") throw new Error("no time"); });
check("console.trace", () => { if (typeof console.trace !== "function") throw new Error("no trace"); });

// console format specifiers (printf-style) — util.format is the source of truth
check("util.format %s %d %i %f", () => { const r = util.format("%s %d %i %f", "a", 3, 4.9, 2.5); if (r !== "a 3 4 2.5") throw new Error("fmt=" + r); });
check("util.format %j", () => { const r = util.format("%j", { a: 1 }); if (r !== '{"a":1}') throw new Error("j=" + r); });
check("util.format %o/%O", () => { const r = util.format("%o", { a: 1 }); if (typeof r !== "string" || r.indexOf("a") === -1) throw new Error("o=" + r); });
check("util.format %%", () => { const r = util.format("100%% %s", "x"); if (r !== "100% x") throw new Error("pct=" + r); });
check("util.format extra args", () => { const r = util.format("a", "b", "c"); if (r !== "a b c") throw new Error("extra=" + r); });
check("util.format %c ignored", () => { const r = util.format("%c hi", "color:red"); if (r.indexOf("hi") === -1) throw new Error("c=" + r); });

// fs file descriptors
check("fs.openSync/readSync/closeSync", () => {
  fs.writeFileSync("/tmp/.vxfd", "abcdef");
  const fd = fs.openSync("/tmp/.vxfd", "r");
  const buf = Buffer.alloc(3);
  const n = fs.readSync(fd, buf, 0, 3, 0);
  fs.closeSync(fd);
  fs.unlinkSync("/tmp/.vxfd");
  if (n !== 3 || buf.toString() !== "abc") throw new Error("fd read " + buf.toString());
});
check("fs.writeSync fd", () => {
  const fd = fs.openSync("/tmp/.vxfd2", "w");
  fs.writeSync(fd, "hello");
  fs.closeSync(fd);
  const got = fs.readFileSync("/tmp/.vxfd2", "utf8");
  fs.unlinkSync("/tmp/.vxfd2");
  if (got !== "hello") throw new Error("fd write " + got);
});
check("fs.statSync ENOENT code", () => {
  try { fs.statSync("/tmp/.vx-does-not-exist-xyz"); throw new Error("should throw"); }
  catch (e: any) { if (e.code !== "ENOENT") throw new Error("code=" + e.code); }
});
check("fs.readdirSync withFileTypes", () => {
  const ents = fs.readdirSync("/tmp", { withFileTypes: true });
  if (!Array.isArray(ents) || typeof ents[0]?.isFile !== "function") throw new Error("dirent");
});

// Buffer numerics
check("buf.readFloatLE/writeFloatLE", () => { const b = Buffer.alloc(4); b.writeFloatLE(1.5, 0); if (Math.abs(b.readFloatLE(0) - 1.5) > 1e-6) throw new Error("float"); });
check("buf.readDoubleBE/writeDoubleBE", () => { const b = Buffer.alloc(8); b.writeDoubleBE(3.14159, 0); if (Math.abs(b.readDoubleBE(0) - 3.14159) > 1e-9) throw new Error("double"); });
check("buf.readInt16LE signed", () => { const b = Buffer.from([0xff, 0xff]); if (b.readInt16LE(0) !== -1) throw new Error("i16"); });
check("Buffer base64 roundtrip", () => { const b = Buffer.from("hello world"); if (Buffer.from(b.toString("base64"), "base64").toString() !== "hello world") throw new Error("b64"); });
check("buf.fill", () => { const b = Buffer.alloc(4).fill(0x61); if (b.toString() !== "aaaa") throw new Error("fill"); });
check("buf.copy", () => { const a = Buffer.from("xxxx"); Buffer.from("ab").copy(a, 1); if (a.toString() !== "xabx") throw new Error("copy " + a.toString()); });

// crypto key objects + hkdf
check("crypto.createHmac with key object", () => { const c = require("node:crypto"); const h = c.createHmac("sha256", "secret").update("data").digest("hex"); if (h.length !== 64) throw new Error("hmac"); });
check("crypto.hkdfSync", () => { const c = require("node:crypto"); if (typeof c.hkdfSync !== "function") throw new Error("no hkdf"); const d = c.hkdfSync("sha256", "key", "salt", "info", 32); if (Buffer.from(d).length !== 32) throw new Error("hkdf len"); });
check("crypto.generateKeyPairSync rsa", () => {
  const c = require("node:crypto");
  // 1024-bit keeps the (debug-build) keygen fast; validates the PKCS#8/SPKI PEM
  // path and that the keys parse. (Full RS256 sign/verify needs >=2048 — ring's
  // policy — and is covered by examples/rsa-keygen.ts.)
  const { publicKey, privateKey } = c.generateKeyPairSync("rsa", { modulusLength: 1024 });
  if (!/BEGIN PRIVATE KEY/.test(privateKey) || !/BEGIN PUBLIC KEY/.test(publicKey)) throw new Error("pem");
  c.createPrivateKey(privateKey); c.createPublicKey(publicKey);
});
check("crypto.createPublicKey/PrivateKey", () => {
  const c = require("node:crypto");
  const { publicKey, privateKey } = c.generateKeyPairSync("ed25519");
  if (typeof c.createPublicKey !== "function") throw new Error("no createPublicKey");
  const pub = c.createPublicKey(publicKey);
  const priv = c.createPrivateKey(privateKey);
  // round-trip sign/verify through key objects
  const sig = c.sign(null, Buffer.from("msg"), priv);
  if (!c.verify(null, Buffer.from("msg"), pub, sig)) throw new Error("keyobj verify");
});

// util helpers
check("util.isDeepStrictEqual", () => { if (!util.isDeepStrictEqual({ a: [1] }, { a: [1] })) throw new Error("ide"); });
check("util.types.isAsyncFunction", () => { if (!util.types.isAsyncFunction(async () => {})) throw new Error("iaf"); });
check("util.parseArgs", () => { if (typeof util.parseArgs !== "function") throw new Error("no parseArgs"); const { values } = util.parseArgs({ args: ["--foo", "bar"], options: { foo: { type: "string" } }, strict: false }); if (values.foo !== "bar") throw new Error("pa=" + JSON.stringify(values)); });

await new Promise((r) => setTimeout(r, 100));
let pass = 0, fail = 0;
for (const [name, ok, err] of results) { if (ok) pass++; else { fail++; console.log("FAIL " + name + ": " + err); } }
console.log("\n" + pass + " passed, " + fail + " failed of " + results.length);
process.exit(fail > 0 ? 1 : 0);

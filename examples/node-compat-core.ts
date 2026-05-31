// Probe: exercise common Node APIs, report PASS/FAIL per feature.
const results: [string, boolean, string][] = [];
function check(name: string, fn: () => any) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => results.push([name, true, ""]), (e) => results.push([name, false, String(e?.message || e)])); results.push([name, true, ""]); }
  catch (e: any) { results.push([name, false, String(e?.message || e)]); }
}

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const util = require("node:util");

check("path.parse", () => { const p = path.parse("/a/b/c.txt"); if (p.ext !== ".txt" || p.name !== "c") throw new Error("bad parse"); });
check("path.relative", () => { if (path.relative("/a/b", "/a/c") !== "../c") throw new Error(path.relative("/a/b","/a/c")); });
check("path.format", () => { if (path.format({ dir: "/a", base: "b.txt" }) !== "/a/b.txt") throw new Error("fmt"); });
check("util.format", () => { if (util.format("%s=%d", "x", 5) !== "x=5") throw new Error(util.format("%s=%d","x",5)); });
check("util.inspect", () => { if (typeof util.inspect({a:1}) !== "string") throw new Error("inspect"); });
check("util.promisify", () => { if (typeof util.promisify(()=>{}) !== "function") throw new Error("promisify"); });
check("util.types.isDate", () => { if (!util.types.isDate(new Date())) throw new Error("isDate"); });
check("util.inherits", () => { function A(){}; function B(){}; util.inherits(B,A); if (!(new B() instanceof A)) throw new Error("inherits"); });
check("os.cpus", () => { if (!Array.isArray(os.cpus()) || !os.cpus().length) throw new Error("cpus"); });
check("os.totalmem", () => { if (typeof os.totalmem() !== "number") throw new Error("totalmem"); });
check("os.networkInterfaces", () => { if (typeof os.networkInterfaces() !== "object") throw new Error("netif"); });
check("os.homedir", () => { if (typeof os.homedir() !== "string") throw new Error("homedir"); });
check("os.userInfo", () => { if (typeof os.userInfo().username !== "string") throw new Error("userInfo"); });

check("fs.promises.readFile", async () => { const p = require("node:fs/promises"); await p.writeFile("/tmp/.vx1", "hi"); const s = await p.readFile("/tmp/.vx1", "utf8"); if (s !== "hi") throw new Error("rw"); });
check("fs.mkdtempSync", () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "vx-")); fs.rmdirSync(d); });
check("fs.appendFileSync", () => { fs.writeFileSync("/tmp/.vx2","a"); fs.appendFileSync("/tmp/.vx2","b"); if (fs.readFileSync("/tmp/.vx2","utf8")!=="ab") throw new Error("append"); fs.unlinkSync("/tmp/.vx2"); });
check("fs.copyFileSync", () => { fs.writeFileSync("/tmp/.vx3","x"); fs.copyFileSync("/tmp/.vx3","/tmp/.vx4"); if (fs.readFileSync("/tmp/.vx4","utf8")!=="x") throw new Error("copy"); fs.unlinkSync("/tmp/.vx3"); fs.unlinkSync("/tmp/.vx4"); });
check("fs.existsSync", () => { if (fs.existsSync("/tmp/.vx-nope-xyz")) throw new Error("exists"); });
check("fs.createReadStream", () => { if (typeof fs.createReadStream !== "function") throw new Error("crs"); });
check("fs.watch", () => { if (typeof fs.watch !== "function") throw new Error("watch"); });
check("fs.statSync.isDirectory", () => { if (!fs.statSync(os.tmpdir()).isDirectory()) throw new Error("isDir"); });

check("Buffer.concat", () => { const b = Buffer.concat([Buffer.from("a"), Buffer.from("b")]); if (b.toString()!=="ab") throw new Error("concat"); });
check("Buffer.readUInt32BE", () => { const b = Buffer.from([0,0,0,5]); if (b.readUInt32BE(0)!==5) throw new Error("ru32"); });
check("Buffer.writeBigInt64BE", () => { const b = Buffer.alloc(8); if (typeof b.writeBigInt64BE !== "function") throw new Error("nofn"); b.writeBigInt64BE(5n,0); if (b.readBigInt64BE(0)!==5n) throw new Error("big"); });
check("Buffer base64url", () => { if (Buffer.from("aGk","base64url").toString()!=="hi") throw new Error("b64url"); });

check("events.once", async () => { const { EventEmitter, once } = require("node:events"); const ee = new EventEmitter(); setTimeout(()=>ee.emit("x",42),5); const [v] = await once(ee,"x"); if (v!==42) throw new Error("once"); });
check("EventEmitter.getMaxListeners", () => { const { EventEmitter } = require("node:events"); const ee = new EventEmitter(); if (typeof ee.getMaxListeners() !== "number") throw new Error("gml"); });

check("stream.Readable.from", async () => { const { Readable } = require("node:stream"); const r = Readable.from(["a","b"]); let out=""; for await (const c of r) out+=c; if (out!=="ab") throw new Error("fromiter "+out); });
check("stream.pipeline promise", () => { const { pipeline } = require("node:stream/promises"); if (typeof pipeline !== "function") throw new Error("nopromises"); });

check("querystring.stringify", () => { const qs = require("node:querystring"); if (qs.stringify({a:1,b:2})!=="a=1&b=2") throw new Error("qs"); });
check("url.fileURLToPath", () => { const u = require("node:url"); if (u.fileURLToPath("file:///a/b")!=="/a/b") throw new Error("f2p "+u.fileURLToPath("file:///a/b")); });
check("URLSearchParams", () => { const sp = new URLSearchParams("a=1&b=2"); if (sp.get("a")!=="1") throw new Error("usp"); });

check("process.hrtime.bigint", () => { if (typeof process.hrtime.bigint() !== "bigint") throw new Error("hrt"); });
check("process.nextTick", async () => { await new Promise<void>((res)=>process.nextTick(res)); });
check("process.memoryUsage", () => { if (typeof process.memoryUsage().rss !== "number") throw new Error("mem"); });
check("process.platform", () => { if (process.platform!=="darwin") throw new Error("plat"); });
check("process.env mutate", () => { process.env.VX_TEST="1"; if (process.env.VX_TEST!=="1") throw new Error("env"); });
check("process.argv", () => { if (!Array.isArray(process.argv)) throw new Error("argv"); });
check("process.cwd", () => { if (typeof process.cwd()!=="string") throw new Error("cwd"); });

check("crypto.createHash", () => { const c = require("node:crypto"); if (c.createHash("sha256").update("a").digest("hex").length!==64) throw new Error("hash"); });
check("crypto.randomUUID", () => { if (require("node:crypto").randomUUID().length!==36) throw new Error("uuid"); });
check("crypto.generateKeyPairSync ed25519", () => { const c = require("node:crypto"); c.generateKeyPairSync("ed25519"); });
check("crypto.createECDH", () => { const c = require("node:crypto"); if (typeof c.createECDH !== "function") throw new Error("noecdh"); });
check("crypto.ECDH roundtrip", () => {
  const c = require("node:crypto");
  const a = c.createECDH("prime256v1"); a.generateKeys();
  const b = c.createECDH("prime256v1"); b.generateKeys();
  const s1 = a.computeSecret(b.getPublicKey(), null, "hex");
  const s2 = b.computeSecret(a.getPublicKey(), null, "hex");
  if (s1 !== s2 || s1.length !== 64) throw new Error("ecdh mismatch");
});
check("fs.createReadStream read", async () => {
  fs.writeFileSync("/tmp/.vxrs", "hello-stream");
  const rs = fs.createReadStream("/tmp/.vxrs", "utf8");
  let out = ""; for await (const ch of rs) out += ch;
  fs.unlinkSync("/tmp/.vxrs");
  if (out !== "hello-stream") throw new Error("rs got " + out);
});
check("fs.createWriteStream write", async () => {
  await new Promise<void>((res, rej) => {
    const ws = fs.createWriteStream("/tmp/.vxws");
    ws.write("a"); ws.write("b"); ws.end("c");
    ws.on("finish", res); ws.on("error", rej);
  });
  const got = fs.readFileSync("/tmp/.vxws", "utf8"); fs.unlinkSync("/tmp/.vxws");
  if (got !== "abc") throw new Error("ws got " + got);
});
check("fs.watch fires", async () => {
  fs.writeFileSync("/tmp/.vxwatch", "1");
  await new Promise<void>((res, rej) => {
    const to = setTimeout(() => { w.close(); rej(new Error("watch never fired")); }, 800);
    const w = fs.watch("/tmp/.vxwatch", { interval: 30 }, () => { clearTimeout(to); w.close(); res(); });
    setTimeout(() => fs.writeFileSync("/tmp/.vxwatch", "2"), 60);
  });
  fs.unlinkSync("/tmp/.vxwatch");
});

check("timers/promises setTimeout", async () => { const { setTimeout: st } = require("node:timers/promises"); await st(5); });
check("AbortController", () => { const ac = new AbortController(); ac.abort(); if (!ac.signal.aborted) throw new Error("abort"); });
check("structuredClone", () => { const o = structuredClone({a:[1,2]}); if (o.a[1]!==2) throw new Error("sc"); });
check("TextEncoder", () => { if (new TextEncoder().encode("a")[0]!==97) throw new Error("te"); });
check("globalThis.fetch", () => { if (typeof fetch !== "function") throw new Error("fetch"); });
check("setImmediate", async () => { await new Promise<void>((res)=>setImmediate(res)); });
check("queueMicrotask", async () => { await new Promise<void>((res)=>queueMicrotask(res)); });
check("WeakRef", () => { new WeakRef({}); });
check("BigInt64Array", () => { new BigInt64Array(2); });
check("Intl.NumberFormat", () => { if (new Intl.NumberFormat("en").format(1000) === "") throw new Error("intl"); });
check("Date.toISOString", () => { if (typeof new Date().toISOString()!=="string") throw new Error("date"); });

await new Promise((r) => setTimeout(r, 200));
let pass = 0, fail = 0;
for (const [name, ok, err] of results) {
  if (ok) { pass++; } else { fail++; console.log("FAIL " + name + ": " + err); }
}
console.log("\n" + pass + " passed, " + fail + " failed of " + results.length);
process.exit(fail > 0 ? 1 : 0);

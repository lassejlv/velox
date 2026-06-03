const results: [string, boolean, string][] = [];
function check(name: string, fn: () => any) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => results.push([name, true, ""]), (e) => results.push([name, false, String(e?.message || e)])); results.push([name, true, ""]); }
  catch (e: any) { results.push([name, false, String(e?.message || e)]); }
}

// TypeScript legacy decorators + emitDecoratorMetadata (NestJS/TypeORM/tsyringe ecosystem).
check("decorators: class/method/property/parameter", () => {
  const log: string[] = [];
  function classDeco(t: any) { log.push("class:" + t.name); return t; }
  function methodDeco(_t: any, k: string, d: any) { log.push("method:" + k); return d; }
  function propDeco(_t: any, k: string) { log.push("prop:" + k); }
  function paramDeco(_t: any, k: any, i: number) { log.push("param:" + (k ?? "ctor") + ":" + i); }
  @classDeco
  class Svc {
    @propDeco field = 1;
    constructor(@paramDeco _dep: number) {}
    @methodDeco run(_x: number) { return 42; }
  }
  const s = new Svc(7);
  if (s.run(1) !== 42 || s.field !== 1) throw new Error("behavior");
  if (!log.includes("class:Svc") || !log.includes("method:run") || !log.includes("prop:field") || !log.includes("param:ctor:0")) throw new Error("decorators ran: " + log.join(","));
});

// modern JS builtins
check("Promise.allSettled", async () => { const r = await Promise.allSettled([Promise.resolve(1), Promise.reject(2)]); if (r[0].status !== "fulfilled" || r[1].status !== "rejected") throw new Error("as"); });
check("Promise.any", async () => { if (await Promise.any([Promise.reject(1), Promise.resolve(2)]) !== 2) throw new Error("any"); });
check("Promise.withResolvers", () => { if (typeof (Promise as any).withResolvers !== "function") throw new Error("wr"); const { promise, resolve } = (Promise as any).withResolvers(); resolve(1); return promise; });
check("Object.hasOwn", () => { if (!Object.hasOwn({ a: 1 }, "a")) throw new Error("ho"); });
check("Array.prototype.at", () => { if ([1, 2, 3].at(-1) !== 3) throw new Error("at"); });
check("Array.fromAsync", async () => { if (typeof (Array as any).fromAsync !== "function") throw new Error("nofa"); const r = await (Array as any).fromAsync([Promise.resolve(1)]); if (r[0] !== 1) throw new Error("fa"); });
check("structuredClone Map", () => { const m = structuredClone(new Map([["a", 1]])); if (m.get("a") !== 1) throw new Error("scmap"); });
check("Error.captureStackTrace", () => { const e: any = {}; (Error as any).captureStackTrace(e); if (typeof e.stack !== "string") throw new Error("cst"); });
check("AggregateError", () => { const e = new AggregateError([new Error("a")], "agg"); if (e.errors.length !== 1) throw new Error("ae"); });

// Buffer edge cases
check("Buffer.from(ArrayBuffer)", () => { const ab = new Uint8Array([1, 2, 3]).buffer; if (Buffer.from(ab)[1] !== 2) throw new Error("ab"); });
check("Buffer.allocUnsafe", () => { if (Buffer.allocUnsafe(4).length !== 4) throw new Error("au"); });
check("Buffer.byteLength", () => { if (Buffer.byteLength("héllo") !== 6) throw new Error("bl=" + Buffer.byteLength("héllo")); });
check("Buffer.compare", () => { if (Buffer.compare(Buffer.from("a"), Buffer.from("b")) !== -1) throw new Error("cmp"); });
check("buf.indexOf/includes", () => { const b = Buffer.from("hello"); if (b.indexOf("ll") !== 2 || !b.includes("lo")) throw new Error("idx"); });
check("buf.write", () => { const b = Buffer.alloc(5); b.write("hi"); if (b.toString("utf8", 0, 2) !== "hi") throw new Error("w"); });
check("buf.toJSON", () => { const j = Buffer.from([1, 2]).toJSON(); if (j.type !== "Buffer" || j.data[1] !== 2) throw new Error("tj"); });
check("buf.subarray shares", () => { const b = Buffer.from([1, 2, 3]); const s = b.subarray(1); s[0] = 9; if (b[1] !== 9) throw new Error("sub"); });

// TextDecoder/Encoder
check("TextDecoder utf8", () => { if (new TextDecoder().decode(new Uint8Array([104, 105])) !== "hi") throw new Error("td"); });
// utf-16le and utf-16be labels (html-encoding-sniffer/jsdom decode in both endiannesses).
check("TextDecoder utf-16le/be", () => { if (new TextDecoder("utf-16le").decode(new Uint8Array([0x48, 0, 0x69, 0])) !== "Hi") throw new Error("le"); if (new TextDecoder("utf-16be").decode(new Uint8Array([0, 0x48, 0, 0x69])) !== "Hi") throw new Error("be"); if (new TextDecoder("utf-16be").decode(new Uint8Array([0xfe, 0xff, 0, 0x41])) !== "A") throw new Error("be-bom"); });
check("TextEncoder.encodeInto", () => { const te = new TextEncoder(); const u = new Uint8Array(2); const r = te.encodeInto("hi", u); if (r.written !== 2 || u[0] !== 104) throw new Error("ei"); });
check("TextDecoder latin1", () => { const d = new TextDecoder("latin1"); if (d.decode(new Uint8Array([0xe9])) !== "é") throw new Error("l1"); });

// AbortSignal helpers
check("AbortSignal.timeout", () => { if (typeof (AbortSignal as any).timeout !== "function") throw new Error("nots"); const s = (AbortSignal as any).timeout(10); if (s.aborted) throw new Error("ts"); });
check("AbortSignal.any", () => { if (typeof (AbortSignal as any).any !== "function") throw new Error("noany"); });
check("AbortSignal abort event", async () => { const ac = new AbortController(); const p = new Promise<void>((res) => ac.signal.addEventListener("abort", () => res())); ac.abort(); await p; });

// WHATWG Streams
check("ReadableStream async iteration", async () => {
  const rs = new ReadableStream({ start(c: any) { c.enqueue("a"); c.enqueue("b"); c.close(); } });
  let out = ""; for await (const ch of rs as any) out += ch;
  if (out !== "ab") throw new Error("rs=" + out);
});
check("TransformStream + pipeThrough", async () => {
  const ts = new TransformStream({ transform(c: any, ctrl: any) { ctrl.enqueue(String(c).toUpperCase()); } });
  const r = (ReadableStream as any).from(["x", "y"]).pipeThrough(ts);
  const reader = r.getReader(); let out = "";
  for (;;) { const { value, done } = await reader.read(); if (done) break; out += value; }
  if (out !== "XY") throw new Error("ts=" + out);
});
check("WritableStream + pipeTo", async () => {
  let collected = "";
  const ws = new WritableStream({ write(c: any) { collected += c; } });
  await (ReadableStream as any).from(["1", "2", "3"]).pipeTo(ws);
  if (collected !== "123") throw new Error("ws=" + collected);
});
check("MessageChannel ports", async () => {
  await new Promise<void>((resolve, reject) => {
    const { port1, port2 } = new MessageChannel();
    const to = setTimeout(() => reject(new Error("mc timeout")), 1000);
    port2.onmessage = (ev: any) => { clearTimeout(to); ev.data === "ping" ? resolve() : reject(new Error("mc")); };
    port1.postMessage("ping");
  });
});

// SharedArrayBuffer (polyfilled) + Atomics
check("SharedArrayBuffer + Atomics", () => { const sab = new SharedArrayBuffer(16); if (!(sab instanceof SharedArrayBuffer) || sab.byteLength !== 16) throw new Error("sab"); const v = new Int32Array(sab); Atomics.store(v, 0, 40); Atomics.add(v, 0, 2); if (Atomics.load(v, 0) !== 42) throw new Error("atomics=" + Atomics.load(v, 0)); if (Atomics.compareExchange(v, 0, 42, 7) !== 42 || Atomics.load(v, 0) !== 7) throw new Error("cx"); });
// SharedArrayBuffer.prototype.byteLength must be an accessor (webidl-conversions/whatwg-url read its .get at load).
check("SharedArrayBuffer.prototype byteLength getter", () => { const d = Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, "byteLength"); if (!d || typeof d.get !== "function") throw new Error("no getter"); if (d.get.call(new SharedArrayBuffer(24)) !== 24) throw new Error("len=" + d.get.call(new SharedArrayBuffer(24))); });
// WebAssembly async API must resolve (JSC's native async settles via a CFRunLoop timer velox lacks; we shim over the sync constructors). Unblocks emscripten/sql.js.
const WASM_ADD = new Uint8Array([0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11]);
check("WebAssembly.instantiate (async)", async () => { const { instance } = await WebAssembly.instantiate(WASM_ADD); if ((instance.exports.add as any)(2, 3) !== 5) throw new Error("add"); });
check("WebAssembly.compile (async)", async () => { const mod = await WebAssembly.compile(WASM_ADD); const inst = await WebAssembly.instantiate(mod); if ((inst.exports.add as any)(7, 8) !== 15) throw new Error("compile"); });

// web crypto subtle (async)
check("crypto.subtle.digest", async () => { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("a")); if (new Uint8Array(d).length !== 32) throw new Error("digest"); });
check("crypto.getRandomValues", () => { const u = new Uint8Array(8); crypto.getRandomValues(u); });
check("crypto.subtle HMAC sign/verify", async () => { const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("k"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("m")); if (!(await crypto.subtle.verify("HMAC", k, sig, new TextEncoder().encode("m")))) throw new Error("hmac"); });
check("crypto.subtle AES-GCM", async () => { const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode("secret")); const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, ct); if (new TextDecoder().decode(pt) !== "secret") throw new Error("gcm"); });
check("crypto.subtle ECDSA P-256", async () => { const kp: any = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]); const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode("d")); if ((sig as ArrayBuffer).byteLength !== 64) throw new Error("ecdsa raw"); if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, sig, new TextEncoder().encode("d")))) throw new Error("verify"); });
check("crypto.subtle ECDH deriveBits/deriveKey (P-256)", async () => { const a: any = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]); const b: any = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits", "deriveKey"]); const s1 = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: b.publicKey }, a.privateKey, 256)); const s2 = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: a.publicKey }, b.privateKey, 256)); if (s1.length !== 32 || !s1.every((v, i) => v === s2[i])) throw new Error("ecdh mismatch"); });
check("perf_hooks.createHistogram", () => { const { createHistogram } = require("node:perf_hooks"); const h = createHistogram(); h.record(10); h.record(20); h.record(30); if (h.count !== 3 || h.min !== 10 || h.max !== 30 || h.mean !== 20) throw new Error("hist"); if (typeof h.percentile(50) !== "number") throw new Error("pct"); });
check("worker_threads.SHARE_ENV + process.allowedNodeEnvironmentFlags", () => { const { SHARE_ENV } = require("node:worker_threads"); if (typeof SHARE_ENV !== "symbol") throw new Error("SHARE_ENV"); if (!(process.allowedNodeEnvironmentFlags instanceof Set) || !process.allowedNodeEnvironmentFlags.has("--enable-source-maps")) throw new Error("flags"); });
check("crypto.subtle exportKey/importKey jwk (EC public)", async () => { const kp: any = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]); const jwk: any = await crypto.subtle.exportKey("jwk", kp.publicKey); if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("jwk shape"); const reimp = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]); const data = new TextEncoder().encode("payload"); const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, data); if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, reimp, sig, data))) throw new Error("verify after jwk reimport"); });

// http.request / http.get (classic client, not fetch)
check("http.get classic", async () => {
  const http = require("node:http");
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req: any, res: any) => { res.setHeader("Content-Type", "text/plain"); res.end("classic-ok"); });
    server.on("error", reject);
    server.listen(0, () => {
      const port = server.address().port;
      http.get("http://127.0.0.1:" + port + "/", (res: any) => {
        let body = ""; res.setEncoding("utf8");
        res.on("data", (c: any) => body += c);
        res.on("end", () => { server.close(); body === "classic-ok" ? resolve() : reject(new Error("got " + body)); });
      }).on("error", (e: any) => { server.close(); reject(e); });
    });
  });
});
check("http.request POST", async () => {
  const http = require("node:http");
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req: any, res: any) => { let b = ""; req.on("data", (c: any) => b += c); req.on("end", () => res.end("echo:" + b)); });
    server.on("error", reject);
    server.listen(0, () => {
      const port = server.address().port;
      const r = http.request({ host: "127.0.0.1", port, method: "POST", path: "/" }, (res: any) => {
        let body = ""; res.on("data", (c: any) => body += c); res.on("end", () => { server.close(); body === "echo:hi" ? resolve() : reject(new Error("got " + body)); });
      });
      r.on("error", (e: any) => { server.close(); reject(e); });
      r.end("hi");
    });
  });
});

// stream.finished / pipeline promises
check("stream.finished", async () => {
  const { Readable } = require("node:stream"); const { finished } = require("node:stream/promises");
  const r = Readable.from(["a", "b"]); r.resume(); await finished(r);
});

// process streams + meta
check("process.stdout.write", () => { if (typeof process.stdout.write !== "function") throw new Error("sw"); });
check("process.versions.node", () => { if (typeof process.versions.node !== "string") throw new Error("ver"); });
check("process.version", () => { if (typeof process.version !== "string" || process.version[0] !== "v") throw new Error("v"); });
check("process.nextTick order", async () => { const order: number[] = []; await new Promise<void>((res) => { process.nextTick(() => order.push(1)); Promise.resolve().then(() => order.push(2)); process.nextTick(() => { order.push(3); res(); }); }); if (order[0] !== 1) throw new Error("order " + order); });

// events extras
check("EventEmitter prependListener", () => { const { EventEmitter } = require("node:events"); const ee = new EventEmitter(); const o: number[] = []; ee.on("x", () => o.push(2)); ee.prependListener("x", () => o.push(1)); ee.emit("x"); if (o[0] !== 1) throw new Error("pre"); });
check("EventEmitter listenerCount", () => { const { EventEmitter } = require("node:events"); const ee = new EventEmitter(); ee.on("x", () => {}); if (ee.listenerCount("x") !== 1) throw new Error("lc"); });

// timer unref/refresh
check("timer.unref/ref", () => { const t = setTimeout(() => {}, 10000); if (typeof t.unref !== "function") throw new Error("unref"); t.unref(); t.ref(); clearTimeout(t); });
check("timer.refresh", () => { const t: any = setTimeout(() => {}, 10000); if (typeof t.refresh === "function") t.refresh(); clearTimeout(t); });

// node:v8 structured serialize round-trip
check("v8.serialize/deserialize", () => { const v8 = require("node:v8"); const val = { a: 1, b: [2, "x", true], c: new Map([["k", "v"]]), d: new Date(1700000000000) }; const back = v8.deserialize(v8.serialize(val)); if (back.a !== 1 || back.b[1] !== "x" || back.c.get("k") !== "v" || back.d.getTime() !== 1700000000000) throw new Error("v8 rt"); });

// events.on async iterator with AbortSignal
check("events.on async iterator", async () => { const { EventEmitter, on } = require("node:events"); const ee = new EventEmitter(); const ac = new AbortController(); queueMicrotask(() => { ee.emit("x", 1); ee.emit("x", 2); ac.abort(); }); const seen: number[] = []; try { for await (const [v] of on(ee, "x", { signal: ac.signal })) { seen.push(v); } } catch (e: any) { if (e.name !== "AbortError") throw e; } if (seen[0] !== 1 || seen[1] !== 2) throw new Error("on=" + seen); });

// Readable emits 'close' after 'end' (autoDestroy), Writable after 'finish'
check("stream Readable emits close", async () => { const { Readable } = require("node:stream"); const r = Readable.from(["a", "b"]); let closed = false; r.on("close", () => { closed = true; }); r.resume(); await new Promise((res) => r.on("end", res)); await new Promise((res) => setTimeout(res, 20)); if (!closed) throw new Error("no close"); });

// fs.readdir async honors withFileTypes (real Dirent objects)
check("fs.readdir withFileTypes async", async () => { const fs = require("node:fs"); const ents: any[] = await new Promise((res, rej) => fs.readdir(".", { withFileTypes: true }, (e: any, d: any) => e ? rej(e) : res(d))); if (!ents.length || typeof ents[0].isFile !== "function" || typeof ents[0].name !== "string") throw new Error("dirent"); });

// os.constants.signals populated
check("os.constants.signals", () => { const os = require("node:os"); if (os.constants.signals.SIGTERM !== 15 || os.constants.signals.SIGKILL !== 9) throw new Error("signals"); });
check("undici load deps (markAsUncloneable/maxHeaderSize/markResourceTiming)", () => { if (typeof require("node:worker_threads").markAsUncloneable !== "function") throw new Error("markAsUncloneable"); if (require("node:http").maxHeaderSize !== 16384) throw new Error("maxHeaderSize"); if (typeof (performance as any).markResourceTiming !== "function") throw new Error("markResourceTiming"); });
check("Buffer statics enumerable (safer-buffer/iconv-lite)", () => { var copied: any = {}; for (var k in Buffer) { (copied as any)[k] = (Buffer as any)[k]; } if (typeof copied.isBuffer !== "function" || typeof copied.from !== "function" || typeof copied.alloc !== "function" || typeof copied.concat !== "function") throw new Error("Buffer statics not enumerable: " + Object.keys(copied).join(",")); });
check("http server bound to 'localhost' reachable", async () => { const http = require("node:http"); const srv = http.createServer((_req: any, res: any) => res.end("ok")); await new Promise<void>((r) => srv.listen(0, "localhost", () => r())); const port = srv.address().port; const body = await new Promise<string>((res, rej) => { http.get({ host: "localhost", port }, (r: any) => { let d = ""; r.on("data", (c: any) => d += c); r.on("end", () => res(d)); }).on("error", rej); }); srv.close(); if (body !== "ok") throw new Error("localhost bind/connect mismatch"); });
check("process Symbol.toStringTag", () => { if (Object.prototype.toString.call(process) !== "[object process]") throw new Error("process tag: " + Object.prototype.toString.call(process)); });
check("navigator global", () => { const n = (globalThis as any).navigator; if (!n) throw new Error("no navigator"); if (typeof n.hardwareConcurrency !== "number" || n.hardwareConcurrency < 1) throw new Error("hwc"); if (typeof n.userAgent !== "string" || !n.userAgent) throw new Error("ua"); if (typeof n.onLine !== "boolean") throw new Error("onLine"); if (!Array.isArray(n.languages)) throw new Error("languages"); });
check("TextDecoder stream:true", () => { const d = new TextDecoder(); const a = d.decode(new Uint8Array([0xe2]), { stream: true }); const b = d.decode(new Uint8Array([0x9c, 0x93]), { stream: true }); const c = d.decode(); if (a !== "" || (a + b + c) !== "✓") throw new Error("stream decode"); });
check("TextEncoderStream/TextDecoderStream", async () => { const enc = new (globalThis as any).TextEncoderStream(); const w = enc.writable.getWriter(); w.write("a世"); w.write("界b"); w.close(); let out = ""; for await (const s of enc.readable.pipeThrough(new (globalThis as any).TextDecoderStream())) out += s; if (out !== "a世界b") throw new Error("ts roundtrip: " + out); });
check("process.getBuiltinModule", () => { const fs = (process as any).getBuiltinModule("node:fs"); if (!fs || typeof fs.readFileSync !== "function") throw new Error("gbm"); if ((process as any).getBuiltinModule("nope") !== undefined) throw new Error("gbm-bad"); });
check("Buffer.copyBytesFrom", () => { const u = new Uint16Array([1, 2, 3, 4]); const b = Buffer.copyBytesFrom(u, 1, 2); if (!Buffer.isBuffer(b) || b.length !== 4) throw new Error("cbf"); u[1] = 99; if (b.readUInt16LE(0) !== 2) throw new Error("cbf-not-copied"); });
check("crypto.generatePrimeSync", () => { const c = require("node:crypto"); const p = c.generatePrimeSync(48, { bigint: true }); if (typeof p !== "bigint" || p.toString(2).length !== 48 || !c.checkPrimeSync(p)) throw new Error("genprime"); const buf = c.generatePrimeSync(32); if (!(buf instanceof ArrayBuffer) || !c.checkPrimeSync(Buffer.from(buf))) throw new Error("genprime-buf"); });
check("crypto.checkPrimeSync", () => { const c = require("node:crypto"); if (!c.checkPrimeSync(7919n) || !c.checkPrimeSync(2147483647n)) throw new Error("prime"); if (c.checkPrimeSync(91n) || c.checkPrimeSync(561n)) throw new Error("composite (Carmichael)"); });
check("crypto chacha20-poly1305 AEAD", () => { const c = require("node:crypto"); const key = c.randomBytes(32), iv = c.randomBytes(12); const ci = c.createCipheriv("chacha20-poly1305", key, iv, { authTagLength: 16 }); const ct = Buffer.concat([ci.update("secret msg"), ci.final()]); const tag = ci.getAuthTag(); const d = c.createDecipheriv("chacha20-poly1305", key, iv, { authTagLength: 16 }); d.setAuthTag(tag); if (Buffer.concat([d.update(ct), d.final()]).toString() !== "secret msg") throw new Error("chacha"); });
check("crypto.subtle wrapKey/unwrapKey (AES-GCM)", async () => { const subtle = crypto.subtle; const wrapping = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["wrapKey", "unwrapKey"]); const toWrap = await subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); const iv = crypto.getRandomValues(new Uint8Array(12)); const wrapped = await subtle.wrapKey("raw", toWrap, wrapping, { name: "AES-GCM", iv }); const unwrapped = await subtle.unwrapKey("raw", wrapped, wrapping, { name: "AES-GCM", iv }, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); const a = new Uint8Array(await subtle.exportKey("raw", toWrap)); const b = new Uint8Array(await subtle.exportKey("raw", unwrapped)); if (a.length !== b.length || !a.every((v, i) => v === b[i])) throw new Error("wrapKey"); });
check("crypto RSA-OAEP (subtle + publicEncrypt/privateDecrypt)", async () => {
  const c = require("node:crypto");
  const keys = c.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dec = c.privateDecrypt({ key: keys.privateKey, oaepHash: "sha256" }, c.publicEncrypt({ key: keys.publicKey, oaepHash: "sha256" }, Buffer.from("node-oaep")));
  if (dec.toString() !== "node-oaep") throw new Error("node oaep");
  const kp: any = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, kp.publicKey, new TextEncoder().encode("subtle-oaep"));
  const pt = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, kp.privateKey, ct);
  if (new TextDecoder().decode(pt) !== "subtle-oaep") throw new Error("subtle oaep");
});
check("crypto SHA-3 + SHAKE", () => { const c = require("node:crypto"); if (c.createHash("sha3-256").update("abc").digest("hex") !== "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532") throw new Error("sha3-256"); if (c.createHash("sha3-512").update("x").digest().length !== 64) throw new Error("sha3-512"); if (c.createHash("shake256", { outputLength: 16 }).update("abc").digest().length !== 16) throw new Error("shake256"); });
check("crypto KeyObject JWK export/import (EC + OKP)", () => { const c = require("node:crypto"); const { publicKey } = c.generateKeyPairSync("ec", { namedCurve: "P-256" }); const jwk = c.createPublicKey(publicKey).export({ format: "jwk" }); if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string") throw new Error("ec export"); if (c.createPublicKey({ key: jwk, format: "jwk" }).asymmetricKeyType !== "ec") throw new Error("ec import"); const ed = c.generateKeyPairSync("ed25519"); if (c.createPublicKey(ed.publicKey).export({ format: "jwk" }).kty !== "OKP") throw new Error("okp"); });
check("crypto.getCurves + RSA key-type detection", () => { const c = require("node:crypto"); if (!c.getCurves().includes("P-256")) throw new Error("getCurves"); const { publicKey } = c.generateKeyPairSync("rsa", { modulusLength: 2048 }); if (c.createPublicKey(publicKey).asymmetricKeyType !== "rsa") throw new Error("rsa type"); });
check("module.SourceMap/findSourceMap", () => { const M = require("node:module"); if (typeof M.SourceMap !== "function" || typeof M.findSourceMap !== "function") throw new Error("sourcemap"); new M.SourceMap({}); });
check("crypto.generateKeySync/generateKey", async () => { const c = require("node:crypto"); const k = c.generateKeySync("hmac", { length: 256 }); if (k.type !== "secret" || k.export().length !== 32) throw new Error("sync"); if (c.generateKeySync("aes", { length: 128 }).export().length !== 16) throw new Error("aes"); await new Promise<void>((res, rej) => c.generateKey("hmac", { length: 512 }, (e: any, key: any) => e ? rej(e) : key.export().length === 64 ? res() : rej(new Error("async len")))); });
check("http2 server + client round-trip (h2c)", async () => {
  const http2 = require("node:http2");
  const server = http2.createServer();
  server.on("stream", (stream: any, headers: any) => {
    let body = ""; stream.on("data", (c: any) => (body += c));
    stream.on("end", () => { stream.respond({ ":status": 200, "content-type": "application/json" }); stream.end(JSON.stringify({ path: headers[":path"], method: headers[":method"], echo: body })); });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = server.address().port;
  const client = http2.connect("http://localhost:" + port);
  try {
    const req = client.request({ ":path": "/x", ":method": "POST" });
    let d = "", status = 0;
    req.on("response", (h: any) => (status = h[":status"]));
    req.on("data", (c: any) => (d += c));
    req.end("h2body");
    await new Promise<void>((res, rej) => { req.on("end", res); req.on("error", rej); setTimeout(() => rej(new Error("timeout")), 3000); });
    const j = JSON.parse(d);
    if (status !== 200 || j.path !== "/x" || j.method !== "POST" || j.echo !== "h2body") throw new Error("h2: " + status + " " + d);
  } finally { client.close(); server.close(); }
});
check("crypto.getDiffieHellman/createDiffieHellman", () => { const c = require("node:crypto"); const a = c.getDiffieHellman("modp14"), b = c.getDiffieHellman("modp14"); const aPub = a.generateKeys(), bPub = b.generateKeys(); if (!a.computeSecret(bPub).equals(b.computeSecret(aPub))) throw new Error("modp14"); const d1 = c.createDiffieHellman(256); const d2 = c.createDiffieHellman(d1.getPrime(), d1.getGenerator()); const p1 = d1.generateKeys(), p2 = d2.generateKeys(); if (!d1.computeSecret(p2).equals(d2.computeSecret(p1))) throw new Error("generated"); });
check("crypto x25519 keygen + diffieHellman", () => { const c = require("node:crypto"); const a = c.generateKeyPairSync("x25519"); const b = c.generateKeyPairSync("x25519"); const s1 = c.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }); const s2 = c.diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey }); if (s1.length !== 32 || !s1.equals(s2)) throw new Error("x25519 dh"); });
check("crypto x25519 RFC 7748 vector", () => { const c = require("node:crypto"); const priv = (h: string) => "-----BEGIN PRIVATE KEY-----\n" + Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(h, "hex")]).toString("base64") + "\n-----END PRIVATE KEY-----\n"; const pub = (h: string) => "-----BEGIN PUBLIC KEY-----\n" + Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(h, "hex")]).toString("base64") + "\n-----END PUBLIC KEY-----\n"; const shared = c.diffieHellman({ privateKey: c.createPrivateKey(priv("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")), publicKey: c.createPublicKey(pub("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")) }); if (shared.toString("hex") !== "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742") throw new Error("rfc7748"); });
check("crypto.hash one-shot", () => { const c = require("node:crypto"); if (c.hash("sha256", "abc") !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") throw new Error("hash"); if (!Buffer.isBuffer(c.hash("sha256", "abc", "buffer"))) throw new Error("hash-buf"); });
check("util.styleText", () => {
  const { styleText } = require("node:util");
  const prev = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    if (styleText("red", "hi") !== "\x1b[31mhi\x1b[39m") throw new Error("styleText");
  } finally {
    if (prev === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = prev;
  }
});
check("util.aborted", async () => { const { aborted } = require("node:util"); const ac = new AbortController(); const p = aborted(ac.signal); ac.abort(); await p; });
check("util.inspect.custom", () => { const u = require("node:util"); const o: any = {}; o[u.inspect.custom] = () => "CUSTOM-REPR"; if (u.inspect(o) !== "CUSTOM-REPR") throw new Error(u.inspect(o)); });
check("stream.addAbortSignal", async () => { const { addAbortSignal, Readable } = require("node:stream"); const ac = new AbortController(); const r = addAbortSignal(ac.signal, Readable.from(["a"])); let errored = false; r.on("error", () => (errored = true)); ac.abort(); await new Promise((res) => setTimeout(res, 10)); if (!errored || !r.destroyed) throw new Error("abort not handled (errored=" + errored + " destroyed=" + r.destroyed + ")"); });
check("os.getPriority/setPriority", () => { const os = require("node:os"); os.setPriority(0); if (typeof os.getPriority() !== "number") throw new Error("priority"); });
check("util.parseEnv", () => { const { parseEnv } = require("node:util"); const o = parseEnv('# c\nA=1\nB="x y"\nexport C=3'); if (o.A !== "1" || o.B !== "x y" || o.C !== "3") throw new Error(JSON.stringify(o)); });
check("Symbol.dispose / asyncDispose exist", () => { if (typeof Symbol.dispose !== "symbol" || typeof Symbol.asyncDispose !== "symbol") throw new Error("missing"); });
check("structuredClone(Error)", () => { const e: any = new TypeError("boom"); e.cause = new Error("why"); const c: any = structuredClone(e); if (c.message !== "boom" || c.name !== "TypeError" || !(c instanceof Error) || c.cause.message !== "why") throw new Error("clone"); });
check("perf_hooks PerformanceObserver fires", async () => { const { PerformanceObserver, performance } = require("node:perf_hooks"); await new Promise<void>((res, rej) => { const obs = new PerformanceObserver((list: any) => { if (list.getEntries().length) { obs.disconnect(); res(); } }); obs.observe({ entryTypes: ["measure"] }); performance.mark("a"); performance.mark("b"); performance.measure("m", "a", "b"); setTimeout(() => rej(new Error("no entries")), 500); }); });
check("node:test module shape", () => { const t = require("node:test"); if (typeof t !== "function" || typeof t.describe !== "function" || typeof t.it !== "function" || typeof t.before !== "function" || typeof t.mock.fn !== "function") throw new Error("shape"); });
check("process.pid is real + process.kill", () => { if (typeof process.pid !== "number" || process.pid <= 1) throw new Error("pid=" + process.pid); if (typeof process.ppid !== "number") throw new Error("ppid"); if (process.kill(process.pid, 0) !== true) throw new Error("kill"); });
check("stream Duplex.from + toWeb/fromWeb", async () => { const { Readable, Duplex } = require("node:stream"); if (typeof Duplex.from !== "function") throw new Error("Duplex.from"); const web = Readable.toWeb(Readable.from(["a", "b"])); if (typeof web.getReader !== "function") throw new Error("toWeb"); const back = Readable.fromWeb(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([104, 105])); c.close(); } })); let s = ""; for await (const ch of back) s += Buffer.from(ch).toString(); if (s !== "hi") throw new Error("fromWeb: " + s); });
check("fetch honors an aborted signal", async () => { const c = new AbortController(); c.abort(); try { await fetch("http://localhost:1/", { signal: c.signal }); throw new Error("should have aborted"); } catch (e: any) { if (e.name !== "AbortError") throw new Error("wrong error: " + e.name + " " + e.message); } });
check("fs.cpSync recursive", () => { const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path"); const base = fs.mkdtempSync(path.join(os.tmpdir(), "velox-cp-")); fs.mkdirSync(path.join(base, "s/sub"), { recursive: true }); fs.writeFileSync(path.join(base, "s/a.txt"), "hi"); fs.writeFileSync(path.join(base, "s/sub/b.txt"), "yo"); fs.cpSync(path.join(base, "s"), path.join(base, "d"), { recursive: true }); if (fs.readFileSync(path.join(base, "d/a.txt"), "utf8") !== "hi") throw new Error("cp a"); if (fs.readFileSync(path.join(base, "d/sub/b.txt"), "utf8") !== "yo") throw new Error("cp b"); fs.rmSync(base, { recursive: true, force: true }); });
check("fs.globSync", () => { const fs = require("node:fs"); const m = fs.globSync("examples/node-compat-*.ts"); if (!Array.isArray(m) || !m.includes("examples/node-compat-modern.ts")) throw new Error("globSync: " + m.length); });
check("fs.promises.glob async iterator", async () => { const fs = require("node:fs"); const out: string[] = []; for await (const f of fs.promises.glob("*.ts", { cwd: "examples" })) out.push(f); if (!out.includes("node-compat-modern.ts")) throw new Error("aglob"); });
check("stream/consumers", async () => { const { text, json } = require("node:stream/consumers"); const { Readable } = require("node:stream"); if (await text(Readable.from(["a", "b", "c"])) !== "abc") throw new Error("text"); const o = await json(Readable.from(['{"x":', "42}"])); if (o.x !== 42) throw new Error("json"); });
check("CompressionStream gzip round-trip", async () => { const G = globalThis as any; const text = "compress me ".repeat(20); const data = new TextEncoder().encode(text); async function pipe(s: any, b: Uint8Array) { const w = s.writable.getWriter(); w.write(b); w.close(); const out: Uint8Array[] = []; for await (const c of s.readable) out.push(c); let n = 0; out.forEach((c) => (n += c.length)); const m = new Uint8Array(n); let o = 0; for (const c of out) { m.set(c, o); o += c.length; } return m; } const comp = await pipe(new G.CompressionStream("gzip"), data); if (comp.length >= data.length) throw new Error("not compressed"); const back = await pipe(new G.DecompressionStream("gzip"), comp); if (new TextDecoder().decode(back) !== text) throw new Error("cs roundtrip"); });
check("process.memoryUsage.rss + availableMemory", () => { if (!(process.memoryUsage().rss > 0)) throw new Error("rss"); if (typeof process.memoryUsage.rss !== "function" || !(process.memoryUsage.rss() > 0)) throw new Error("rss()"); if (!(process.availableMemory() > 0)) throw new Error("avail"); });
check("process.getActiveResourcesInfo + features", () => { if (!Array.isArray(process.getActiveResourcesInfo())) throw new Error("ari"); if (process.features.uv !== true) throw new Error("features"); });
check("process.loadEnvFile", () => { const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path"); const p = path.join(os.tmpdir(), "velox-env-" + process.pid); fs.writeFileSync(p, '# c\nVELOX_X=hi\nVELOX_Q="a b"\nexport VELOX_Z=zz\n'); process.loadEnvFile(p); fs.rmSync(p, { force: true }); if (process.env.VELOX_X !== "hi" || process.env.VELOX_Q !== "a b" || process.env.VELOX_Z !== "zz") throw new Error("env " + process.env.VELOX_X + "/" + process.env.VELOX_Q + "/" + process.env.VELOX_Z); });
check("util.inspect depth", () => { const { inspect } = require("node:util"); if (!inspect({ a: { b: { c: 1 } } }, { depth: 1 }).includes("[Object]")) throw new Error("depth"); if (inspect({ a: { b: 1 } }).includes("[Object]")) throw new Error("default depth"); });
check("util.inspect maxArrayLength", () => { const { inspect } = require("node:util"); const s = inspect(new Array(200).fill(1), { maxArrayLength: 5 }); if (!s.includes("... 195 more items")) throw new Error(s.slice(0, 80)); });
check("util.MIMEType", () => { const { MIMEType } = require("node:util"); const m = new MIMEType("text/html;charset=utf-8"); if (m.type !== "text" || m.subtype !== "html" || m.essence !== "text/html" || m.params.get("charset") !== "utf-8") throw new Error("mime"); });
check("util.promisify + callbackify", async () => { const { promisify, callbackify } = require("node:util"); if (await promisify((x: number, cb: any) => cb(null, x * 2))(3) !== 6) throw new Error("promisify"); await new Promise((res, rej) => callbackify(async () => 7)((e: any, v: any) => e ? rej(e) : v === 7 ? res(0) : rej(0))); });
check("stream.compose", async () => { const { compose, Transform, Readable } = require("node:stream"); const up = compose(new Transform({ transform(c: any, e: any, cb: any) { cb(null, c.toString().toUpperCase()); } })); let o = ""; up.on("data", (c: any) => (o += c)); Readable.from(["hi"]).pipe(up); await new Promise((r) => up.on("end", r)); if (o !== "HI") throw new Error("compose=" + o); });
check("assert.CallTracker", () => { const assert = require("node:assert"); const t = new assert.CallTracker(); const f = t.calls(() => 1, 1); f(); t.verify(); const t2 = new assert.CallTracker(); t2.calls(() => {}, 1); let threw = false; try { t2.verify(); } catch { threw = true; } if (!threw) throw new Error("verify should throw"); });
check("timers/promises scheduler", async () => { const { scheduler } = require("node:timers/promises"); await scheduler.wait(1); await scheduler.yield(); });
check("fs.statfsSync", () => { const fs = require("node:fs"); const s = fs.statfsSync("."); if (!(s.bsize > 0) || !(s.blocks > 0)) throw new Error("statfs"); if (typeof fs.statfsSync(".", { bigint: true }).bsize !== "bigint") throw new Error("bigint"); });
check("fs.readvSync/writevSync", () => { const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path"); const p = path.join(os.tmpdir(), "velox-rw-" + process.pid); const fd = fs.openSync(p, "w+"); try { if (fs.writevSync(fd, [Buffer.from("foo"), Buffer.from("bar")]) !== 6) throw new Error("writev"); const b1 = Buffer.alloc(3), b2 = Buffer.alloc(3); if (fs.readvSync(fd, [b1, b2], 0) !== 6 || b1 + "" + b2 !== "foobar") throw new Error("readv"); } finally { fs.closeSync(fd); fs.rmSync(p, { force: true }); } });
check("fs.openAsBlob", async () => { const fs = require("node:fs"); const b = await fs.openAsBlob("examples/node-compat-modern.ts"); if (!(b instanceof Blob) || b.size !== fs.statSync("examples/node-compat-modern.ts").size) throw new Error("blob"); });
check("crypto.X509Certificate", () => {
  const { X509Certificate } = require("node:crypto");
  const pem = [
    "-----BEGIN CERTIFICATE-----",
    "MIIDajCCAlKgAwIBAgIULDsc7RLBduukhwfpiKiJjZWkiW4wDQYJKoZIhvcNAQEL",
    "BQAwMjELMAkGA1UEBhMCVVMxDjAMBgNVBAoMBVZlbG94MRMwEQYDVQQDDAp2ZWxv",
    "eC50ZXN0MB4XDTI2MDYwMzEwMDMxNloXDTQ2MDUyOTEwMDMxNlowMjELMAkGA1UE",
    "BhMCVVMxDjAMBgNVBAoMBVZlbG94MRMwEQYDVQQDDAp2ZWxveC50ZXN0MIIBIjAN",
    "BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA912i7MTPfJfqGAJnGxW/3Ahf3How",
    "fVOB2EHf+t7k125akYR73GCiZvH8P61IFjX5ISI278g/F0tkGaD5nKGBK2WleMBL",
    "wXJStTvyM/52BkXVUPIzSonjvKDHup0epoHVV4kCS3q07CPZfh4pzrA7Fe9L9reg",
    "CbJLHFuvRQ2nqvDiFjqyMw6yo6SN1gMOc2skqiaHLksqVbkWByedIl1b5SLswWIa",
    "5/lNkzjIbIS9xEeQoLs0o56KeqHDghlxlIWXfwEZxMhiCtlD1OaPFmPveWnSX9X8",
    "O7WrvJzXG2zqNMT16AgNTxzepVoGR4TEa7S0AUCHcy/UtXHEsm8cb0s5LwIDAQAB",
    "o3gwdjAdBgNVHQ4EFgQU4pT/HrsNYozrj0uIe6o6Xcrqq1MwHwYDVR0jBBgwFoAU",
    "4pT/HrsNYozrj0uIe6o6Xcrqq1MwDwYDVR0TAQH/BAUwAwEB/zAjBgNVHREEHDAa",
    "ggp2ZWxveC50ZXN0ggwqLnZlbG94LnRlc3QwDQYJKoZIhvcNAQELBQADggEBACSn",
    "yJFXdZVJkr8Vks9btwTsdg6Hdo4NqWN34vVuzP58EQRc3sraEOqMhgNOx0v3xGEy",
    "dpmZ/8dE2KyYAPxnu56aRzlL4veVyco4nvpqig6Dik6ezm2Wl7zqktdWDTDepLki",
    "besW0srEUWyrXAAsQiwNAZno5RLk4Yku2MGSI+BJuFP5k+WlJ+HcaxeruKn8fLIy",
    "Npk6mWWZf8Au/YlLVnlvx7kS4ggcsikWYMxkRfdIqFHitznX63RCp6q7ZyXs+GTE",
    "QdYPnUM/ib6wMn4D/gOrm6KfW0mbwoAtSo7U9mUEyEfFq75xbTY50AHvR1Wnq2kc",
    "AAc05ggQ0jIDOeIBtwg=",
    "-----END CERTIFICATE-----",
  ].join("\n");
  const c = new X509Certificate(pem);
  if (!/CN=velox\.test/.test(c.subject)) throw new Error("subject: " + c.subject);
  if (c.fingerprint256.split(":").length !== 32) throw new Error("fp256");
  if (!c.subjectAltName || !c.subjectAltName.includes("DNS:velox.test")) throw new Error("san: " + c.subjectAltName);
  if (c.checkHost("velox.test") !== "velox.test") throw new Error("checkHost");
  if (c.checkHost("foo.velox.test") !== "foo.velox.test") throw new Error("wildcard");
  if (c.checkHost("evil.com") !== undefined) throw new Error("checkHost negative");
  if (!Buffer.isBuffer(c.raw)) throw new Error("raw");
  if (c.publicKey.type !== "public") throw new Error("publicKey");
  if (!(c.validToDate instanceof Date)) throw new Error("validToDate");
  // DER round-trips too
  if (new X509Certificate(c.raw).subject !== c.subject) throw new Error("DER input");
});
check("net.BlockList", () => { const net = require("node:net"); const bl = new net.BlockList(); bl.addAddress("1.2.3.4"); bl.addSubnet("10.0.0.0", 8); bl.addRange("192.168.1.1", "192.168.1.10"); if (!bl.check("1.2.3.4") || bl.check("1.2.3.5") || !bl.check("10.5.6.7") || bl.check("11.0.0.1") || !bl.check("192.168.1.5") || bl.check("192.168.1.20")) throw new Error("check"); if (!net.BlockList.isBlockList(bl)) throw new Error("isBlockList"); });

await new Promise((r) => setTimeout(r, 300));
let pass = 0, fail = 0;
for (const [name, ok, err] of results) { if (ok) pass++; else { fail++; console.log("FAIL " + name + ": " + err); } }
console.log("\n" + pass + " passed, " + fail + " failed of " + results.length);
process.exit(fail > 0 ? 1 : 0);

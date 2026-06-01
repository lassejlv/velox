const results: [string, boolean, string][] = [];
function check(name: string, fn: () => any) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => results.push([name, true, ""]), (e) => results.push([name, false, String(e?.message || e)])); results.push([name, true, ""]); }
  catch (e: any) { results.push([name, false, String(e?.message || e)]); }
}

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

// web crypto subtle (async)
check("crypto.subtle.digest", async () => { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("a")); if (new Uint8Array(d).length !== 32) throw new Error("digest"); });
check("crypto.getRandomValues", () => { const u = new Uint8Array(8); crypto.getRandomValues(u); });
check("crypto.subtle HMAC sign/verify", async () => { const k = await crypto.subtle.importKey("raw", new TextEncoder().encode("k"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]); const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode("m")); if (!(await crypto.subtle.verify("HMAC", k, sig, new TextEncoder().encode("m")))) throw new Error("hmac"); });
check("crypto.subtle AES-GCM", async () => { const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]); const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, new TextEncoder().encode("secret")); const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, k, ct); if (new TextDecoder().decode(pt) !== "secret") throw new Error("gcm"); });
check("crypto.subtle ECDSA P-256", async () => { const kp: any = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]); const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, new TextEncoder().encode("d")); if ((sig as ArrayBuffer).byteLength !== 64) throw new Error("ecdsa raw"); if (!(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, sig, new TextEncoder().encode("d")))) throw new Error("verify"); });

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
check("navigator global", () => { const n = (globalThis as any).navigator; if (!n) throw new Error("no navigator"); if (typeof n.hardwareConcurrency !== "number" || n.hardwareConcurrency < 1) throw new Error("hwc"); if (typeof n.userAgent !== "string" || !n.userAgent) throw new Error("ua"); if (typeof n.onLine !== "boolean") throw new Error("onLine"); if (!Array.isArray(n.languages)) throw new Error("languages"); });
check("TextDecoder stream:true", () => { const d = new TextDecoder(); const a = d.decode(new Uint8Array([0xe2]), { stream: true }); const b = d.decode(new Uint8Array([0x9c, 0x93]), { stream: true }); const c = d.decode(); if (a !== "" || (a + b + c) !== "✓") throw new Error("stream decode"); });
check("TextEncoderStream/TextDecoderStream", async () => { const enc = new (globalThis as any).TextEncoderStream(); const w = enc.writable.getWriter(); w.write("a世"); w.write("界b"); w.close(); let out = ""; for await (const s of enc.readable.pipeThrough(new (globalThis as any).TextDecoderStream())) out += s; if (out !== "a世界b") throw new Error("ts roundtrip: " + out); });
check("process.getBuiltinModule", () => { const fs = (process as any).getBuiltinModule("node:fs"); if (!fs || typeof fs.readFileSync !== "function") throw new Error("gbm"); if ((process as any).getBuiltinModule("nope") !== undefined) throw new Error("gbm-bad"); });
check("Buffer.copyBytesFrom", () => { const u = new Uint16Array([1, 2, 3, 4]); const b = Buffer.copyBytesFrom(u, 1, 2); if (!Buffer.isBuffer(b) || b.length !== 4) throw new Error("cbf"); u[1] = 99; if (b.readUInt16LE(0) !== 2) throw new Error("cbf-not-copied"); });
check("crypto.generatePrimeSync", () => { const c = require("node:crypto"); const p = c.generatePrimeSync(48, { bigint: true }); if (typeof p !== "bigint" || p.toString(2).length !== 48 || !c.checkPrimeSync(p)) throw new Error("genprime"); const buf = c.generatePrimeSync(32); if (!(buf instanceof ArrayBuffer) || !c.checkPrimeSync(Buffer.from(buf))) throw new Error("genprime-buf"); });
check("crypto.checkPrimeSync", () => { const c = require("node:crypto"); if (!c.checkPrimeSync(7919n) || !c.checkPrimeSync(2147483647n)) throw new Error("prime"); if (c.checkPrimeSync(91n) || c.checkPrimeSync(561n)) throw new Error("composite (Carmichael)"); });
check("crypto x25519 keygen + diffieHellman", () => { const c = require("node:crypto"); const a = c.generateKeyPairSync("x25519"); const b = c.generateKeyPairSync("x25519"); const s1 = c.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey }); const s2 = c.diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey }); if (s1.length !== 32 || !s1.equals(s2)) throw new Error("x25519 dh"); });
check("crypto x25519 RFC 7748 vector", () => { const c = require("node:crypto"); const priv = (h: string) => "-----BEGIN PRIVATE KEY-----\n" + Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(h, "hex")]).toString("base64") + "\n-----END PRIVATE KEY-----\n"; const pub = (h: string) => "-----BEGIN PUBLIC KEY-----\n" + Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), Buffer.from(h, "hex")]).toString("base64") + "\n-----END PUBLIC KEY-----\n"; const shared = c.diffieHellman({ privateKey: c.createPrivateKey(priv("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")), publicKey: c.createPublicKey(pub("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")) }); if (shared.toString("hex") !== "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742") throw new Error("rfc7748"); });
check("crypto.hash one-shot", () => { const c = require("node:crypto"); if (c.hash("sha256", "abc") !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") throw new Error("hash"); if (!Buffer.isBuffer(c.hash("sha256", "abc", "buffer"))) throw new Error("hash-buf"); });
check("util.styleText", () => { const { styleText } = require("node:util"); if (styleText("red", "hi") !== "\x1b[31mhi\x1b[39m") throw new Error("styleText"); });
check("util.aborted", async () => { const { aborted } = require("node:util"); const ac = new AbortController(); const p = aborted(ac.signal); ac.abort(); await p; });
check("fs.cpSync recursive", () => { const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path"); const base = fs.mkdtempSync(path.join(os.tmpdir(), "velox-cp-")); fs.mkdirSync(path.join(base, "s/sub"), { recursive: true }); fs.writeFileSync(path.join(base, "s/a.txt"), "hi"); fs.writeFileSync(path.join(base, "s/sub/b.txt"), "yo"); fs.cpSync(path.join(base, "s"), path.join(base, "d"), { recursive: true }); if (fs.readFileSync(path.join(base, "d/a.txt"), "utf8") !== "hi") throw new Error("cp a"); if (fs.readFileSync(path.join(base, "d/sub/b.txt"), "utf8") !== "yo") throw new Error("cp b"); fs.rmSync(base, { recursive: true, force: true }); });
check("fs.globSync", () => { const fs = require("node:fs"); const m = fs.globSync("examples/node-compat-*.ts"); if (!Array.isArray(m) || !m.includes("examples/node-compat-modern.ts")) throw new Error("globSync: " + m.length); });
check("fs.promises.glob async iterator", async () => { const fs = require("node:fs"); const out: string[] = []; for await (const f of fs.promises.glob("*.ts", { cwd: "examples" })) out.push(f); if (!out.includes("node-compat-modern.ts")) throw new Error("aglob"); });
check("stream/consumers", async () => { const { text, json } = require("node:stream/consumers"); const { Readable } = require("node:stream"); if (await text(Readable.from(["a", "b", "c"])) !== "abc") throw new Error("text"); const o = await json(Readable.from(['{"x":', "42}"])); if (o.x !== 42) throw new Error("json"); });
check("CompressionStream gzip round-trip", async () => { const G = globalThis as any; const text = "compress me ".repeat(20); const data = new TextEncoder().encode(text); async function pipe(s: any, b: Uint8Array) { const w = s.writable.getWriter(); w.write(b); w.close(); const out: Uint8Array[] = []; for await (const c of s.readable) out.push(c); let n = 0; out.forEach((c) => (n += c.length)); const m = new Uint8Array(n); let o = 0; for (const c of out) { m.set(c, o); o += c.length; } return m; } const comp = await pipe(new G.CompressionStream("gzip"), data); if (comp.length >= data.length) throw new Error("not compressed"); const back = await pipe(new G.DecompressionStream("gzip"), comp); if (new TextDecoder().decode(back) !== text) throw new Error("cs roundtrip"); });

await new Promise((r) => setTimeout(r, 300));
let pass = 0, fail = 0;
for (const [name, ok, err] of results) { if (ok) pass++; else { fail++; console.log("FAIL " + name + ": " + err); } }
console.log("\n" + pass + " passed, " + fail + " failed of " + results.length);
process.exit(fail > 0 ? 1 : 0);

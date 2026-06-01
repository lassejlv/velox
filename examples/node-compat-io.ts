const results: [string, boolean, string][] = [];
function check(name: string, fn: () => any) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => results.push([name, true, ""]), (e) => results.push([name, false, String(e?.message || e)])); results.push([name, true, ""]); }
  catch (e: any) { results.push([name, false, String(e?.stack || e?.message || e)]); }
}

// module system
check("__dirname", () => { if (typeof __dirname !== "string") throw new Error("no __dirname"); });
check("__filename", () => { if (typeof __filename !== "string") throw new Error("no __filename"); });
check("require.resolve", () => { if (typeof require.resolve !== "function") throw new Error("no resolve"); });
check("require.main", () => { /* may be undefined; just ensure no throw accessing */ const _ = require.main; });
check("import.meta.url", () => { if (typeof import.meta.url !== "string") throw new Error("no meta.url"); });

// assert
check("assert.deepStrictEqual", () => { require("node:assert").deepStrictEqual({a:[1,2]}, {a:[1,2]}); });
check("assert.throws", () => { require("node:assert").throws(() => { throw new Error("x"); }); });
check("assert.rejects", async () => { await require("node:assert").rejects(Promise.reject(new Error("x"))); });
check("assert strict ok", () => { const a = require("node:assert"); a.ok(true); a.strictEqual(1,1); });

// zlib roundtrip
check("zlib gzip/gunzip", () => { const z = require("node:zlib"); const buf = Buffer.from("hello".repeat(50)); const g = z.gzipSync(buf); if (z.gunzipSync(g).toString() !== buf.toString()) throw new Error("gz"); });
check("zlib deflate/inflate", () => { const z = require("node:zlib"); const buf = Buffer.from("xyz".repeat(50)); if (z.inflateSync(z.deflateSync(buf)).toString() !== buf.toString()) throw new Error("df"); });
check("zlib brotli", () => { const z = require("node:zlib"); if (typeof z.brotliCompressSync !== "function") throw new Error("no brotli"); const b = z.brotliCompressSync(Buffer.from("hi".repeat(50))); if (z.brotliDecompressSync(b).toString() !== "hi".repeat(50)) throw new Error("br"); });

// streams piping
check("stream pipe", async () => {
  const { Readable, Writable } = require("node:stream");
  let out = "";
  await new Promise<void>((res, rej) => {
    const r = Readable.from(["a", "b", "c"]);
    const w = new Writable({ write(c: any, e: any, cb: any) { out += c.toString(); cb(); } });
    w.on("finish", res); w.on("error", rej); r.on("error", rej);
    r.pipe(w);
  });
  if (out !== "abc") throw new Error("pipe " + out);
});
check("stream Transform", async () => {
  const { Readable, Transform } = require("node:stream");
  const upper = new Transform({ transform(c: any, e: any, cb: any) { cb(null, c.toString().toUpperCase()); } });
  let out = ""; for await (const ch of Readable.from(["ab"]).pipe(upper)) out += ch;
  if (out !== "AB") throw new Error("tf " + out);
});

// net echo server+client
check("net echo", async () => {
  const net = require("node:net");
  await new Promise<void>((res, rej) => {
    const server = net.createServer((sock: any) => { sock.on("data", (d: any) => sock.write(d)); });
    server.on("error", rej);
    server.listen(0, () => {
      const port = server.address().port;
      const client = net.connect(port, "127.0.0.1", () => client.write("ping"));
      client.on("data", (d: any) => { if (d.toString() === "ping") { client.end(); server.close(); res(); } else rej(new Error("got " + d)); });
      client.on("error", rej);
    });
  });
});

// http server with full req/res semantics
check("http req/res semantics", async () => {
  const http = require("node:http");
  await new Promise<void>((res, rej) => {
    const server = http.createServer((req: any, rsp: any) => {
      let body = "";
      req.on("data", (c: any) => body += c);
      req.on("end", () => {
        rsp.statusCode = 201;
        rsp.setHeader("X-Test", "yes");
        rsp.setHeader("Content-Type", "application/json");
        rsp.end(JSON.stringify({ method: req.method, url: req.url, got: body, ua: req.headers["user-agent"] || null }));
      });
    });
    server.on("error", rej);
    server.listen(0, async () => {
      try {
        const port = server.address().port;
        const r = await fetch("http://127.0.0.1:" + port + "/path?q=1", { method: "POST", body: "hello", headers: { "User-Agent": "vx" } });
        if (r.status !== 201) throw new Error("status " + r.status);
        if (r.headers.get("x-test") !== "yes") throw new Error("hdr");
        const j = await r.json();
        if (j.method !== "POST" || j.url !== "/path?q=1" || j.got !== "hello" || j.ua !== "vx") throw new Error("body " + JSON.stringify(j));
        server.close(); res();
      } catch (e) { server.close(); rej(e); }
    });
  });
});

// child_process
check("child_process.execSync", () => { const cp = require("node:child_process"); if (cp.execSync("echo hi").toString().trim() !== "hi") throw new Error("exec"); });
check("child_process.exec async", async () => { const cp = require("node:child_process"); await new Promise<void>((res, rej) => cp.exec("echo hi", (e: any, out: any) => e ? rej(e) : (out.trim() === "hi" ? res() : rej(new Error("got " + out))))); });
check("child_process.spawn", async () => { const cp = require("node:child_process"); await new Promise<void>((res, rej) => { const p = cp.spawn("echo", ["spawned"]); let out = ""; p.stdout.on("data", (d: any) => out += d); p.on("close", (code: any) => code === 0 && out.trim() === "spawned" ? res() : rej(new Error("spawn " + code + " " + out))); p.on("error", rej); }); });

// process events
check("process.on exit handler", () => { if (typeof process.on !== "function") throw new Error("no on"); process.on("exit", () => {}); });
check("process.removeListener", () => { const f = () => {}; process.on("x", f); process.removeListener("x", f); });

// util.promisify of callback fn
check("util.promisify callback", async () => { const util = require("node:util"); const fn = (a: number, cb: any) => cb(null, a + 1); const p = util.promisify(fn); if (await p(1) !== 2) throw new Error("promisify"); });
check("util.deprecate", () => { const util = require("node:util"); if (typeof util.deprecate(() => 1, "msg")() !== "number") throw new Error("dep"); });

// string_decoder
check("string_decoder", () => { const { StringDecoder } = require("node:string_decoder"); const d = new StringDecoder("utf8"); if (d.write(Buffer.from("héllo")) === "") throw new Error("sd"); });

// path posix/win32
check("path.posix", () => { const path = require("node:path"); if (path.posix.join("a", "b") !== "a/b") throw new Error("posix"); });

// fs async read/write + promisify(fs.chmod) (graceful-fs / create-next-app path)
check("fs async read/write + promisify", async () => {
  const fs = require("node:fs");
  const { promisify } = require("node:util");
  if (typeof fs.chmod !== "function" || typeof fs.read !== "function" || typeof fs.write !== "function") throw new Error("missing fs fns");
  const f = "/tmp/velox-io-rw-" + Date.now() + ".txt";
  fs.writeFileSync(f, "");
  const wfd = fs.openSync(f, "w");
  const wrote: number = await new Promise((res, rej) => fs.write(wfd, Buffer.from("rwtest"), 0, 6, 0, (e: any, n: number) => e ? rej(e) : res(n)));
  fs.closeSync(wfd);
  if (wrote !== 6) throw new Error("write " + wrote);
  const rfd = fs.openSync(f, "r");
  const buf = Buffer.alloc(6);
  const out: string = await new Promise((res, rej) => fs.read(rfd, buf, 0, 6, 0, (e: any, _n: number, b: Buffer) => e ? rej(e) : res(b.toString())));
  fs.closeSync(rfd);
  if (out !== "rwtest") throw new Error("read " + out);
  await promisify(fs.chmod)(f, 0o644); // no-op, must resolve
  fs.unlinkSync(f);
});
// node:constants exposes O_*/S_* flags
check("node:constants", () => { const C = require("node:constants"); if (C.O_CREAT !== 0x200 || C.S_IFREG !== 0x8000 || C.R_OK !== 4) throw new Error("constants"); });

await new Promise((r) => setTimeout(r, 300));
let pass = 0, fail = 0;
for (const [name, ok, err] of results) { if (ok) pass++; else { fail++; console.log("FAIL " + name + ": " + err); } }
console.log("\n" + pass + " passed, " + fail + " failed of " + results.length);
process.exit(fail > 0 ? 1 : 0);

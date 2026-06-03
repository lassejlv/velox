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
// zlib.Inflate exposes the low-level _handle.writeSync binding protocol (pngjs subclasses it).
check("zlib.Inflate _handle.writeSync", () => {
  const z = require("node:zlib");
  const data = Buffer.from("inflate me ".repeat(40));
  const deflated = z.deflateSync(data);
  const inf: any = new z.Inflate();
  if (typeof inf._handle?.writeSync !== "function" || typeof inf._chunkSize !== "number" || !Buffer.isBuffer(inf._buffer)) throw new Error("no handle/fields");
  const out = Buffer.allocUnsafe(inf._chunkSize);
  const [, availOutAfter] = inf._handle.writeSync(4, deflated, 0, deflated.length, out, 0, out.length);
  const produced = out.length - availOutAfter;
  if (out.subarray(0, produced).toString() !== data.toString()) throw new Error("writeSync output");
});

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
// read(n) must return *exactly* n bytes, slicing a chunk and keeping the tail (cbor/binary parsers pull byte-by-byte).
check("stream read(n) byte-precise", () => {
  const { Readable } = require("node:stream");
  const r = new Readable({ read() {} });
  r.push(Buffer.from([1, 2, 3, 4, 5])); r.push(null);
  const a = r.read(1), b = r.read(2), c = r.read(2);
  if (!a || a.length !== 1 || a[0] !== 1) throw new Error("read1");
  if (!b || b.length !== 2 || b[0] !== 2 || b[1] !== 3) throw new Error("read2");
  if (!c || c.length !== 2 || c[0] !== 4 || c[1] !== 5) throw new Error("read3");
});
// Static stream-state predicates (@hono/node-server probes Readable.isDisturbed before reading a body).
check("Readable.isDisturbed/isErrored/isReadable", async () => {
  const { Readable } = require("node:stream");
  const r = new Readable({ read() {} });
  if (Readable.isDisturbed(r) !== false) throw new Error("fresh disturbed");
  if (Readable.isReadable(r) !== true) throw new Error("not readable");
  if (Readable.isErrored(r) !== false) throw new Error("errored");
  r.push("x"); r.push(null);
  await new Promise<void>((res) => { r.on("data", () => {}); r.on("end", () => res()); });
  if (Readable.isDisturbed(r) !== true) throw new Error("not disturbed after read");
});
check("stream Transform", async () => {
  const { Readable, Transform } = require("node:stream");
  const upper = new Transform({ transform(c: any, e: any, cb: any) { cb(null, c.toString().toUpperCase()); } });
  let out = ""; for await (const ch of Readable.from(["ab"]).pipe(upper)) out += ch;
  if (out !== "AB") throw new Error("tf " + out);
});
// readableObjectMode keeps pushed values as-is on the readable side (split2/object Transforms).
check("stream Transform readableObjectMode", async () => {
  const { Readable, Transform } = require("node:stream");
  const lines = new Transform({
    readableObjectMode: true,
    transform(c: any, _e: any, cb: any) { for (const l of c.toString().split("\n")) if (l) this.push(l); cb(); },
  });
  const got: any[] = []; for await (const ch of Readable.from(["a\nb\nc\n"]).pipe(lines)) got.push(ch);
  if (got.length !== 3 || typeof got[0] !== "string" || got[1] !== "b") throw new Error("objmode " + JSON.stringify(got));
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
check("Buffer internal *Slice/*Write methods", () => { const b = Buffer.from("hello world"); if (b.utf8Slice(0, 5) !== "hello") throw new Error("utf8Slice"); if (b.hexSlice(0, 2) !== "6865") throw new Error("hexSlice"); if (b.latin1Slice(6, 11) !== "world") throw new Error("latin1Slice"); const w = Buffer.alloc(5); if (w.utf8Write("abcde", 0, 5) !== 5 || w.toString() !== "abcde") throw new Error("utf8Write"); });
check("node:util/types subpath", () => { const t = require("node:util/types"); if (typeof t.isUint8Array !== "function" || !t.isUint8Array(new Uint8Array(1)) || t.isUint8Array([])) throw new Error("isUint8Array"); if (!t.isArrayBuffer(new ArrayBuffer(1)) || !t.isDate(new Date())) throw new Error("types"); });
check("child_process spawn pid + kill", async () => {
  const { spawn } = require("node:child_process");
  const c = spawn("sleep", ["5"]);
  if (typeof c.pid !== "number" || c.pid <= 0) throw new Error("pid=" + c.pid);
  const sig = await new Promise<string>((resolve) => { c.on("exit", (_code: any, signal: any) => resolve(signal)); c.kill(); setTimeout(() => resolve("TIMEOUT"), 1500); });
  if (sig !== "SIGTERM") throw new Error("kill signal=" + sig);
});
check("fs createReadStream/createWriteStream + ReadStream class", async () => {
  const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velox-rwstream-"));
  try {
    if (typeof fs.ReadStream !== "function" || typeof fs.WriteStream !== "function") throw new Error("classes");
    const f = path.join(dir, "f.txt");
    await new Promise<void>((res, rej) => { const ws = fs.createWriteStream(f); ws.write("a"); ws.write("b"); ws.end("c"); ws.on("finish", res); ws.on("error", rej); });
    let data = ""; await new Promise<void>((res, rej) => { const rs = fs.createReadStream(f, { start: 0, end: 1, encoding: "utf8" }); rs.on("data", (c: any) => (data += c)); rs.on("end", res); rs.on("error", rej); });
    if (data !== "ab") throw new Error("read: " + data);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
check("fs symlink/readlink/link + lstat", () => {
  const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "velox-sym-"));
  try {
    const target = path.join(dir, "t.txt"); fs.writeFileSync(target, "data");
    const link = path.join(dir, "l"); fs.symlinkSync(target, link);
    if (fs.readlinkSync(link) !== target) throw new Error("readlink");
    if (!fs.lstatSync(link).isSymbolicLink()) throw new Error("isSymbolicLink");
    const hard = path.join(dir, "h"); fs.linkSync(target, hard);
    if (fs.readFileSync(hard, "utf8") !== "data") throw new Error("hardlink");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
check("fs.statSync bigint", () => { const fs = require("node:fs"); const s = fs.statSync(".", { bigint: true }); if (typeof s.size !== "bigint" || typeof s.mtimeMs !== "bigint") throw new Error("bigint stat"); });
check("fs.promises.open FileHandle", async () => {
  const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
  const f = path.join(os.tmpdir(), "velox-fh-" + process.pid); fs.writeFileSync(f, "fh-data");
  try { const fh = await fs.promises.open(f, "r"); const { bytesRead, buffer } = await fh.read(Buffer.alloc(7), 0, 7, 0); await fh.close(); if (bytesRead !== 7 || buffer.toString() !== "fh-data") throw new Error("read"); } finally { fs.rmSync(f, { force: true }); }
});
check("net socket paused-mode read() via 'readable'", async () => {
  const net = require("node:net");
  await new Promise<void>((resolve, reject) => {
    const srv = net.createServer((sock: any) => { sock.on("data", () => sock.end("PAYLOAD")); });
    srv.listen(0, () => {
      const port = srv.address().port;
      const c = net.connect(port, "127.0.0.1", () => c.write("go"));
      let out = "";
      // 'readable' (not 'data') keeps the socket paused — this is how undici and
      // other low-level clients pull bytes; regression guard for that mode.
      c.on("readable", () => { let chunk; while ((chunk = c.read()) !== null) out += chunk; });
      c.on("end", () => { srv.close(); out === "PAYLOAD" ? resolve() : reject(new Error("got: " + out)); });
      c.on("error", reject);
      setTimeout(() => reject(new Error("paused-read timeout")), 1500);
    });
  });
});

await new Promise((r) => setTimeout(r, 300));
let pass = 0, fail = 0;
for (const [name, ok, err] of results) { if (ok) pass++; else { fail++; console.log("FAIL " + name + ": " + err); } }
console.log("\n" + pass + " passed, " + fail + " failed of " + results.length);
process.exit(fail > 0 ? 1 : 0);

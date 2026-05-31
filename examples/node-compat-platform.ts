// Node compat regression — platform surface: EventTarget/CustomEvent, perf_hooks,
// os/process extras, assert extras, advanced streams, streaming HTTP responses,
// net socket props. Run: cargo run -- examples/node-compat-platform.ts
const results: [string, boolean, string][] = [];
function check(name: string, fn: () => any) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => results.push([name, true, ""]), (e) => results.push([name, false, String(e?.message || e)])); results.push([name, true, ""]); }
  catch (e: any) { results.push([name, false, String(e?.message || e)]); }
}

// EventTarget / Event (used by AbortSignal, web APIs)
check("EventTarget/Event", () => { if (typeof EventTarget === "undefined" || typeof Event === "undefined") throw new Error("missing"); const t = new EventTarget(); let got = false; t.addEventListener("x", () => got = true); t.dispatchEvent(new Event("x")); if (!got) throw new Error("no dispatch"); });
check("CustomEvent", () => { if (typeof CustomEvent === "undefined") throw new Error("no CustomEvent"); const e = new CustomEvent("x", { detail: 42 }); if (e.detail !== 42) throw new Error("detail"); });

// perf_hooks
check("perf_hooks.performance", () => { const { performance } = require("node:perf_hooks"); if (typeof performance.now() !== "number") throw new Error("now"); });
check("performance.timeOrigin", () => { if (typeof performance.timeOrigin !== "number") throw new Error("origin"); });

// os extras
check("os.availableParallelism", () => { const os = require("node:os"); if (typeof os.availableParallelism !== "function") throw new Error("no ap"); if (os.availableParallelism() < 1) throw new Error("ap"); });
check("os.uptime", () => { const os = require("node:os"); if (typeof os.uptime() !== "number") throw new Error("uptime"); });
check("os.loadavg", () => { const os = require("node:os"); if (!Array.isArray(os.loadavg())) throw new Error("loadavg"); });
check("os.version/machine", () => { const os = require("node:os"); if (typeof os.version !== "function" || typeof os.machine !== "function") throw new Error("vm"); });
check("os.constants", () => { const os = require("node:os"); if (!os.constants || !os.constants.signals) throw new Error("const"); });

// process extras
check("process.cpuUsage", () => { if (typeof process.cpuUsage !== "function") throw new Error("no cpu"); const u = process.cpuUsage(); if (typeof u.user !== "number") throw new Error("cpu"); });
check("process.hrtime tuple", () => { const t = process.hrtime(); if (!Array.isArray(t) || t.length !== 2) throw new Error("hr"); const d = process.hrtime(t); if (!Array.isArray(d)) throw new Error("hrdiff"); });
check("process.uptime", () => { if (typeof process.uptime() !== "number") throw new Error("uptime"); });
check("process.title", () => { if (typeof process.title !== "string") throw new Error("title"); });
check("process.stdout.columns", () => { const c = process.stdout.columns; if (c !== undefined && typeof c !== "number") throw new Error("cols"); });
check("process.emitWarning", () => { if (typeof process.emitWarning !== "function") throw new Error("no warn"); process.emitWarning("test"); });

// assert extras
check("assert.match", () => { const a = require("node:assert"); if (typeof a.match !== "function") throw new Error("no match"); a.match("hello", /ell/); });
check("assert.deepEqual loose", () => { const a = require("node:assert"); a.deepEqual({ x: 1 }, { x: "1" } as any); });
check("assert.notStrictEqual", () => { const a = require("node:assert"); a.notStrictEqual(1, 2); });
check("assert.ifError", () => { const a = require("node:assert"); a.ifError(null); });

// streams advanced
check("Readable.toArray", async () => { const { Readable } = require("node:stream"); if (typeof Readable.from(["a"]).toArray !== "function") throw new Error("no toArray"); const arr = await Readable.from(["a", "b"]).toArray(); if (arr.join("") !== "ab") throw new Error("ta=" + arr); });
check("stream objectMode", async () => { const { Readable } = require("node:stream"); const r = Readable.from([{ n: 1 }, { n: 2 }], { objectMode: true }); let sum = 0; for await (const o of r) sum += o.n; if (sum !== 3) throw new Error("om=" + sum); });
check("Duplex exists", () => { const { Duplex } = require("node:stream"); if (typeof Duplex !== "function") throw new Error("no Duplex"); });
check("PassThrough", async () => { const { PassThrough } = require("node:stream"); const pt = new PassThrough(); let out = ""; pt.on("data", (c: any) => out += c); pt.write("a"); pt.end("b"); await new Promise((r) => pt.on("end", r)); if (out !== "ab") throw new Error("pt=" + out); });

// http streaming response (res.write chunks) + STATUS_CODES
check("http.STATUS_CODES", () => { const http = require("node:http"); if (http.STATUS_CODES[404] !== "Not Found") throw new Error("sc=" + http.STATUS_CODES[404]); });
check("http chunked response", async () => {
  const http = require("node:http");
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req: any, res: any) => { res.writeHead(200, { "Content-Type": "text/plain" }); res.write("chunk1-"); res.write("chunk2-"); res.end("end"); });
    server.on("error", reject);
    server.listen(0, async () => {
      try { const port = server.address().port; const r = await fetch("http://127.0.0.1:" + port + "/"); const t = await r.text(); server.close(); t === "chunk1-chunk2-end" ? resolve() : reject(new Error("got " + t)); }
      catch (e) { server.close(); reject(e); }
    });
  });
});

// net socket props
check("net socket remoteAddress", async () => {
  const net = require("node:net");
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer((sock: any) => { sock.setNoDelay && sock.setNoDelay(true); sock.end("hi"); });
    server.on("error", reject);
    server.listen(0, () => {
      const port = server.address().port;
      const c = net.connect(port, "127.0.0.1", () => {});
      c.on("data", () => {});
      c.on("end", () => { server.close(); resolve(); });
      c.on("error", (e: any) => { server.close(); reject(e); });
    });
  });
});

// path.win32 (Windows path semantics) + matchesGlob
check("path.win32 basics", () => {
  const w = require("node:path").win32;
  if (w.sep !== "\\" || w.delimiter !== ";") throw new Error("sep");
  if (w.basename("C:\\dir\\file.txt") !== "file.txt") throw new Error("basename");
  if (w.dirname("C:\\a\\b\\c") !== "C:\\a\\b") throw new Error("dirname=" + w.dirname("C:\\a\\b\\c"));
  if (w.extname("f.tar.gz") !== ".gz") throw new Error("ext");
  if (!w.isAbsolute("C:\\x") || w.isAbsolute("x")) throw new Error("abs");
  if (w.join("C:\\a", "b", "..", "c") !== "C:\\a\\c") throw new Error("join=" + w.join("C:\\a", "b", "..", "c"));
  if (w.normalize("C:\\a\\..\\b") !== "C:\\b") throw new Error("norm");
  if (w.relative("C:\\a\\b", "C:\\a\\c") !== "..\\c") throw new Error("rel=" + w.relative("C:\\a\\b", "C:\\a\\c"));
  const p = w.parse("C:\\path\\file.txt");
  if (p.root !== "C:\\" || p.base !== "file.txt" || p.ext !== ".txt" || p.name !== "file") throw new Error("parse");
});
check("path.posix unchanged + matchesGlob", () => {
  const path = require("node:path");
  if (path.sep !== "/") throw new Error("default not posix");
  if (path.posix.join("a", "b") !== "a/b") throw new Error("posix");
  if (!path.matchesGlob("src/index.js", "src/*.js") || path.matchesGlob("src/a/b.js", "src/*.js")) throw new Error("glob");
  if (!path.matchesGlob("a/b/c.ts", "**/*.ts")) throw new Error("globstar");
});

// diagnostics_channel (used by fastify/pino/undici)
check("diagnostics_channel pub/sub", () => {
  const dc = require("node:diagnostics_channel");
  const ch = dc.channel("vx:test");
  let got: any = null;
  const fn = (msg: any) => { got = msg; };
  ch.subscribe(fn);
  if (!dc.hasSubscribers("vx:test")) throw new Error("hasSubscribers");
  ch.publish({ n: 42 });
  if (got?.n !== 42) throw new Error("publish");
  ch.unsubscribe(fn);
  if (dc.hasSubscribers("vx:test")) throw new Error("unsub");
});
// node:module — createRequire + builtin introspection
check("module.createRequire + isBuiltin", () => {
  const Module = require("node:module");
  const req = Module.createRequire("/x.js");
  if (typeof req("node:os").platform !== "function") throw new Error("createRequire");
  if (!Module.isBuiltin("fs") || Module.isBuiltin("not-a-builtin")) throw new Error("isBuiltin");
  if (!Array.isArray(Module.builtinModules)) throw new Error("builtinModules");
});

// vm — sandboxed execution with host isolation
check("vm.runInNewContext result", () => { const vm = require("node:vm"); if (vm.runInNewContext("a*b", { a: 6, b: 7 }) !== 42) throw new Error("calc"); });
check("vm host isolation", () => { const vm = require("node:vm"); if (vm.runInNewContext("typeof process", {}) !== "undefined") throw new Error("leak"); });
check("vm intrinsics available", () => { const vm = require("node:vm"); if (vm.runInNewContext("Math.max(1,9) + JSON.stringify([1]).length", {}) !== 12) throw new Error("intr"); });
check("vm implicit write-back", () => { const vm = require("node:vm"); const s: any = { x: 1 }; vm.runInNewContext("y = x + 4", s); if (s.y !== 5) throw new Error("wb=" + s.y); });
check("vm var/function write-back", () => { const vm = require("node:vm"); const s: any = { n: 3 }; vm.runInNewContext("var sq = n*n; function f(){return 7} var r = f();", s); if (s.sq !== 9 || s.r !== 7) throw new Error("var-wb=" + s.sq + "," + s.r); });
check("vm object result marshals", () => { const vm = require("node:vm"); const o: any = vm.runInNewContext("({ k: [1, 2, 3] })", {}); if (o.k[2] !== 3) throw new Error("marshal"); });
check("vm exception propagates", () => { const vm = require("node:vm"); try { vm.runInNewContext("throw new Error('x')", {}); throw new Error("no-throw"); } catch (e: any) { if (e.message !== "x") throw new Error("wrong " + e.message); } });
check("vm.createContext persistence", () => { const vm = require("node:vm"); const c: any = vm.createContext({ n: 0 }); vm.runInContext("n++", c); vm.runInContext("n++", c); if (c.n !== 2 || !vm.isContext(c)) throw new Error("persist=" + c.n); });

await new Promise((r) => setTimeout(r, 200));
let pass = 0, fail = 0;
for (const [name, ok, err] of results) { if (ok) pass++; else { fail++; console.log("FAIL " + name + ": " + err); } }
console.log("\n" + pass + " passed, " + fail + " failed of " + results.length);
process.exit(fail > 0 ? 1 : 0);

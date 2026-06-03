// Node compat regression — web platform & error handling: URL, Headers/Request/
// Response/Blob/FormData, AbortController+fetch, process error events, EventEmitter
// error semantics. Run: cargo run -- examples/node-compat-web.ts
const results: [string, boolean, string][] = [];
function check(name: string, fn: () => any) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => results.push([name, true, ""]), (e) => results.push([name, false, String(e?.message || e)])); results.push([name, true, ""]); }
  catch (e: any) { results.push([name, false, String(e?.message || e)]); }
}

// URL / URLSearchParams full API
check("URL parse + parts", () => { const u = new URL("https://user:pass@ex.com:8080/p/q?a=1#h"); if (u.hostname !== "ex.com" || u.port !== "8080" || u.pathname !== "/p/q" || u.hash !== "#h" || u.username !== "user") throw new Error("parts " + u.hostname); });
check("URL pathname setter", () => { const u = new URL("https://ex.com/a"); u.pathname = "/b/c"; if (!u.href.endsWith("/b/c")) throw new Error("set " + u.href); });
check("URLSearchParams mutate", () => { const sp = new URLSearchParams("a=1"); sp.append("b", "2"); sp.set("a", "9"); sp.delete("b"); if (sp.toString() !== "a=9") throw new Error("sp=" + sp.toString()); });
check("URLSearchParams iterate", () => { const sp = new URLSearchParams("a=1&b=2"); const out: string[] = []; for (const [k, v] of sp) out.push(k + v); if (out.join(",") !== "a1,b2") throw new Error("it=" + out); });
check("URL searchParams sync", () => { const u = new URL("https://ex.com/?x=1"); u.searchParams.set("y", "2"); if (u.search.indexOf("y=2") === -1) throw new Error("sync=" + u.search); });
check("URL percent-encodes query space", () => { const u = new URL("http://x.com/?q=a b"); if (u.search !== "?q=a%20b") throw new Error("enc=" + u.search); });
check("URL percent-encodes path space", () => { const u = new URL("http://x.com/a b"); if (u.pathname !== "/a%20b") throw new Error("path=" + u.pathname); });
check("URL.canParse", () => { if (!(URL as any).canParse("http://x.com") || (URL as any).canParse("::bad")) throw new Error("canParse"); });

// Headers
check("Headers full API", () => { const h = new Headers({ "Content-Type": "text/plain" }); h.append("X-A", "1"); h.append("X-A", "2"); if (h.get("x-a") !== "1, 2") throw new Error("ga=" + h.get("x-a")); if (!h.has("content-type")) throw new Error("has"); h.delete("x-a"); if (h.has("x-a")) throw new Error("del"); });
check("Headers iterate", () => { const h = new Headers({ a: "1", b: "2" }); const out: string[] = []; h.forEach((v, k) => out.push(k + "=" + v)); if (out.length !== 2) throw new Error("it=" + out); });

// Request / Response
check("Response.json + status", async () => { const r = Response.json({ ok: 1 }, { status: 201 }); if (r.status !== 201) throw new Error("st"); if ((await r.json()).ok !== 1) throw new Error("j"); });
check("Response.text", async () => { const r = new Response("hi"); if (await r.text() !== "hi") throw new Error("t"); });
check("Response.arrayBuffer", async () => { const r = new Response("abc"); const ab = await r.arrayBuffer(); if (new Uint8Array(ab).length !== 3) throw new Error("ab"); });
check("Response.body stream consumption", async () => {
  const r = new Response("abc");
  const body = r.body;
  if (r.bodyUsed) throw new Error("body access consumed");
  const clone = r.clone();
  if (await clone.text() !== "abc") throw new Error("clone");
  const reader = body!.getReader();
  const first = await reader.read();
  if (!r.bodyUsed || first.done || first.value.length !== 3) throw new Error("stream read");
  try { await r.text(); throw new Error("text should reject"); }
  catch (e: any) { if (!/consumed/.test(String(e.message))) throw e; }

  const r2 = new Response("xyz");
  if (await r2.text() !== "xyz") throw new Error("text");
  const afterText = await r2.body!.getReader().read();
  if (!afterText.done) throw new Error("stream after text");
});
check("Request clone", async () => { const req = new Request("https://ex.com", { method: "POST", body: "x" }); const c = req.clone(); if (c.method !== "POST" || await c.text() !== "x") throw new Error("clone"); });
check("Response.ok ranges", () => { if (!new Response("", { status: 200 }).ok) throw new Error("200"); if (new Response("", { status: 404 }).ok) throw new Error("404"); });
check("WebAssembly instantiate with imports", async () => {
  // (module (import "env" "log" (func $log (param i32))) (func (export "run") i32.const 42 call $log))
  const bytes = new Uint8Array([0,0x61,0x73,0x6d,1,0,0,0, 1,8,2,0x60,1,0x7f,0,0x60,0,0, 2,0x0b,1,3,0x65,0x6e,0x76,3,0x6c,0x6f,0x67,0,0, 3,2,1,1, 7,7,1,3,0x72,0x75,0x6e,0,1, 0x0a,8,1,6,0,0x41,0x2a,0x10,0,0x0b]);
  let got = -1;
  const { instance } = await WebAssembly.instantiate(bytes, { env: { log: (x: number) => { got = x; } } });
  (instance.exports as any).run();
  if (got !== 42) throw new Error("import callback not invoked: " + got);
});

// Modern URL / Headers / Intl / JS surface
check("URL.parse + canParse", () => { if ((URL as any).parse("not a url") !== null) throw new Error("parse null"); const u = (URL as any).parse("http://a.com/p"); if (!u || u.pathname !== "/p") throw new Error("parse"); if (!(URL as any).canParse("http://a.com") || (URL as any).canParse("nope")) throw new Error("canParse"); });
check("URLSearchParams.size", () => { if (new URLSearchParams("a=1&b=2").size !== 2) throw new Error("size"); });
check("Headers.getSetCookie", () => { const h = new Headers(); h.append("set-cookie", "a=1"); h.append("set-cookie", "b=2"); if (h.getSetCookie().length !== 2) throw new Error("cookies"); });
check("Object.groupBy / Map.groupBy", () => { const g: any = (Object as any).groupBy([1, 2, 3, 4], (x: number) => x % 2 ? "odd" : "even"); if (g.odd.length !== 2 || g.even.length !== 2) throw new Error("groupBy"); if (typeof (Map as any).groupBy !== "function") throw new Error("Map.groupBy"); });
check("Array toSorted/toReversed/with", () => { const a = [3, 1, 2]; if (a.toSorted().join("") !== "123" || a.toReversed().join("") !== "213" || a.with(0, 9).join("") !== "912") throw new Error("array"); });
check("Intl breadth (PluralRules/DisplayNames/RTF)", () => { if (new Intl.PluralRules("en").select(1) !== "one") throw new Error("plural"); if (new (Intl as any).DisplayNames(["en"], { type: "language" }).of("fr") !== "French") throw new Error("display"); if (typeof new (Intl as any).RelativeTimeFormat("en").format(-1, "day") !== "string") throw new Error("rtf"); });

// Blob / FormData
check("Blob", async () => { const b = new Blob(["a", "b"], { type: "text/plain" }); if (b.size !== 2) throw new Error("size"); if (await b.text() !== "ab") throw new Error("text"); });
check("Blob.stream() + slice", async () => { const b = new Blob(["hello world"]); if (await b.slice(0, 5).text() !== "hello") throw new Error("slice"); const r = b.stream().getReader(); let out = new Uint8Array(0); for (;;) { const { done, value } = await r.read(); if (done) break; const n = new Uint8Array(out.length + value.length); n.set(out); n.set(value, out.length); out = n; } if (new TextDecoder().decode(out) !== "hello world") throw new Error("stream"); });
check("ReadableStream pipeThrough/pipeTo", async () => { const rs = new ReadableStream({ start(c) { c.enqueue("a"); c.enqueue("b"); c.close(); } }); const ts = new TransformStream({ transform(ch, ctrl) { ctrl.enqueue(String(ch).toUpperCase()); } }); let out = ""; const ws = new WritableStream({ write(ch) { out += ch; } }); await rs.pipeThrough(ts).pipeTo(ws); if (out !== "AB") throw new Error("pipe: " + out); });
check("FormData", () => { const fd = new FormData(); fd.append("a", "1"); fd.append("a", "2"); if (fd.getAll("a").join(",") !== "1,2") throw new Error("fd"); });

// AbortController + fetch cancellation
check("fetch abort", async () => {
  const http = require("node:http");
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req: any, res: any) => { setTimeout(() => res.end("late"), 500); });
    server.on("error", reject);
    server.listen(0, async () => {
      const port = server.address().port;
      const ac = new AbortController();
      const p = fetch("http://127.0.0.1:" + port + "/", { signal: ac.signal });
      ac.abort();
      try { await p; server.close(); reject(new Error("should have aborted")); }
      catch (e: any) { server.close(); (e.name === "AbortError" || /abort/i.test(String(e.message))) ? resolve() : reject(new Error("wrong err " + e.name + " " + e.message)); }
    });
  });
});

// process error events
check("process.on uncaughtException registerable", () => { const f = () => {}; process.on("uncaughtException", f); process.removeListener("uncaughtException", f); });
check("process.on unhandledRejection registerable", () => { const f = () => {}; process.on("unhandledRejection", f); process.removeListener("unhandledRejection", f); });

// EventEmitter error semantics: emitting 'error' with no listener throws
check("EventEmitter error throws", () => {
  const { EventEmitter } = require("node:events");
  const ee = new EventEmitter();
  try { ee.emit("error", new Error("boom")); throw new Error("should have thrown"); }
  catch (e: any) { if (!/boom/.test(e.message)) throw new Error("wrong: " + e.message); }
});
check("EventEmitter error listener catches", () => {
  const { EventEmitter } = require("node:events");
  const ee = new EventEmitter(); let caught = false;
  ee.on("error", () => { caught = true; });
  ee.emit("error", new Error("x"));
  if (!caught) throw new Error("not caught");
});

// queueMicrotask + nextTick ordering vs setTimeout
check("microtask before macrotask", async () => {
  const order: string[] = [];
  await new Promise<void>((res) => { setTimeout(() => { order.push("macro"); res(); }, 0); queueMicrotask(() => order.push("micro")); });
  if (order[0] !== "micro") throw new Error("order=" + order);
});
check("BroadcastChannel same-name delivery", async () => {
  const a = new BroadcastChannel("velox-test"); const b = new BroadcastChannel("velox-test");
  const got = await new Promise<any>((res) => { let self = false; a.onmessage = () => (self = true); b.onmessage = (e: any) => res(e.data); a.postMessage(42); setTimeout(() => res(self ? "SELF" : "none"), 50); });
  a.close(); b.close();
  if (got !== 42) throw new Error("bc got=" + got);
});
check("node:buffer re-exports Blob/File", async () => {
  const { Blob, File } = require("node:buffer");
  if (new Blob(["x"]).size !== 1) throw new Error("Blob");
  const f = new File(["ab"], "a.txt"); if (f.name !== "a.txt" || f.size !== 2) throw new Error("File");
});
check("EventTarget addEventListener signal/once", () => { const et = new EventTarget(); let n = 0; const ac = new AbortController(); et.addEventListener("x", () => n++, { signal: ac.signal }); ac.abort(); et.dispatchEvent(new Event("x")); if (n !== 0) throw new Error("signal n=" + n); let m = 0; et.addEventListener("y", () => m++, { once: true }); et.dispatchEvent(new Event("y")); et.dispatchEvent(new Event("y")); if (m !== 1) throw new Error("once m=" + m); });
check("Request always has a signal", () => { const r = new Request("http://x", { method: "POST", body: "y" }); if (!r.signal || typeof r.signal.aborted !== "boolean" || r.signal.aborted) throw new Error("signal"); });
check("MessageChannel ports", async () => {
  const mc = new MessageChannel();
  const v = await new Promise<any>((res) => { mc.port1.onmessage = (e: any) => res(e.data); mc.port2.postMessage(7); mc.port1.start?.(); mc.port2.start?.(); });
  if (v !== 7) throw new Error("mc=" + v);
});

await new Promise((r) => setTimeout(r, 200));
let pass = 0, fail = 0;
for (const [name, ok, err] of results) { if (ok) pass++; else { fail++; console.log("FAIL " + name + ": " + err); } }
console.log("\n" + pass + " passed, " + fail + " failed of " + results.length);
process.exit(fail > 0 ? 1 : 0);

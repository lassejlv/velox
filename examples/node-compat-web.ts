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

// Blob / FormData
check("Blob", async () => { const b = new Blob(["a", "b"], { type: "text/plain" }); if (b.size !== 2) throw new Error("size"); if (await b.text() !== "ab") throw new Error("text"); });
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

await new Promise((r) => setTimeout(r, 200));
let pass = 0, fail = 0;
for (const [name, ok, err] of results) { if (ok) pass++; else { fail++; console.log("FAIL " + name + ": " + err); } }
console.log("\n" + pass + " passed, " + fail + " failed of " + results.length);
process.exit(fail > 0 ? 1 : 0);

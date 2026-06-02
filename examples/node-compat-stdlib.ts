// Node compat regression — stdlib depth: stream/promises, child_process breadth
// (execFile/fork+IPC/spawnSync), fs.promises off-thread mutations, URL edge
// cases, http, and process-as-EventEmitter. Run:
//   cargo run -- examples/node-compat-stdlib.ts
const results: [string, boolean, string][] = [];
function check(name: string, fn: () => any) {
  try { const r = fn(); if (r instanceof Promise) return r.then(() => results.push([name, true, ""]), (e) => results.push([name, false, String(e?.message || e)])); results.push([name, true, ""]); }
  catch (e: any) { results.push([name, false, String(e?.message || e)]); }
}

// http response is a proper Readable (works with stream.pipeline + async iter)
check("http response stream.pipeline", async () => {
  const http = require("node:http");
  const { pipeline } = require("node:stream/promises");
  const { Writable } = require("node:stream");
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req: any, res: any) => res.end("a-b-c"));
    server.on("error", reject);
    server.listen(0, () => {
      const port = server.address().port;
      http.get("http://127.0.0.1:" + port + "/", async (res: any) => {
        if (typeof res.pipe !== "function" || typeof res[Symbol.asyncIterator] !== "function") { server.close(); return reject(new Error("not a Readable")); }
        let out = "";
        const sink = new Writable({ write(c: any, e: any, cb: any) { out += c.toString(); cb(); } });
        try { await pipeline(res, sink); server.close(); out === "a-b-c" ? resolve() : reject(new Error("got " + out)); }
        catch (e) { server.close(); reject(e); }
      }).on("error", (e: any) => { server.close(); reject(e); });
    });
  });
});

// dgram (UDP) server + client round-trip
check("dgram UDP round-trip", async () => {
  const dgram = require("node:dgram");
  await new Promise<void>((resolve, reject) => {
    const server = dgram.createSocket("udp4");
    const to = setTimeout(() => { try { server.close(); } catch (e) {} reject(new Error("udp timeout")); }, 4000);
    server.on("message", (msg: any, rinfo: any) => { server.send("R:" + msg.toString(), rinfo.port, rinfo.address); });
    server.on("error", reject);
    server.on("listening", () => {
      const port = server.address().port;
      const client = dgram.createSocket("udp4");
      client.on("message", (msg: any) => {
        clearTimeout(to);
        const ok = msg.toString() === "R:ping";
        client.close(); server.close();
        ok ? resolve() : reject(new Error("got " + msg));
      });
      client.on("error", reject);
      client.send("ping", port, "127.0.0.1");
    });
    server.bind(0);
  });
});

// WebSocket (RFC 6455) server + client round-trip
check("WebSocket round-trip", async () => {
  const { WebSocketServer } = require("node:ws");
  const http = require("node:http");
  await new Promise<void>((resolve, reject) => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws: any) => ws.on("message", (d: any) => ws.send("R:" + d.toString())));
    server.on("error", reject);
    server.listen(0, () => {
      const port = server.address().port;
      const client = new WebSocket("ws://127.0.0.1:" + port + "/");
      const to = setTimeout(() => { try { wss.close(); server.close(); } catch (e) {} reject(new Error("ws timeout")); }, 4000);
      client.onopen = () => client.send("ping");
      client.onmessage = (ev: any) => {
        clearTimeout(to);
        const ok = String(ev.data) === "R:ping";
        client.close(); wss.close(); server.close();
        ok ? resolve() : reject(new Error("got " + ev.data));
      };
      client.onerror = (e: any) => { clearTimeout(to); reject(new Error("ws err")); };
    });
  });
});

// async_hooks / AsyncLocalStorage — context propagation across timers, microtasks,
// nextTick, and .then chains, with concurrent-context isolation.
check("AsyncLocalStorage propagation", async () => {
  const { AsyncLocalStorage } = require("node:async_hooks");
  const als = new AsyncLocalStorage();
  await new Promise<void>((resolve, reject) => {
    als.run({ id: "ctx" }, () => {
      setTimeout(() => {
        if (als.getStore()?.id !== "ctx") return reject(new Error("setTimeout"));
        process.nextTick(() => {
          if (als.getStore()?.id !== "ctx") return reject(new Error("nextTick"));
          Promise.resolve().then(() => {
            if (als.getStore()?.id !== "ctx") return reject(new Error("then"));
            resolve();
          });
        });
      }, 2);
    });
  });
});
check("AsyncLocalStorage concurrent isolation", async () => {
  const { AsyncLocalStorage } = require("node:async_hooks");
  const als = new AsyncLocalStorage();
  const seen: string[] = [];
  await new Promise<void>((resolve) => {
    let n = 0; const fin = () => { if (++n === 2) resolve(); };
    als.run({ id: "P" }, () => setTimeout(() => { seen.push(als.getStore().id); fin(); }, 2));
    als.run({ id: "Q" }, () => setTimeout(() => { seen.push(als.getStore().id); fin(); }, 4));
  });
  if (seen.sort().join() !== "P,Q") throw new Error("isolation " + seen);
});
check("AsyncLocalStorage nested run + getStore", () => {
  const { AsyncLocalStorage } = require("node:async_hooks");
  const als = new AsyncLocalStorage();
  if (als.getStore() !== undefined) throw new Error("outside");
  als.run(1, () => { als.run(2, () => { if (als.getStore() !== 2) throw new Error("inner"); }); if (als.getStore() !== 1) throw new Error("restore"); });
});

// stream/promises — actually pipe, not just exist
check("stream/promises pipeline works", async () => {
  const { Readable, Writable } = require("node:stream");
  const { pipeline } = require("node:stream/promises");
  let out = "";
  const w = new Writable({ write(c: any, e: any, cb: any) { out += c.toString(); cb(); } });
  await pipeline(Readable.from(["a", "b", "c"]), w);
  if (out !== "abc") throw new Error("piped=" + out);
});
check("stream/promises finished works", async () => {
  const { Readable } = require("node:stream");
  const { finished } = require("node:stream/promises");
  const r = Readable.from(["x"]); r.resume();
  await finished(r);
});

// child_process breadth
check("cp.execFileSync", () => { const cp = require("node:child_process"); if (typeof cp.execFileSync !== "function") throw new Error("no execFileSync"); const o = cp.execFileSync("echo", ["hi"]).toString().trim(); if (o !== "hi") throw new Error("got " + o); });
check("cp.execFile async", async () => { const cp = require("node:child_process"); if (typeof cp.execFile !== "function") throw new Error("no execFile"); await new Promise<void>((res, rej) => cp.execFile("echo", ["yo"], (e: any, out: any) => e ? rej(e) : (out.trim() === "yo" ? res() : rej(new Error("got " + out))))); });
check("cp.fork", () => { const cp = require("node:child_process"); if (typeof cp.fork !== "function") throw new Error("no fork"); });
// node:cluster primary-only stub (rate-limiter-flexible and others require it at load).
check("cluster primary stub", () => { const cluster = require("node:cluster"); if (cluster.isPrimary !== true || cluster.isMaster !== true || cluster.isWorker !== false) throw new Error("flags"); if (typeof cluster.on !== "function" || typeof cluster.fork !== "function") throw new Error("api"); });
// tls.Server exists for instanceof checks (supertest: `app instanceof tls.Server`).
check("tls.Server constructor", () => { const tls = require("node:tls"); if (typeof tls.Server !== "function" || typeof tls.createServer !== "function") throw new Error("no Server"); const s = new tls.Server(); const net = require("node:net"); if (!(s instanceof net.Server)) throw new Error("not net.Server"); if (({}) instanceof tls.Server) throw new Error("false positive"); });
// node:sqlite — real embedded SQLite (DatabaseSync/StatementSync).
check("sqlite DatabaseSync CRUD", () => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB)");
  const ins = db.prepare("INSERT INTO t (name, data) VALUES (?, ?)");
  const info = ins.run("Alice", Buffer.from([1, 2, 3]));
  if (info.changes !== 1 || info.lastInsertRowid !== 1) throw new Error("run");
  ins.run("Bob", null);
  const row: any = db.prepare("SELECT * FROM t WHERE name = ?").get("Alice");
  if (row.id !== 1 || row.name !== "Alice" || !Buffer.isBuffer(row.data) || row.data[2] !== 3) throw new Error("get/blob");
  const all: any[] = db.prepare("SELECT name FROM t ORDER BY id").all();
  if (all.length !== 2 || all[0].name !== "Alice" || all[1].name !== "Bob") throw new Error("all");
  const named: any = db.prepare("SELECT * FROM t WHERE id = :id").get({ id: 2 });
  if (named.name !== "Bob" || named.data !== null) throw new Error("named/null");
  const it: string[] = [];
  for (const r of db.prepare("SELECT name FROM t ORDER BY name").iterate() as any) it.push(r.name);
  if (it.join(",") !== "Alice,Bob") throw new Error("iterate");
  if (db.isOpen !== true) throw new Error("isOpen");
  db.close();
  if (db.isOpen !== false) throw new Error("close");
});
// better-sqlite3 shim over node:sqlite (knex/Drizzle target it).
check("better-sqlite3 shim", () => {
  const Database = require("better-sqlite3");
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n TEXT)");
  const ins = db.prepare("INSERT INTO t (n) VALUES (?)");
  if (ins.run("a").lastInsertRowid !== 1) throw new Error("run");
  const tx = db.transaction((names: string[]) => { for (const n of names) ins.run(n); });
  tx(["b", "c"]);
  if (db.prepare("SELECT COUNT(*) c FROM t").pluck().get() !== 3) throw new Error("tx/pluck");
  if (db.prepare("SELECT id, n FROM t WHERE id = ?").raw().get(1)[1] !== "a") throw new Error("raw");
  // lone array binds positionally (knex/Kysely convention)
  if (db.prepare("SELECT n FROM t WHERE id = ?").pluck().get([2]) !== "b") throw new Error("array-bind");
  db.close();
});
// process.stdin.setRawMode exists (interactive CLIs: inquirer/prompts/create-vite); no-ops off a TTY.
check("stdin.setRawMode", () => {
  if (typeof process.stdin.setRawMode !== "function") throw new Error("missing");
  process.stdin.setRawMode(true);
  if (process.stdin.isRaw !== true) throw new Error("isRaw");
  process.stdin.setRawMode(false);
  if (process.stdin.isRaw !== false) throw new Error("restore");
});
check("cp.spawnSync", () => { const cp = require("node:child_process"); if (typeof cp.spawnSync !== "function") throw new Error("no spawnSync"); const r = cp.spawnSync("echo", ["sy"]); if (r.stdout.toString().trim() !== "sy") throw new Error("got " + r.stdout); });
check("cp.exec maxBuffer/options", async () => { const cp = require("node:child_process"); await new Promise<void>((res, rej) => cp.exec("echo hi", { encoding: "utf8" }, (e: any, out: any) => e ? rej(e) : (out.trim() === "hi" ? res() : rej(new Error("got " + out))))); });

// fs.promises breadth (the hook flags "sync-backed")
check("fs.promises.mkdir/rmdir", async () => { const fsp = require("node:fs/promises"); const os = require("node:os"); const path = require("node:path"); const d = path.join(os.tmpdir(), "vxp-" + Math.random().toString(36).slice(2)); await fsp.mkdir(d); await fsp.rmdir(d); });
check("fs.promises.readdir", async () => { const fsp = require("node:fs/promises"); const os = require("node:os"); const e = await fsp.readdir(os.tmpdir()); if (!Array.isArray(e)) throw new Error("readdir"); });
check("fs.promises.stat isDirectory", async () => { const fsp = require("node:fs/promises"); const os = require("node:os"); const s = await fsp.stat(os.tmpdir()); if (!s.isDirectory()) throw new Error("stat"); });
check("fs.promises.cp/copyFile", async () => { const fsp = require("node:fs/promises"); await fsp.writeFile("/tmp/.vxcp1", "z"); await fsp.copyFile("/tmp/.vxcp1", "/tmp/.vxcp2"); const got = await fsp.readFile("/tmp/.vxcp2", "utf8"); await fsp.unlink("/tmp/.vxcp1"); await fsp.unlink("/tmp/.vxcp2"); if (got !== "z") throw new Error("cp"); });

// URL spec edge cases
check("URL special-scheme default port drop", () => { const u = new URL("https://ex.com:443/x"); if (u.port !== "" || u.host !== "ex.com") throw new Error("port=" + u.port); });
check("URL IPv6 host", () => { const u = new URL("http://[::1]:8080/"); if (u.hostname !== "[::1]" || u.port !== "8080") throw new Error("ipv6=" + u.hostname); });
check("URL relative resolution", () => { const u = new URL("../c", "https://ex.com/a/b/"); if (u.pathname !== "/a/c") throw new Error("rel=" + u.pathname); });
check("URL toJSON", () => { const u = new URL("https://ex.com/p"); if (typeof u.toJSON !== "function" || u.toJSON() !== u.href) throw new Error("toJSON"); });

// http breadth
check("http.Agent exists", () => { const http = require("node:http"); if (typeof http.Agent !== "function") throw new Error("no Agent"); if (!http.globalAgent) throw new Error("no globalAgent"); });
check("http.METHODS", () => { const http = require("node:http"); if (!Array.isArray(http.METHODS) || http.METHODS.indexOf("GET") === -1) throw new Error("methods"); });
check("net.Server getConnections", async () => {
  const net = require("node:net");
  await new Promise<void>((resolve, reject) => {
    const s = net.createServer(() => {}); s.on("error", reject);
    s.listen(0, () => { s.getConnections((e: any, n: any) => { s.close(); (typeof n === "number") ? resolve() : reject(new Error("conns")); }); });
  });
});

// process is a real EventEmitter now
check("process EventEmitter", () => {
  let got = 0;
  const f = (n: number) => { got = n; };
  process.on("vx-test", f);
  if (process.listenerCount("vx-test") !== 1) throw new Error("count");
  process.emit("vx-test", 7);
  if (got !== 7) throw new Error("emit");
  process.removeListener("vx-test", f);
  if (process.listenerCount("vx-test") !== 0) throw new Error("remove");
});
check("process.once", () => {
  let n = 0;
  process.once("vx-once", () => n++);
  process.emit("vx-once"); process.emit("vx-once");
  if (n !== 1) throw new Error("once fired " + n);
});

// child_process.fork with working IPC round-trip
check("fork IPC round-trip", async () => {
  const cp = require("node:child_process");
  await new Promise<void>((resolve, reject) => {
    const child = cp.fork("./examples/workers/fork-child.js");
    const to = setTimeout(() => { child.disconnect(); reject(new Error("fork IPC timeout")); }, 4000);
    child.on("message", (m: any) => {
      clearTimeout(to); child.disconnect();
      m && /got/.test(m.reply) ? resolve() : reject(new Error("bad reply " + JSON.stringify(m)));
    });
    child.on("error", (e: any) => { clearTimeout(to); reject(e); });
    setTimeout(() => child.send({ ping: 1 }), 150);
  });
});

// async fs mutation ops run off-thread now
check("fs.promises mutation chain", async () => {
  const fsp = require("node:fs/promises");
  const d = "/tmp/.vxmut-" + Math.random().toString(36).slice(2);
  await fsp.mkdir(d);
  await fsp.writeFile(d + "/a", "1");
  await fsp.rename(d + "/a", d + "/b");
  if (await fsp.readFile(d + "/b", "utf8") !== "1") throw new Error("rename");
  await fsp.rm(d, { recursive: true });
  if (require("node:fs").existsSync(d)) throw new Error("rm");
});

await new Promise((r) => setTimeout(r, 200));
let pass = 0, fail = 0;
for (const [name, ok, err] of results) { if (ok) pass++; else { fail++; console.log("FAIL " + name + ": " + err); } }
console.log("\n" + pass + " passed, " + fail + " failed of " + results.length);
process.exit(fail > 0 ? 1 : 0);

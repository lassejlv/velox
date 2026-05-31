// The `Velox` global — a batteries-included API with no imports needed.
//
//   cargo run -- examples/velox-global.ts

// Lazy node: builtins, reached straight off the global.
console.log("velox v" + Velox.version, "on", Velox.os.platform(), Velox.os.arch());
console.log("join:", Velox.path.join("/usr", "local", "../bin"));
console.log("query:", new Velox.url.URL("https://ex.com/?lang=ts&n=2").searchParams.get("lang"));

// File conveniences (sync + promise flavors).
const tmp = Velox.path.join(Velox.cwd(), "examples", ".velox-tmp.txt");
Velox.writeTextSync(tmp, "written by Velox.writeTextSync\n");
console.log("read back:", JSON.stringify(Velox.readTextSync(tmp)));
Velox.fs.unlinkSync(tmp);

// crypto, again no import.
console.log("uuid:", Velox.crypto.randomUUID());

// A web-style server (Bun/Deno-flavored): handler(request) -> Response.
const server = Velox.serve({
  port: 4000,
  onListen: ({ port }) => console.log("serving on http://localhost:" + port),
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/json") return Response.json({ ok: true, runtime: "velox" });
    return new Response("hello from Velox.serve " + pathname);
  },
});

// Hit it, print results, then exit.
await new Promise((r) => setTimeout(r, 150));
const text = await fetch("http://localhost:4000/world");
console.log("GET /world ->", text.status, JSON.stringify(await text.text()));
const json = await fetch("http://localhost:4000/json");
console.log("GET /json  ->", json.status, JSON.stringify(await json.json()));
server.close?.();
process.exit(0);

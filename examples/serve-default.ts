/// <reference path="../velox.d.ts" />

// Bun-style default export: velox automatically serves a default export that is
// a server object (`{ port?, fetch }`) or a web-framework app exposing `.fetch`
// (Hono, Elysia, …). No `Velox.serve(...)` / `.listen()` call needed.
//
//   velox examples/serve-default.ts
//   curl localhost:3000/        ->  Hello from a default export!
//   curl localhost:3000/api     ->  {"ok":true,"path":"/api"}

export default {
  port: 3000,
  fetch(req: Request) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response("Hello from a default export! 🚀");
    }
    return Response.json({ ok: true, path: url.pathname });
  },
};

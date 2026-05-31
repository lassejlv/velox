// Run with: cargo run -- examples/http-client.ts
//
// An HTTP client (http.get) and a server with keep-alive, on one event loop.

import http from "node:http";

// A tiny server that counts requests per connection.
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`hello ${req.url}`);
});

server.listen(3300, () => {
  // ...and a client that calls it.
  http
    .get("http://localhost:3300/world", (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => {
        console.log(`${res.statusCode} ${res.statusMessage} → ${body}`);
        console.log("content-type:", res.headers["content-type"]);
        server.close();
        process.exit(0);
      });
    })
    .on("error", (e: Error) => {
      console.error("request failed:", e.message);
      process.exit(1);
    });
});

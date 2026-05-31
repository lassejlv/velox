// Run with: cargo run -- examples/http-server.ts
// Then: curl http://localhost:3000/  and  curl -XPOST -d hi http://localhost:3000/echo

import http from "node:http";

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    if (req.url === "/echo") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`you sent: ${body}`);
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ method: req.method, url: req.url, hello: "from velox" }));
  });
});

server.listen(3000, () => {
  console.log("listening on http://localhost:3000");
});

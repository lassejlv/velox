// Run with: cargo run -- examples/https-server.ts
// Then: curl -k https://localhost:8443/   (self-signed cert)
import https from "node:https";
import crypto from "node:crypto";

const server = https.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ secure: true, url: req.url, nonce: crypto.randomUUID() }));
});

server.listen(8443, () => {
  console.log("HTTPS (self-signed) on https://localhost:8443  — try: curl -k https://localhost:8443/");
});

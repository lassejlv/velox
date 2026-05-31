// WebSockets (RFC 6455) — a server via the `ws` API, plus the browser-style
// global `WebSocket` client, with a full bidirectional round-trip. Also shows
// the Bun/Deno-style `Velox.serve({ websocket })` shorthand.
//
//   cargo run -- examples/websocket.ts

import { WebSocketServer } from "ws";
import http from "node:http";

const server = http.createServer();
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.send("welcome");
  ws.on("message", (data: any) => ws.send("echo: " + data.toString()));
});

server.listen(4600, () => {
  const ws = new WebSocket("ws://127.0.0.1:4600/");
  const received: string[] = [];
  ws.onopen = () => ws.send("hello");
  ws.onmessage = (ev: any) => {
    received.push(String(ev.data));
    if (received.length === 2) {
      console.log("client received:", JSON.stringify(received));
      console.log(
        "round-trip:",
        received[0] === "welcome" && received[1] === "echo: hello" ? "OK ✓" : "FAILED"
      );
      ws.close();
      wss.close();
      server.close();
      setTimeout(() => process.exit(0), 50);
    }
  };
});

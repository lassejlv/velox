// node:dgram — UDP datagram sockets on velox's kqueue reactor. An echo server
// and a client exchange a datagram (with rinfo: address/port/size).
//
//   cargo run -- examples/udp.ts

import dgram from "node:dgram";

const server = dgram.createSocket("udp4");
server.on("message", (msg, rinfo) => {
  console.log(`server received "${msg}" from ${rinfo.address}:${rinfo.port}`);
  server.send(`echo: ${msg}`, rinfo.port, rinfo.address);
});

server.on("listening", () => {
  const { port } = server.address();
  console.log("server listening on", port);

  const client = dgram.createSocket("udp4");
  client.on("message", (msg) => {
    console.log(`client received "${msg}"`);
    client.close();
    server.close();
    setTimeout(() => process.exit(0), 50);
  });
  client.send("hello over UDP", port, "127.0.0.1");
});

server.bind(0); // OS-assigned port

// Example HTTP server using Velox.serve
const server = Velox.serve({
  port: 3e3,
  hostname: "127.0.0.1",
  handler: (request) => {
    console.log(`${request.method} ${request.url}`);
    // Route handling
    if (request.url === "/") {
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<h1>Hello from Velox!</h1><p>Try /api/info or /api/echo</p>",
      };
    }
    if (request.url === "/api/info") {
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          runtime: "Velox",
          version: Velox.version,
          platform: Velox.platform,
          arch: Velox.arch,
          pid: Velox.pid,
        }),
      };
    }
    if (request.url === "/api/echo" && request.method === "POST") {
      // Echo back the request body
      const decoder = new TextDecoder();
      const body = request.body ? decoder.decode(request.body) : "";
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body,
        }),
      };
    }
    // 404 for unknown routes
    return {
      status: 404,
      headers: { "content-type": "text/plain" },
      body: "Not Found",
    };
  },
  onListen: (addr) => {
    console.log(`Server listening on http://${addr.hostname}:${addr.port}`);
    console.log("Press Ctrl+C to stop");
  },
});
console.log("Server started:", server.addr);

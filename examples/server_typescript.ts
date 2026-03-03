/// <reference path="velox.d.ts" />

// TypeScript example using Web Standard APIs

const server = Velox.serve({
  port: 3003,
  hostname: "127.0.0.1",

  handler: (request: Request): Response => {
    console.log(`${request.method} ${request.url}`);
    
    // Use Headers API
    const contentType = request.headers.get("content-type");
    console.log(`Content-Type: ${contentType}`);
    
    if (request.url === "/" || request.url === "") {
      return new Response("Hello from TypeScript!", {
        status: 200,
        headers: { "content-type": "text/plain" }
      });
    }
    
    if (request.url === "/json") {
      return Response.json({
        message: "TypeScript Response.json() works!",
        timestamp: Date.now()
      });
    }
    
    return new Response("Not Found", { status: 404 });
  },

  onListen: (addr) => {
    console.log(`TypeScript server at http://${addr.hostname}:${addr.port}`);
  }
});

console.log("Server started:", server.addr);

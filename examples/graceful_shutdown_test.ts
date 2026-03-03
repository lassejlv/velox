// Test graceful shutdown with Ctrl+C
// Run with: velox run examples/graceful_shutdown_test.ts
// Then press Ctrl+C to test graceful shutdown

console.log("Starting server...");
console.log("Press Ctrl+C to test graceful shutdown\n");

let requestCount = 0;

const server = Velox.serve({
  port: 3000,
  hostname: "127.0.0.1",
  
  handler: async (req: Request) => {
    requestCount++;
    const url = new URL(req.url);
    
    // Simulate some async work
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return new Response(
      JSON.stringify({
        message: "Hello from Velox!",
        path: url.pathname,
        requestNumber: requestCount,
      }),
      {
        headers: { "content-type": "application/json" },
      }
    );
  },
  
  onListen: ({ hostname, port }) => {
    console.log(`Server running at http://${hostname}:${port}`);
    console.log("\nTry these:");
    console.log(`  curl http://localhost:${port}/`);
    console.log(`  curl http://localhost:${port}/api/test`);
    console.log("\nPress Ctrl+C to shutdown gracefully...");
  },
  
  onError: (error) => {
    console.error("Server error:", error);
    return new Response("Internal Server Error", { status: 500 });
  },
});

console.log("\nServer object:", server.addr);

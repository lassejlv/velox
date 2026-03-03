// Test script for onError callback in Velox.serve
// Usage: velox run examples/server_onerror_test.js
// Then test with:
//   curl http://localhost:3001/sync-error
//   curl http://localhost:3001/async-error
//   curl http://localhost:3001/ok

let testsPassed = 0;
let testsFailed = 0;

const server = Velox.serve({
  port: 3001,
  hostname: "127.0.0.1",
  handler: async (request) => {
    const url = new URL(request.url, "http://localhost:3001");
    console.log(`${request.method} ${url.pathname}`);
    
    if (url.pathname === "/sync-error") {
      throw new Error("Sync error thrown!");
    }
    
    if (url.pathname === "/async-error") {
      // Simulate async operation that fails
      await new Promise((resolve) => setTimeout(resolve, 10));
      throw new Error("Async error thrown!");
    }
    
    if (url.pathname === "/ok") {
      return new Response("OK", { status: 200 });
    }
    
    return new Response("Not Found", { status: 404 });
  },
  onError: (error) => {
    console.log("onError callback invoked with:", error);
    return new Response(
      JSON.stringify({ 
        error: true, 
        message: error?.message || String(error),
        customHandler: true 
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  },
  onListen: async (addr) => {
    console.log(`Test server listening on http://${addr.hostname}:${addr.port}`);
    console.log("Running automated tests...\n");
    
    // Wait a bit for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));
    
    try {
      // Test 1: Normal response
      console.log("Test 1: Normal response (/ok)");
      const res1 = await fetch("http://localhost:3001/ok");
      const text1 = await res1.text();
      if (res1.status === 200 && text1 === "OK") {
        console.log("  PASS: Got expected 200 OK response\n");
        testsPassed++;
      } else {
        console.log(`  FAIL: Expected 200/OK, got ${res1.status}/${text1}\n`);
        testsFailed++;
      }
      
      // Test 2: Sync error with onError callback
      console.log("Test 2: Sync error with onError callback (/sync-error)");
      const res2 = await fetch("http://localhost:3001/sync-error");
      const json2 = await res2.json();
      if (res2.status === 500 && json2.customHandler === true) {
        console.log("  PASS: onError callback was invoked for sync error");
        console.log(`  Response: ${JSON.stringify(json2)}\n`);
        testsPassed++;
      } else {
        console.log(`  FAIL: onError callback not invoked correctly`);
        console.log(`  Status: ${res2.status}, Body: ${JSON.stringify(json2)}\n`);
        testsFailed++;
      }
      
      // Test 3: Async error with onError callback
      console.log("Test 3: Async error with onError callback (/async-error)");
      const res3 = await fetch("http://localhost:3001/async-error");
      const json3 = await res3.json();
      if (res3.status === 500 && json3.customHandler === true) {
        console.log("  PASS: onError callback was invoked for async error");
        console.log(`  Response: ${JSON.stringify(json3)}\n`);
        testsPassed++;
      } else {
        console.log(`  FAIL: onError callback not invoked correctly`);
        console.log(`  Status: ${res3.status}, Body: ${JSON.stringify(json3)}\n`);
        testsFailed++;
      }
      
    } catch (e) {
      console.log("Test error:", e);
      testsFailed++;
    }
    
    // Summary
    console.log("=".repeat(40));
    console.log(`Results: ${testsPassed} passed, ${testsFailed} failed`);
    console.log("=".repeat(40));
    
    // Shutdown server after tests
    console.log("\nShutting down server...");
    await server.shutdown();
    
    // Exit with appropriate code
    if (testsFailed > 0) {
      Velox.process.exit(1);
    }
  }
});

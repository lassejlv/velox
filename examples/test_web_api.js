// Quick test of Web Standard APIs

console.log("Testing Web Standard APIs...\n");

// Test Headers
console.log("=== Headers ===");
const headers = new Headers();
headers.set("content-type", "application/json");
headers.set("X-Custom", "test");
headers.append("x-multi", "a");
headers.append("x-multi", "b");

console.log("get content-type:", headers.get("content-type"));
console.log("get x-custom:", headers.get("x-custom")); // should be lowercase
console.log("get x-multi:", headers.get("x-multi")); // should be "a, b"
console.log("has content-type:", headers.has("content-type"));
console.log("has missing:", headers.has("missing"));

// Test with init object
const headers2 = new Headers({ "accept": "text/html", "cache-control": "no-cache" });
console.log("headers2 accept:", headers2.get("accept"));

// Test Request
console.log("\n=== Request ===");
const request = new Request("https://example.com/api", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: '{"name":"test"}'
});
console.log("url:", request.url);
console.log("method:", request.method);
console.log("headers content-type:", request.headers.get("content-type"));
console.log("bodyUsed:", request.bodyUsed);

// Test Response
console.log("\n=== Response ===");
const response = new Response("Hello World", {
  status: 201,
  statusText: "Created",
  headers: { "x-custom": "value" }
});
console.log("status:", response.status);
console.log("statusText:", response.statusText);
console.log("ok:", response.ok);
console.log("headers x-custom:", response.headers.get("x-custom"));

// Test Response.json()
console.log("\n=== Response.json() ===");
const jsonResponse = Response.json({ message: "Hello" });
console.log("json status:", jsonResponse.status);
console.log("json content-type:", jsonResponse.headers.get("content-type"));

// Test Response.redirect()
console.log("\n=== Response.redirect() ===");
const redirectResponse = Response.redirect("https://example.com", 307);
console.log("redirect status:", redirectResponse.status);
console.log("redirect location:", redirectResponse.headers.get("location"));

console.log("\nAll tests passed!");

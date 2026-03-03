// Example HTTP server using Web Standard Request/Response APIs
const server = Velox.serve({
	port: 3001,
	hostname: "127.0.0.1",
	handler: (request) => {
		// Log request info using Request API
		console.log(`${request.method} ${request.url}`);
		console.log(`Request is instance: ${request.constructor.name || "unknown"}`);
		// Use headers.get() method if available
		if (request.headers && typeof request.headers.get === "function") {
			console.log(`User-Agent: ${request.headers.get("user-agent") || "none"}`);
		}
		// Route handling using Response class
		if (request.url === "/" || request.url === "") {
			return new Response("<h1>Hello from Velox!</h1><p>Using Web Standard APIs</p>", {
				status: 200,
				headers: { "content-type": "text/html" }
			});
		}
		if (request.url === "/api/json") {
			// Use Response.json() static method
			return Response.json({
				message: "Hello from Response.json()!",
				runtime: "Velox",
				version: Velox.version
			});
		}
		if (request.url === "/api/headers") {
			// Test Headers class
			const headers = new Headers();
			headers.set("x-custom-header", "custom-value");
			headers.append("x-multi", "value1");
			headers.append("x-multi", "value2");
			return new Response(JSON.stringify({
				customHeader: headers.get("x-custom-header"),
				multiHeader: headers.get("x-multi"),
				hasCustom: headers.has("x-custom-header"),
				allKeys: [...headers.keys()]
			}), {
				status: 200,
				headers: { "content-type": "application/json" }
			});
		}
		if (request.url === "/api/redirect") {
			return Response.redirect("/", 302);
		}
		// 404 using Response class
		return new Response("Not Found", {
			status: 404,
			headers: { "content-type": "text/plain" }
		});
	},
	onListen: (addr) => {
		console.log(`Server listening on http://${addr.hostname}:${addr.port}`);
		console.log("Try these endpoints:");
		console.log("  /           - HTML response");
		console.log("  /api/json   - Response.json()");
		console.log("  /api/headers - Headers class test");
		console.log("  /api/redirect - Response.redirect()");
		console.log("Press Ctrl+C to stop");
	}
});

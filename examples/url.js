console.log("=== URL ===");
const url = new URL("https://user:pass@example.com:8080/path/to/file?foo=bar&baz=qux#section");
console.log("href:", url.href);
console.log("protocol:", url.protocol);
console.log("username:", url.username);
console.log("password:", url.password);
console.log("host:", url.host);
console.log("hostname:", url.hostname);
console.log("port:", url.port);
console.log("pathname:", url.pathname);
console.log("search:", url.search);
console.log("hash:", url.hash);
console.log("origin:", url.origin);
console.log("toString():", url.toString());
console.log("\n=== URL with base ===");
const relative = new URL("/api/users", "https://example.com/old/path");
console.log("relative URL:", relative.href);
const relative2 = new URL("other.html", "https://example.com/pages/index.html");
console.log("relative file:", relative2.href);
console.log("\n=== URLSearchParams ===");
const params = new URLSearchParams("foo=1&bar=2&foo=3");
console.log("get('foo'):", params.get("foo"));
console.log("getAll('foo'):", params.getAll("foo"));
console.log("has('bar'):", params.has("bar"));
console.log("has('baz'):", params.has("baz"));
params.append("new", "value");
console.log("after append:", params.toString());
params.set("foo", "single");
console.log("after set:", params.toString());
params.delete("bar");
console.log("after delete:", params.toString());
console.log("keys:", params.keys());
console.log("values:", params.values());
console.log("\n=== URLSearchParams from object ===");
const objParams = new URLSearchParams({
	name: "John",
	age: "30"
});
console.log("from object:", objParams.toString());
console.log("\n=== URL searchParams ===");
const url2 = new URL("https://api.example.com/search?q=hello&limit=10");
console.log("searchParams.get('q'):", url2.searchParams.get("q"));
console.log("searchParams.get('limit'):", url2.searchParams.get("limit"));
console.log("\n=== Special characters ===");
const encoded = new URLSearchParams({
	message: "Hello World!",
	emoji: "🚀"
});
console.log("encoded:", encoded.toString());

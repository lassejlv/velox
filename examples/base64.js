console.log("=== btoa (encode) ===");

console.log("btoa('Hello'):", btoa("Hello"));
console.log("btoa('Hello, World!'):", btoa("Hello, World!"));
console.log("btoa(''):", btoa(""));
console.log("btoa('a'):", btoa("a"));
console.log("btoa('ab'):", btoa("ab"));
console.log("btoa('abc'):", btoa("abc"));

console.log("\n=== atob (decode) ===");

console.log("atob('SGVsbG8='):", atob("SGVsbG8="));
console.log("atob('SGVsbG8sIFdvcmxkIQ=='):", atob("SGVsbG8sIFdvcmxkIQ=="));
console.log("atob(''):", atob(""));

console.log("\n=== Round-trip ===");

const original = "The quick brown fox jumps over the lazy dog";
const encoded = btoa(original);
const decoded = atob(encoded);
console.log("original:", original);
console.log("encoded:", encoded);
console.log("decoded:", decoded);
console.log("match:", original === decoded);

console.log("\n=== Binary data ===");

const binary = String.fromCharCode(0, 1, 2, 255, 254, 253);
const binaryEncoded = btoa(binary);
const binaryDecoded = atob(binaryEncoded);
console.log("binary encoded:", binaryEncoded);
console.log("binary round-trip match:", binary === binaryDecoded);

console.log("\n=== Error handling ===");

try {
  btoa("Hello 🌍");
} catch (e) {
  console.log("btoa with emoji error:", e.message);
}

try {
  atob("not valid!!!");
} catch (e) {
  console.log("atob invalid error:", e.message);
}

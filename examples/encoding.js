console.log("=== TextEncoder ===");

const encoder = new TextEncoder();
console.log("encoder.encoding:", encoder.encoding);

const bytes = encoder.encode("Hello, World!");
console.log("encode('Hello, World!'):", bytes);
console.log("length:", bytes.length);

const emoji = encoder.encode("Hello 🌍");
console.log("encode('Hello 🌍'):", emoji);
console.log("length:", emoji.length);

console.log("\n=== TextEncoder.encodeInto ===");

const dest = new Uint8Array(5);
const result = encoder.encodeInto("Hello", dest);
console.log("encodeInto('Hello', Uint8Array(5)):", result);
console.log("dest:", dest);

console.log("\n=== TextDecoder ===");

const decoder = new TextDecoder();
console.log("decoder.encoding:", decoder.encoding);

const decoded = decoder.decode(bytes);
console.log("decode(bytes):", decoded);

const decodedEmoji = decoder.decode(emoji);
console.log("decode(emoji bytes):", decodedEmoji);

console.log("\n=== Round-trip ===");

const original = "TypeScript 🚀 rocks!";
const encoded = encoder.encode(original);
const roundTrip = decoder.decode(encoded);
console.log("original:", original);
console.log("encoded length:", encoded.length);
console.log("round-trip:", roundTrip);
console.log("match:", original === roundTrip);

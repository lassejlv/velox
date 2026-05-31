// Run with: cargo run -- examples/crypto-stream.ts
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { Readable } from "node:stream";

const hash = createHash("sha256").update("velox").digest("hex");
console.log("sha256(velox):", hash.slice(0, 24), "...");
console.log("uuid:", randomUUID());

const data = "the quick brown fox ".repeat(50);
const gz = gzipSync(data);
console.log(`gzip: ${data.length} → ${gz.length} bytes; ok: ${gunzipSync(gz).toString() === data}`);

const collected: number[] = [];
for await (const n of Readable.from([1, 2, 3, 4, 5])) collected.push(n as number);
console.log("stream async-iter:", collected);

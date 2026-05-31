// Run with: cargo run -- examples/fs-demo.ts
//
// Node's fs + Buffer, on velox.

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { promises as fs } from "node:fs";

const dir = "/tmp/velox-fs-demo";
mkdirSync(dir, { recursive: true });

// Buffer is global (no import needed)
const bytes = Buffer.from("hello 🌍", "utf8");
console.log("bytes:", bytes.length, "| hex:", bytes.toString("hex"));

writeFileSync(`${dir}/greeting.txt`, bytes);
console.log("read back:", readFileSync(`${dir}/greeting.txt`, "utf8"));

// async via promises
await fs.writeFile(`${dir}/data.json`, JSON.stringify({ count: 3 }));
const data = JSON.parse(await fs.readFile(`${dir}/data.json`, "utf8"));
console.log("json:", data);

console.log("dir contents:", readdirSync(dir));

rmSync(dir, { recursive: true });
console.log("done");

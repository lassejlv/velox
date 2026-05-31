// node:worker_threads — real OS-thread workers, each with its own JSContext and
// event loop, exchanging messages as structured (JSON) clones.
//
//   cargo run -- examples/worker-threads.ts

import { Worker, isMainThread, threadId } from "node:worker_threads";

console.log("isMainThread:", isMainThread, "threadId:", threadId);

// 1) Fire-and-forget: a worker computes from workerData, posts once, and exits.
const compute = await new Promise<any>((resolve, reject) => {
  const w = new Worker("./examples/workers/double.js", { workerData: 21 });
  w.on("message", resolve);
  w.on("error", reject);
});
console.log("compute       :", JSON.stringify(compute));

// 2) Request/response: post a message, get a reply, then terminate the worker.
const echo = await new Promise<any>((resolve, reject) => {
  const w = new Worker("./examples/workers/echo.js");
  w.on("message", (m) => { w.terminate(); resolve(m); });
  w.on("error", reject);
  w.postMessage({ hello: "from main" });
});
console.log("request/reply :", JSON.stringify(echo));

// 3) Real parallelism: four CPU-bound workers run at the same time.
function fib(n: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const w = new Worker("./examples/workers/fib.js", { workerData: n });
    w.on("message", resolve);
    w.on("error", reject);
  });
}
const t0 = Date.now();
const results = await Promise.all([34, 34, 34, 34].map(fib));
console.log(
  "parallel fib  :",
  results.map((r: any) => r.result).join(", "),
  "in " + (Date.now() - t0) + "ms"
);
console.log("done");

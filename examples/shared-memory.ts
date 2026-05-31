// Cross-thread SharedArrayBuffer + Atomics — real shared memory between the main
// thread and worker threads. The backing bytes are owned by the runtime
// (src/shared.rs) and mapped into each JSContext as an ArrayBuffer over the same
// pointer, so Atomics operations are coherent across threads.
//
//   cargo run -- examples/shared-memory.ts

import { Worker } from "node:worker_threads";

// 1) A worker writes results into memory the main thread allocated.
const out = new SharedArrayBuffer(9 * 4);
const outView = new Int32Array(out);
await new Promise<void>((resolve, reject) => {
  const w = new Worker("./examples/workers/sab-worker.js", { workerData: { sab: out } });
  w.on("message", () => { w.terminate(); resolve(); });
  w.on("error", reject);
});
console.log("worker → main :", Array.from(outView.slice(0, 8)).join(","), "(written by the worker, read on main)");

// 2) Four workers concurrently Atomics.add into one shared counter — the total
//    is exact, proving the adds are atomic across threads (no lost updates).
const counter = new SharedArrayBuffer(4);
const counterView = new Int32Array(counter);
const WORKERS = 4, ITERATIONS = 50_000;
await Promise.all(
  Array.from({ length: WORKERS }, (_, id) =>
    new Promise<void>((resolve, reject) => {
      const w = new Worker("./examples/workers/sab-accumulate.js", {
        workerData: { sab: counter, id, iterations: ITERATIONS },
      });
      w.on("message", () => { w.terminate(); resolve(); });
      w.on("error", reject);
    })
  )
);
const total = Atomics.load(counterView, 0);
console.log(
  "parallel adds :", total,
  total === WORKERS * ITERATIONS ? "(exact — true shared atomic counter ✓)" : "(LOST UPDATES!)"
);
process.exit(0);

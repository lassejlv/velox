// Receives a SharedArrayBuffer via workerData, writes into it via Atomics,
// signals completion, and posts back a confirmation.
const { parentPort, workerData } = require('node:worker_threads');
const view = new Int32Array(workerData.sab);
// Worker writes results into shared memory the MAIN thread allocated.
for (let i = 0; i < 8; i++) Atomics.store(view, i, (i + 1) * 100);
Atomics.store(view, 8, 1); // done flag
parentPort.postMessage({ wrote: true });

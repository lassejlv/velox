// Multiple workers concurrently Atomics.add into the same shared counter.
const { parentPort, workerData } = require('node:worker_threads');
const counter = new Int32Array(workerData.sab);
for (let i = 0; i < workerData.iterations; i++) Atomics.add(counter, 0, 1);
parentPort.postMessage({ done: workerData.id });

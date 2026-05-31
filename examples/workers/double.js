// Fire-and-forget: compute from workerData, post once, exit (no listener).
const { parentPort, workerData } = require('node:worker_threads');
parentPort.postMessage({ input: workerData, doubled: workerData * 2 });

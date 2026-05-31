const { parentPort, workerData } = require('node:worker_threads');
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
parentPort.postMessage({ n: workerData, result: fib(workerData) });

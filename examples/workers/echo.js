// Message loop: respond to each message until terminated.
const { parentPort } = require('node:worker_threads');
parentPort.on('message', (msg) => {
  parentPort.postMessage({ echoed: msg, pid: 'worker' });
});

process.on('message', (msg) => {
  process.send({ reply: 'got ' + JSON.stringify(msg), pid: process.pid });
});

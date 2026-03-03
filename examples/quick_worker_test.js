// Quick worker test
const w = new Worker("./examples/simple_worker.js");
w.onmessage = (e) => {
  console.log("Main got:", e.data);
  w.terminate();
};
setTimeout(() => w.postMessage("Hello worker!"), 50);

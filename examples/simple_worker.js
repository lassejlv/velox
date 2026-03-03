// Simple worker test
self.onmessage = function(e) {
  console.log("Worker got:", e.data);
  postMessage("Hello back! You said: " + e.data);
};
console.log("Simple worker ready");

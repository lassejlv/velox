// Test Worker threads in Velox
// Run with: velox run examples/worker_test.ts

console.log("Main: Creating worker...");

// Create a worker
const worker = new Worker("./examples/worker_script.js");

// Handle messages from worker
worker.onmessage = function(event) {
  console.log("Main: Received from worker:", event.data);
  
  if (event.data.task === "result") {
    console.log("Main: Got result:", event.data.value);
    
    // Send exit signal after receiving result
    setTimeout(() => {
      console.log("Main: Terminating worker...");
      worker.terminate();
      console.log("Main: Done!");
    }, 100);
  }
};

// Handle worker errors
worker.onerror = function(event) {
  console.error("Main: Worker error:", event.message);
};

// Wait a moment for worker to initialize, then send task
setTimeout(() => {
  console.log("Main: Sending fibonacci task to worker...");
  worker.postMessage({ task: "fibonacci", data: 35 });
}, 100);

console.log("Main: Waiting for worker...");

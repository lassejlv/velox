// Worker script for CPU-intensive calculation
// This runs in a separate thread with its own V8 isolate

console.log("Worker: Starting...");

// Handle messages from main thread
self.onmessage = function(event) {
  console.log("Worker: Received message:", event.data);
  
  const { task, data } = event.data;
  
  if (task === "fibonacci") {
    // CPU-intensive Fibonacci calculation
    const result = fibonacci(data);
    postMessage({ task: "result", value: result });
  } else if (task === "prime") {
    // Find primes up to n
    const primes = findPrimes(data);
    postMessage({ task: "result", value: primes.length, primes: primes.slice(0, 10) });
  } else if (task === "exit") {
    console.log("Worker: Exiting...");
    // Worker will terminate naturally after this
  } else {
    postMessage({ task: "error", message: "Unknown task: " + task });
  }
};

function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

function findPrimes(max) {
  const primes = [];
  for (let n = 2; n <= max; n++) {
    let isPrime = true;
    for (let i = 2; i * i <= n; i++) {
      if (n % i === 0) {
        isPrime = false;
        break;
      }
    }
    if (isPrime) primes.push(n);
  }
  return primes;
}

console.log("Worker: Ready, waiting for messages...");

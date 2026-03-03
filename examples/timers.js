console.log("Starting timer test...");

setTimeout(() => {
  console.log("1. Fired after 100ms");
}, 100);

setTimeout(() => {
  console.log("2. Fired after 200ms");
}, 200);

const cancelId = setTimeout(() => {
  console.log("3. This should NOT print (cancelled)");
}, 150);

clearTimeout(cancelId);

setTimeout(() => {
  console.log("4. Fired after 50ms");
}, 50);

console.log("All timers scheduled");

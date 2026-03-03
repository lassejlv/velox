console.log("=== queueMicrotask ===");
console.log("1. Start");
queueMicrotask(() => {
	console.log("3. Microtask 1");
});
queueMicrotask(() => {
	console.log("4. Microtask 2");
});
console.log("2. End sync code");
// Microtasks should run before setTimeout
setTimeout(() => {
	console.log("6. setTimeout (macrotask)");
}, 0);
queueMicrotask(() => {
	console.log("5. Microtask 3 (queued after setTimeout scheduled)");
});
console.log("\n=== Microtask ordering with Promises ===");
Promise.resolve().then(() => {
	console.log("Promise.then 1");
});
queueMicrotask(() => {
	console.log("queueMicrotask 1");
});
Promise.resolve().then(() => {
	console.log("Promise.then 2");
});
queueMicrotask(() => {
	console.log("queueMicrotask 2");
});

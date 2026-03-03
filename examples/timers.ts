const delay = (ms: number): Promise<void> => {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
};
console.log("Starting async timer test...");
const start = Date.now();
await delay(100);
console.log(`After 100ms: ${Date.now() - start}ms elapsed`);
await delay(50);
console.log(`After another 50ms: ${Date.now() - start}ms elapsed`);
console.log("Done!");

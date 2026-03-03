// Simple test file for velox test command
console.log("Running basic tests...");
// Test 1: Basic arithmetic
const sum = 2 + 2;
if (sum !== 4) {
	throw new Error(`Expected 2 + 2 = 4, got ${sum}`);
}
console.log("  [PASS] Basic arithmetic");
// Test 2: String concatenation
const greeting = "Hello, " + "World!";
if (greeting !== "Hello, World!") {
	throw new Error(`Expected "Hello, World!", got "${greeting}"`);
}
console.log("  [PASS] String concatenation");
// Test 3: Array operations
const arr = [
	1,
	2,
	3
];
if (arr.length !== 3) {
	throw new Error(`Expected array length 3, got ${arr.length}`);
}
console.log("  [PASS] Array operations");
// Test 4: Object properties
const obj = {
	name: "test",
	value: 42
};
if (obj.name !== "test" || obj.value !== 42) {
	throw new Error("Object properties mismatch");
}
console.log("  [PASS] Object properties");
console.log("\nAll basic tests passed!");

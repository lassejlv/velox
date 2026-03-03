console.log("=== structuredClone ===");
// Primitives
console.log("null:", structuredClone(null));
console.log("undefined:", structuredClone(undefined));
console.log("number:", structuredClone(42));
console.log("string:", structuredClone("hello"));
console.log("boolean:", structuredClone(true));
// Objects
const obj = {
	a: 1,
	b: { c: 2 }
};
const clonedObj = structuredClone(obj);
console.log("\noriginal object:", obj);
console.log("cloned object:", clonedObj);
// Verify deep clone
obj.b.c = 999;
console.log("after modifying original.b.c to 999:");
console.log("  original.b.c:", obj.b.c);
console.log("  cloned.b.c:", clonedObj.b.c);
console.log("  is deep clone:", clonedObj.b.c === 2);
// Arrays
const arr = [
	1,
	[2, 3],
	{ x: 4 }
];
const clonedArr = structuredClone(arr);
console.log("\noriginal array:", arr);
console.log("cloned array:", clonedArr);
arr[1][0] = 999;
console.log("after modifying original[1][0] to 999:");
console.log("  cloned[1][0]:", clonedArr[1][0]);
console.log("  is deep clone:", clonedArr[1][0] === 2);
// Date
const date = new Date("2024-01-15T12:00:00Z");
const clonedDate = structuredClone(date);
console.log("\noriginal date:", date.toISOString());
console.log("cloned date:", clonedDate.toISOString());
console.log("dates equal:", date.getTime() === clonedDate.getTime());
console.log("not same reference:", date !== clonedDate);
// Uint8Array
const bytes = new Uint8Array([
	1,
	2,
	3,
	4,
	5
]);
const clonedBytes = structuredClone(bytes);
console.log("\noriginal Uint8Array:", bytes);
console.log("cloned Uint8Array:", clonedBytes);
bytes[0] = 255;
console.log("after modifying original[0] to 255:");
console.log("  cloned[0]:", clonedBytes[0]);
console.log("  is deep clone:", clonedBytes[0] === 1);
// Error cases
console.log("\n=== Error handling ===");
try {
	structuredClone({ fn: () => {} });
} catch (e) {
	console.log("function in object error:", e.message);
}

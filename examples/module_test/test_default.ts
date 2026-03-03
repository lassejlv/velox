// test_default.ts - Test default imports
import utils from "./utils";
console.log("=== Default Import Test ===\n");
console.log(`utils.add(5, 7) = ${utils.add(5, 7)}`);
console.log(`utils.subtract(20, 8) = ${utils.subtract(20, 8)}`);
console.log(`utils.PI = ${utils.PI}`);
console.log(`utils.VERSION = ${utils.VERSION}`);
console.log("\n=== Default import works! ===");

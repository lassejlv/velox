// main.ts - Entry point that imports from other modules
import { add, subtract, PI, VERSION } from "./utils";
import { greet, farewell } from "./greet";
console.log("=== Module System Test ===\n");
// Test named imports
console.log("Testing named imports from utils.ts:");
console.log(`  add(2, 3) = ${add(2, 3)}`);
console.log(`  subtract(10, 4) = ${subtract(10, 4)}`);
console.log(`  PI = ${PI}`);
console.log(`  VERSION = ${VERSION}`);
console.log("\nTesting named imports from greet.ts:");
console.log(`  ${greet("World")}`);
console.log(`  ${farewell("World")}`);
console.log("\n=== All tests passed! ===");

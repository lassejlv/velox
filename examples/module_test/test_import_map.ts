// test_import_map.ts - Test import map functionality

// These use bare specifiers that should be resolved via import_map.json
import { add, PI } from "utils";
import { greet } from "greet";
import { multiply, divide } from "@mylib/math";

console.log("=== Import Map Test ===\n");

console.log("Using bare import 'utils':");
console.log(`  add(100, 200) = ${add(100, 200)}`);
console.log(`  PI = ${PI}`);

console.log("\nUsing bare import 'greet':");
console.log(`  ${greet("Import Map")}`);

console.log("\nUsing scoped import '@mylib/math':");
console.log(`  multiply(7, 8) = ${multiply(7, 8)}`);
console.log(`  divide(100, 4) = ${divide(100, 4)}`);

console.log("\n=== Import map test passed! ===");

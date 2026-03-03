// test_dynamic_import2.ts - Test dynamic import() with explicit promise handling

console.log("=== Dynamic import() Test ===\n");

console.log("Loading utils module dynamically...");

import("./utils").then((utils) => {
  console.log("\nDynamic import successful!");
  console.log(`  utils.add(10, 20) = ${utils.add(10, 20)}`);
  console.log(`  utils.PI = ${utils.PI}`);
  console.log(`  utils.default.VERSION = ${utils.default.VERSION}`);
  
  return import("./greet");
}).then((greet) => {
  console.log(`\n  ${greet.greet("Dynamic Import")}`);
  console.log("\n=== Dynamic import test passed! ===");
}).catch((e) => {
  console.error("Dynamic import failed:", e.message || e.stack || e);
});

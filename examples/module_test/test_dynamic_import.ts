// test_dynamic_import.ts - Test dynamic import()

console.log("=== Dynamic import() Test ===\n");

async function testDynamicImport() {
  console.log("Loading utils module dynamically...");
  
  const utils = await import("./utils");
  
  console.log("\nDynamic import successful!");
  console.log(`  utils.add(10, 20) = ${utils.add(10, 20)}`);
  console.log(`  utils.PI = ${utils.PI}`);
  console.log(`  utils.default.VERSION = ${utils.default.VERSION}`);
  
  // Test importing greet module
  const greet = await import("./greet");
  console.log(`\n  ${greet.greet("Dynamic Import")}`);
  
  console.log("\n=== Dynamic import test passed! ===");
}

testDynamicImport().catch(e => {
  console.error("Dynamic import failed:", e);
});

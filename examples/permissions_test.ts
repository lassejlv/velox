// Permissions Test
// Tests the Velox permissions system
export {}
//
// Run with different permission flags to test:
//
// 1. No flags (permissions disabled - everything allowed):
//    velox run examples/permissions_test.ts
//
// 2. Allow all:
//    velox run --allow-all examples/permissions_test.ts
//    velox run -A examples/permissions_test.ts
//
// 3. Specific permissions (should fail operations without matching permission):
//    velox run --allow-read=. examples/permissions_test.ts
//    velox run --allow-read=/tmp --allow-write=/tmp examples/permissions_test.ts
//
// 4. Test permission denial (should fail):
//    velox run --allow-read=/nonexistent examples/permissions_test.ts

console.log("=== Velox Permissions Test ===\n");

// Helper function to test an operation
async function testOperation(
  name: string,
  operation: () => Promise<any> | any
): Promise<boolean> {
  try {
    await operation();
    console.log(`[PASS] ${name}`);
    return true;
  } catch (e: any) {
    // Handle both Error objects and string exceptions
    const msg = e?.message || String(e);
    if (msg.includes("Permission denied") || msg.includes("Requires")) {
      console.log(`[DENIED] ${name}: ${msg}`);
    } else {
      console.log(`[ERROR] ${name}: ${msg}`);
    }
    return false;
  }
}

// Test read permission
console.log("--- File System Read ---");
await testOperation("Velox.fs.existsSync('./Cargo.toml')", () => {
  return Velox.fs.existsSync("./Cargo.toml");
});

await testOperation("Velox.fs.readTextFileSync('./Cargo.toml')", () => {
  const content = Velox.fs.readTextFileSync("./Cargo.toml");
  return content.substring(0, 50);
});

await testOperation("Velox.fs.readTextFile('./Cargo.toml')", async () => {
  const content = await Velox.fs.readTextFile("./Cargo.toml");
  return content.substring(0, 50);
});

await testOperation("Velox.fs.readDirSync('.')", () => {
  const entries = Velox.fs.readDirSync(".");
  return entries.length;
});

await testOperation("Velox.fs.statSync('./Cargo.toml')", () => {
  return Velox.fs.statSync("./Cargo.toml");
});

// Test write permission
console.log("\n--- File System Write ---");
const testFile = "/tmp/velox_permission_test.txt";

await testOperation(`Velox.fs.writeTextFileSync('${testFile}')`, () => {
  Velox.fs.writeTextFileSync(testFile, "Hello from permissions test!");
});

await testOperation(`Velox.fs.appendFile('${testFile}')`, async () => {
  await Velox.fs.appendFile(testFile, "\nAppended line");
});

await testOperation(`Velox.fs.remove('${testFile}')`, async () => {
  await Velox.fs.remove(testFile);
});

// Test network permission (fetch)
console.log("\n--- Network (fetch) ---");
await testOperation("fetch('https://httpbin.org/get')", async () => {
  const response = await fetch("https://httpbin.org/get");
  return response.status;
});

await testOperation("fetch('https://example.com')", async () => {
  const response = await fetch("https://example.com");
  return response.status;
});

// Test run permission (exec)
console.log("\n--- Run (exec) ---");
await testOperation("Velox.execSync('echo hello')", () => {
  const result = Velox.execSync("echo hello");
  return result.stdout.trim();
});

await testOperation("Velox.exec('ls -la')", async () => {
  const result = await Velox.exec("ls -la");
  return result.success;
});

// Test env permission
console.log("\n--- Environment ---");
await testOperation("Velox.env.get('HOME')", () => {
  return Velox.env.get("HOME");
});

await testOperation("Velox.env.set('TEST_VAR', 'test_value')", () => {
  Velox.env.set("TEST_VAR", "test_value");
  return Velox.env.get("TEST_VAR");
});

await testOperation("Velox.env.delete('TEST_VAR')", () => {
  Velox.env.delete("TEST_VAR");
});

await testOperation("Velox.env.toObject()", () => {
  const env = Velox.env.toObject();
  return Object.keys(env).length;
});

console.log("\n=== Permissions Test Complete ===");

// Smoke test: circular ESM named imports must be live (resolve at call time),
// like real ESM — not snapshotted to undefined. Exercised heavily by kysely.
// Run: velox examples/circular-imports.ts
import { caller } from "./fixtures/circular-a.ts";
import { viaCaller } from "./fixtures/circular-b.ts";

if (caller() !== 11 || viaCaller() !== 11) {
  console.log("FAIL: circular imports not live:", caller(), viaCaller());
  process.exit(1);
}
console.log("✓ circular ESM named imports resolve (both directions)");

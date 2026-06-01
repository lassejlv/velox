// Smoke test for ESM live-binding exports (TS enums). Run: velox examples/ts-enum-export.ts
import { Color } from "./fixtures/ts-enum.ts";

if (!Color || Color.Red !== "red" || Color.Green !== "green") {
  console.log("FAIL: enum export not live-bound:", Color);
  process.exit(1);
}
console.log("✓ ESM live-binding export (TS enum) works:", Color.Red, Color.Green);

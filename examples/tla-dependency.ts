// Smoke test: importing a module whose exports are set after a top-level await
// must see fully-populated values (tempy ← temp-dir relies on this). Run:
// velox examples/tla-dependency.ts
import dep, { named } from "./fixtures/tla-dep.ts";

if (dep !== "resolved-after-await" || named !== 123) {
  console.log("FAIL: top-level-await dependency exports not populated:", { dep, named });
  process.exit(1);
}
console.log("✓ top-level-await dependency exports resolve before import use");

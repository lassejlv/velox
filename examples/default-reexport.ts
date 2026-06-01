// Smoke test: `export {default as X} from 'cjs-module'` must follow CJS-interop
// (the default is the whole module.exports). Run: velox examples/default-reexport.ts
import { proc } from "./fixtures/default-reexport.ts";

if (!proc || typeof proc.cwd !== "function") {
  console.log("FAIL: default re-export of node:process not interop'd:", proc);
  process.exit(1);
}
console.log("✓ default re-export CJS interop works:", typeof proc.cwd());

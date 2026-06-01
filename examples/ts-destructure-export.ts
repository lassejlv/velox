import { alpha, renamedBeta, first, others } from "./fixtures/ts-destructure.ts";
if (alpha !== 1 || renamedBeta !== 2 || first !== 10 || JSON.stringify(others) !== "[20,30]") {
  console.log("FAIL:", { alpha, renamedBeta, first, others });
  process.exit(1);
}
console.log("✓ destructuring export declarations work");

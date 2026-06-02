// Half of a circular ESM pair: imports from b, which imports back from a.
// Functions are hoisted, so both directions must resolve at call time.
import { helper } from "./circular-b.ts";
export function caller() { return helper() + 1; }

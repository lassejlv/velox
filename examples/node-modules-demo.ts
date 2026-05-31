// Demonstrates node_modules resolution for bare specifiers:
//   - `greet`            -> exports "." conditional ("import" target), ESM .js
//   - `@acme/math`       -> scoped package via `main`, TS-authored
//   - `@acme/math/double`-> scoped subpath import, TS-authored
import { greet } from "greet";
import { add } from "@acme/math";
import { double } from "@acme/math/double";

console.log(greet("velox"));
console.log("add(2, 3) =", add(2, 3));
console.log("double(21) =", double(21));

// CommonJS node_modules packages — velox bundles `require()` graphs the same way
// it bundles `import`, so real CJS packages run unmodified. Demonstrates:
//   - `module.exports` / `exports.x` packages
//   - relative `require('./helper')` + directory `require('./sub')`
//   - JSON `require('./data.json')`
//   - conditional `exports` (the "require" condition)
//   - consuming a CJS module via ESM default import, ESM named import, and require()
//
//   cargo run -- examples/commonjs-demo.ts

import cjs from "cjs-demo"; // ESM default import of a CJS module
import { greet, version } from "cjs-demo"; // ESM named bindings off module.exports
import cond from "cond-pkg"; // conditional-exports CJS package

console.log("default import :", cjs.greet("velox"), cjs.version, "sub=" + cjs.subValue);
console.log("named import   :", greet("world"), version);
console.log("conditional cjs:", cond.add(2, 40), cond.label);

const required = require("cjs-demo"); // classic CommonJS require()
console.log("require()      :", required.greet("again"), required.version);

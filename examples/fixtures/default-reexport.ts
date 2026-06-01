// Re-exports the default of a CommonJS builtin under a new name. The default of
// a plain CJS module (`module.exports = process`) is the whole exports object —
// the bundler must apply that interop here, not grab a literal `.default`.
// (This is exactly what vfile's `export {default as minproc} from 'node:process'`
// relies on; without the interop, `minproc` would be undefined.)
export { default as proc } from "node:process";

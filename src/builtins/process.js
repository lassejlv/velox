// node:process — the process object is set up globally in the GLOBALS_PRELUDE;
// the module just re-exports it.
module.exports = globalThis.process;

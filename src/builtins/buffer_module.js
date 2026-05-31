// node:buffer — re-exports the global Buffer (installed by the buffer prelude).
module.exports = {
  Buffer: globalThis.Buffer,
  constants: { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffff },
  kMaxLength: 0x7fffffff,
  kStringMaxLength: 0x1fffffff,
  INSPECT_MAX_BYTES: 50,
  SlowBuffer: globalThis.Buffer,
  isUtf8: function () { return true; },
};
module.exports.default = module.exports;

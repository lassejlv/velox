// A dependency that sets its exports *after* a top-level await (the temp-dir /
// ESM-utility pattern). A synchronous importer must still see the populated
// values — the bundler pre-initializes top-level-await modules before the entry.
const value = await Promise.resolve("resolved-after-await");
export default value;
export const named = await Promise.resolve(123);

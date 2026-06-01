// A sample benchmark file for velox's built-in runner. Run it with:
//   velox bench examples/example.bench.ts
//
// `bench`, `describe`/`group`, and the before*/after* hooks are globals — no
// import is required (you may also `import { bench } from "velox-bench"`).

describe("string building", () => {
  bench("concatenation", () => {
    let s = "";
    for (let i = 0; i < 100; i++) s += i;
    return s;
  });

  bench("array join", () => {
    const parts: string[] = [];
    for (let i = 0; i < 100; i++) parts.push("" + i);
    return parts.join("");
  });
});

bench("JSON round-trip", () => {
  const obj = { id: 1, name: "velox", tags: ["a", "b", "c"], nested: { ok: true } };
  return JSON.parse(JSON.stringify(obj));
});

bench("async resolve", async () => {
  await Promise.resolve(42);
});

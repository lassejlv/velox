// A sample test file for velox's built-in runner. Run from this directory with:
//   velox test
//
// describe / it / test / expect and the before*/after* hooks are globals — no
// import is required (you may also `import { describe, it, expect } from
// "velox-test"`).

describe("velox-test", () => {
  it("does basic assertions", () => {
    expect(2 + 2).toBe(4);
    expect("velox").toHaveLength(5);
    expect([1, 2, 3]).toContain(2);
    expect({ a: 1, b: 2 }).toMatchObject({ a: 1 });
  });

  it("compares deeply", () => {
    expect({ nested: [1, { x: 2 }] }).toEqual({ nested: [1, { x: 2 }] });
    expect({ id: 7 }).toEqual({ id: expect.any(Number) });
  });

  it("handles async + matchers", async () => {
    await expect(Promise.resolve("ok")).resolves.toBe("ok");
    await expect(Promise.reject(new Error("boom"))).rejects.toThrow("boom");
  });

  it("negates", () => {
    expect(5).not.toBe(6);
    expect([1, 2]).not.toContain(9);
  });

  describe("hooks + nesting", () => {
    let n = 0;
    beforeEach(() => { n += 1; });
    it("runs beforeEach (1)", () => { expect(n).toBe(1); });
    it("runs beforeEach (2)", () => { expect(n).toBe(2); });
  });

  it.skip("is skipped", () => { expect(true).toBe(false); });
  it.todo("is a reminder to write later");
});

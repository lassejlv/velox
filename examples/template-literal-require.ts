// Smoke test: the bundler must follow `require(`./x`)` / `import(`./x`)` written
// with no-substitution template literals (minified output, e.g. remeda) the same
// way it follows quoted-string specifiers. Run: velox examples/template-literal-require.ts
const dep = require(`./fixtures/tmpl-require-dep.cjs`);
const dyn = await import(`./fixtures/tmpl-require-dep.cjs`);

if (dep.answer !== 42 || ((dyn as any).default ?? dyn).answer !== 42) {
  console.log("FAIL: template-literal require/import not bundled:", dep, dyn);
  process.exit(1);
}
console.log("✓ template-literal require + dynamic import bundle correctly");

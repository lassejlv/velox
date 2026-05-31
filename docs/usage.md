# Usage

[← Getting started](getting-started.md) · [Docs home](README.md) · **Usage** · [Next: Examples →](examples.md)

## Run a file

```sh
velox app.ts
velox app.tsx
velox script.js
```

Relative `import`s and `node_modules` are resolved and bundled automatically.

## CLI flags

| Flag | Description |
|------|-------------|
| *(no args)* | Start the REPL |
| `FILE` | Run a script |
| `-e`, `--eval CODE` | Evaluate a string and exit (staged as a hidden `.ts` file in cwd for imports) |
| `-w`, `--watch` | Re-run when the entry or any bundled import changes |
| `--env-file PATH` | Load `KEY=VALUE` pairs into `process.env` before running |

Examples:

```sh
velox -e 'console.log(process.env.HOME)'
velox --watch src/main.ts
velox --env-file .env app.ts
```

## REPL

```sh
velox
```

| Command | Action |
|---------|--------|
| `.help` | Show commands |
| `.clear` | Clear screen |
| `.exit` | Quit (or Ctrl-D) |

**Caveats:** no top-level `await` in the REPL; `let`/`const` don't persist between lines — use `var` or `globalThis`. See [Limitations → REPL](limitations.md#repl).

## Development commands

```sh
cargo run                              # REPL
cargo run -- examples/async.ts         # run an example
cargo build / cargo test / cargo clippy
make fmt / make test / make release
```

## TypeScript types

Built-in `Velox` API types live in [`velox.d.ts`](../velox.d.ts):

```ts
/// <reference path="./velox.d.ts" />
Velox.serve({ port: 3000, fetch() { return new Response("ok"); } });
```

---

[← Getting started](getting-started.md) · [Next: Examples →](examples.md)

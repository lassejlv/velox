# Usage

[← Getting started](getting-started.md) · [Docs home](README.md) · **Usage** · [Next: Examples →](examples.md)

## Start a project

```sh
velox init            # scaffold in the current directory
velox init my-app     # scaffold in ./my-app
```

`init` writes `src/main.ts` (a starter HTTP server), `package.json` (with
`dev`/`start` scripts), `tsconfig.json`, a copy of `velox.d.ts`, and
`.gitignore`, then runs `npm install -D @types/node` so `node:*` imports
type-check in your editor. Existing files are never overwritten, so it's safe to
re-run. Pass `--no-install` to skip the npm step.

## Manage packages

velox ships a package manager that talks to the npm registry directly (no npm
needed) and installs into `node_modules`:

```sh
velox add express              # add to dependencies + install
velox add -D vitest            # add to devDependencies
velox add lodash@^4            # a version or range (default: latest, pinned ^)
velox install                  # install everything in package.json
velox remove express           # uninstall
```

It resolves the transitive dependency graph (caret/tilde/x-range/comparator
semver plus dist-tags), verifies each tarball's `sha512` (or `sha1`) integrity,
writes `velox-lock.json`, and keeps `package.json` tidy. Point it at a private
registry with `$VELOX_REGISTRY` (or `$npm_config_registry`). Install scripts are
**not** run.

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
| `init [DIR]` | Scaffold a new project (`--no-install` to skip npm) |
| `add [-D] <pkg>…` | Add packages and install them |
| `install` | Install dependencies from package.json |
| `remove <pkg>…` | Uninstall packages |
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

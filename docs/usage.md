# Usage

[← Getting started](getting-started.md) · [Docs home](README.md) · **Usage** · [Next: Examples →](examples.md)

## Start a project

```sh
velox init            # scaffold in the current directory
velox init my-app     # scaffold in ./my-app
```

`init` writes `src/main.ts` (a starter HTTP server), `package.json` (with
`dev`/`start` scripts), `tsconfig.json`, a copy of `velox.d.ts`, and
`.gitignore`, then installs `@types/node` (via velox's own package manager) so
`node:*` imports type-check in your editor. Existing files are never
overwritten, so it's safe to re-run. Pass `--no-install` to skip the install.

## Manage packages

velox ships a package manager that talks to the npm registry directly (no npm
needed) and installs into `node_modules`:

```sh
velox add express              # add to dependencies + install
velox add -D vitest            # add to devDependencies
velox add lodash@^4            # a version or range (default: latest, pinned ^)
velox install                  # install (from velox.lock if present, else resolve)
velox remove express           # uninstall (updates velox.lock)
velox update [--latest] [pkg]  # upgrade in-range (or bump ranges with --latest)
velox outdated                 # list deps with a newer version available
velox x cowsay "hi"            # run a package's executable (npx-style)
```

It resolves the transitive dependency graph (caret/tilde/x-range/comparator
semver plus dist-tags), verifies each tarball's `sha512` (or `sha1`) integrity,
and keeps `package.json` tidy. Point it at a private registry with
`$VELOX_REGISTRY` (or `$npm_config_registry`). Install scripts are **not** run.

**Parallel + cached.** Registry metadata and tarball downloads both fan out
across worker threads. Both go into a global cache (`~/.velox/cache`, override
with `$VELOX_CACHE`) shared by every project: tarballs are content-cached
forever (fetched at most once machine-wide), and package metadata is cached with
a freshness TTL (default 10 min, `$VELOX_METADATA_TTL` seconds to change, `0` to
disable). So re-resolving the same graph — every `add`/`install` without a
lockfile — is near-instant on repeat instead of dozens of network round-trips,
and installs work offline from cache.

**Lockfile.** Resolution is pinned to `velox.lock` (YAML). When it exists,
`velox install` installs exactly those versions — no resolution, fully
reproducible — while `add`/`remove`/`update` keep it in sync. Commit it.

**Workspaces.** Monorepos are supported via npm's `"workspaces"` glob array in
the root `package.json` **or** a `pnpm-workspace.yaml` with a `packages:` list
(e.g. `packages/*`). `velox install` (run anywhere inside the workspace)
resolves every member's external dependencies together, hoists them into the
root `node_modules`, and symlinks each member there so cross-package imports
resolve. A `workspace:*` (or member-named) dependency links the local package
instead of fetching from the registry.

**`velox x`** (npx-style) downloads a package and its dependencies into the
cache and runs its executable with velox as the runtime — `velox x <pkg>[@ver]
[args…]`. The store is cached, so the second run is instant.

**`velox outdated` / `velox update`.** `outdated` prints a Current/Wanted/Latest
table of direct dependencies behind the registry. `update` re-resolves to the
newest version inside each `package.json` range (and rewrites the lockfile);
`update --latest [pkg…]` first bumps the targeted ranges to `^<latest>`.

## Compile to a standalone executable

```sh
velox build app.ts                 # → ./app  (self-contained, ~7 MB)
velox build src/cli.ts --out mycli # → ./mycli
./app arg1 arg2                    # runs with no velox install needed
```

`velox build` bundles the entry and all its dependencies, then appends the
bundle to a copy of velox to produce a single self-contained, **JIT-enabled**
executable — no velox, Node, or `node_modules` required at runtime. The script's
args arrive as `process.argv[1..]`, and a Bun-style default-export server is
auto-served. (Strict `codesign -v` notes the appended bundle as trailing data,
but the binary runs with full JIT — the same as Bun/Deno compiled output.)
macOS arm64 only.

## Run scripts

```sh
velox run               # list package.json scripts
velox run dev           # run the "dev" script
velox run test -- -w    # pass args through after --
```

Runs the named `package.json` script through `sh`, with `node_modules/.bin` and
velox's own directory prepended to `PATH` (so a script that calls `velox`
resolves to the running binary). `pre<name>` / `post<name>` hooks run too.

## Run a file

```sh
velox app.ts
velox app.tsx
velox script.js
```

Relative `import`s and `node_modules` are resolved and bundled automatically.

The bundle is **cached** between runs (under `~/.velox/cache/bundles`, or
`$VELOX_CACHE`): a repeat `velox app.ts` whose source files are all unchanged
skips re-resolving and re-transpiling the whole import graph and just evaluates
the cached output — noticeably faster cold starts for dependency-heavy apps
(e.g. a ~100-dependency app drops ~40%). The cache invalidates automatically
when any source file (by mtime/size) or the velox binary changes. Set
`$VELOX_NO_CACHE=1` to bypass it.

### Default-export server (Bun-style)

If a script's `export default` is a server object (`{ port?, fetch }`) or a web
app exposing `.fetch` (Hono, Elysia, …), velox serves it automatically — no
`Velox.serve(...)` or `.listen()` needed:

```ts
// app.ts  →  velox app.ts  →  serving on http://localhost:3000
import { Hono } from "hono";
const app = new Hono();
app.get("/", (c) => c.text("hi"));
export default app;
```

```ts
// or the plain object form
export default {
  port: 3000,
  fetch(req) { return new Response("hi"); },
};
```

See [`examples/serve-default.ts`](../examples/serve-default.ts). A default export
without a `fetch` method (or no default export) starts no server.

### Environment files

velox auto-loads conventional `.env` files from the current directory before
running a file/eval/REPL — no flag needed:

- `.env`
- `.env.local`
- `.env.<NODE_ENV>` and `.env.<NODE_ENV>.local` (only when `NODE_ENV` is set)

More specific files win (e.g. `.env.production` over `.env`), but a variable
already set in the real shell environment is **never** overwritten, and an
explicit `--env-file` overrides the auto-loaded files. Values support `#`
comments, `export KEY=…` prefixes, and single/double-quoted strings. `.env.local`
/ `.env.*.local` are gitignored by `velox init`.

## CLI flags

| Flag | Description |
|------|-------------|
| *(no args)* | Start the REPL |
| `init [DIR]` | Scaffold a new project (`--no-install` to skip @types/node) |
| `add [-D] <pkg>…` | Add packages and install them |
| `install` | Install dependencies (workspace-aware) |
| `remove <pkg>…` | Uninstall packages |
| `update [--latest] [pkg…]` | Upgrade dependencies |
| `outdated` | List dependencies with newer versions |
| `x <pkg> [args…]` | Run a package's executable (npx-style) |
| `build <entry> [--out N]` | Compile to a standalone executable |
| `run [script]` | Run a package.json script |
| `FILE [args…]` | Run a script (args go to `process.argv`) |
| `-e`, `--eval CODE` | Evaluate a string and exit (staged as a hidden `.ts` file in cwd for imports) |
| `-w`, `--watch` | Re-run when the entry or any bundled import changes |
| `--env-file PATH` | Load `KEY=VALUE` pairs into `process.env` (overrides auto-loaded `.env`) |

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

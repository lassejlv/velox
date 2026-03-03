# Velox

A fast JavaScript/TypeScript runtime built with V8.

## Install

```bash
cargo build --release
```

## Usage

```bash
velox run script.js
velox run script.ts
velox add hono
velox install
velox x cowsay hello
```

## Example

```typescript
const res = await fetch("https://api.example.com/data");
const data = res.json();
console.table(data);
```

## Features

- V8 JavaScript engine
- TypeScript support (via oxc)
- Async/await with event loop
- `fetch()` API
- `console.log/error/warn/info/debug/table`
- `velox add <pkg>` package installation

## License

MIT

# Velox - JavaScript Runtime

A minimal JavaScript runtime built with rusty_v8.

## Documentation Sources

- **rusty_v8 docs**: Use Context7 with library ID `/denoland/rusty_v8`
- **oxc docs**: Use Context7 with library ID `/oxc-project/oxc`
- **crates.io**: https://crates.io/crates/rusty_v8
- **GitHub**: https://github.com/denoland/rusty_v8

## Project Structure

```
src/
├── main.rs          # CLI entry point (velox run <file>)
├── runtime.rs       # V8 isolate, context, script execution
├── transpiler.rs    # TypeScript → JavaScript (oxc)
├── event_loop.rs    # Async task queue for Promises
├── colors.rs        # ANSI escape codes for terminal output
└── builtins/
    ├── mod.rs       # Registers all builtins on global object
    ├── console.rs   # console.log/error/warn/info/debug
    └── fetch.rs     # Promise-based HTTP client
```

## rusty_v8 Patterns

### Initialization (once per process)
```rust
use rusty_v8 as v8;
use std::sync::Once;

static V8_INIT: Once = Once::new();

V8_INIT.call_once(|| {
    let platform = v8::new_default_platform(0, false).make_shared();
    v8::V8::initialize_platform(platform);
    v8::V8::initialize();
});
```

### Creating Isolate and Context
```rust
let isolate = &mut v8::Isolate::new(v8::CreateParams::default());
let handle_scope = &mut v8::HandleScope::new(isolate);
let context = v8::Context::new(handle_scope);
let scope = &mut v8::ContextScope::new(handle_scope, context);
```

### Registering Global Functions
```rust
fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let func = v8::Function::new(scope, my_callback).unwrap();
    let key = v8::String::new(scope, "myFunction").unwrap();
    global.set(scope, key.into(), func.into());
}

fn my_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let arg = args.get(0).to_rust_string_lossy(scope);
    let result = v8::String::new(scope, "hello").unwrap();
    rv.set(result.into());
}
```

### Error Handling with TryCatch
```rust
let tc_scope = &mut v8::TryCatch::new(scope);

let script = match v8::Script::compile(tc_scope, code, Some(&origin)) {
    Some(script) => script,
    None => {
        if let Some(exception) = tc_scope.exception() {
            let msg = exception.to_string(tc_scope).unwrap();
            // handle error
        }
        return;
    }
};
```

### Creating Promises
```rust
let resolver = v8::PromiseResolver::new(scope).unwrap();
let promise = resolver.get_promise(scope);

// Later, resolve or reject:
resolver.resolve(scope, value.into());
// or
resolver.reject(scope, error);
```

### Script Origin (for error locations)
```rust
let name = v8::String::new(scope, filename).unwrap();
let origin = v8::ScriptOrigin::new(
    scope,
    name.into(),  // resource_name
    0,            // line_offset
    0,            // column_offset
    false,        // is_shared_cross_origin
    0,            // script_id
    name.into(),  // source_map_url
    false,        // is_opaque
    false,        // is_wasm
    false,        // is_module
);
```

## Important Constraints

1. **No capturing closures** - V8 function callbacks cannot capture variables. Use `args.this()` to access object properties or thread-local storage for shared state.

2. **Global handles aren't Send** - `v8::Global<T>` cannot be sent across threads. Store them in thread-local storage and pass IDs instead.

3. **Scope hierarchy** - Always create scopes in order: `HandleScope` → `ContextScope` → `TryCatch`

4. **Version-specific API** - rusty_v8 0.32.1 API differs from newer versions. The `v8::scope!` and `v8::tc_scope!` macros don't exist in 0.32.1.

## Event Loop Pattern

For async operations (like fetch):

1. Create a Promise resolver and store it with an ID in thread-local storage
2. Spawn work on a background thread
3. Send results back via channel (only data, not V8 handles)
4. Main loop polls channel and resolves promises

```rust
// In builtin
let id = event_loop.register_resolver(scope, resolver);
event_loop.spawn(id, move || {
    let result = do_work();
    Box::new(move |scope, resolver| {
        resolver.resolve(scope, result);
    })
});

// After script execution
event_loop.run(scope);
```

## Adding New Builtins

1. Create `src/builtins/myfeature.rs`
2. Add `mod myfeature;` to `src/builtins/mod.rs`
3. Call `myfeature::init(scope, global);` in `setup()`

Template:
```rust
use rusty_v8 as v8;

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let func = v8::Function::new(scope, callback).unwrap();
    let key = v8::String::new(scope, "functionName").unwrap();
    global.set(scope, key.into(), func.into());
}

fn callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    // implementation
}
```

## Build & Run

```bash
cargo build --release
./target/release/velox run script.js   # JavaScript
./target/release/velox run script.ts   # TypeScript
```

## oxc TypeScript Transpilation

TypeScript files (.ts, .tsx) are transpiled using oxc before execution.

```rust
use oxc_allocator::Allocator;
use oxc_codegen::Codegen;
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::SourceType;
use oxc_transformer::{TransformOptions, Transformer};
use std::path::Path;

let allocator = Allocator::default();
let source_type = SourceType::ts();

let ret = Parser::new(&allocator, source, source_type).parse();
let mut program = ret.program;

let semantic = SemanticBuilder::new().build(&program).semantic;
let scoping = semantic.into_scoping();

let options = TransformOptions::default();
let transformer = Transformer::new(&allocator, Path::new(filename), &options);
let transform_ret = transformer.build_with_scoping(scoping, &mut program);

let code = Codegen::new()
    .with_scoping(Some(transform_ret.scoping))
    .build(&program)
    .code;
```

## Dependencies

- `rusty_v8 = "0.32.1"` - V8 JavaScript engine bindings
- `ureq = "2"` - Synchronous HTTP client (used in background threads)
- `oxc_*` crates - TypeScript/JSX transpilation

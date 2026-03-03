use rusty_v8 as v8;
use std::time::Instant;

thread_local! {
    static START_TIME: Instant = Instant::now();
}

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    // Create performance object
    let performance = v8::Object::new(scope);

    // performance.now()
    let now_fn = v8::Function::new(scope, performance_now).unwrap();
    let now_key = v8::String::new(scope, "now").unwrap();
    performance.set(scope, now_key.into(), now_fn.into());

    // Set performance on global
    let perf_key = v8::String::new(scope, "performance").unwrap();
    global.set(scope, perf_key.into(), performance.into());
}

fn performance_now(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let elapsed = START_TIME.with(|start| start.elapsed());
    let ms = elapsed.as_secs_f64() * 1000.0;
    let result = v8::Number::new(scope, ms);
    rv.set(result.into());
}

use rusty_v8 as v8;

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let func = v8::Function::new(scope, queue_microtask_callback).unwrap();
    let key = v8::String::new(scope, "queueMicrotask").unwrap();
    global.set(scope, key.into(), func.into());
}

fn queue_microtask_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        let msg = v8::String::new(scope, "queueMicrotask requires a callback function").unwrap();
        let exception = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exception);
        return;
    }

    let callback = args.get(0);
    if !callback.is_function() {
        let msg = v8::String::new(scope, "queueMicrotask requires a callback function").unwrap();
        let exception = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exception);
        return;
    }

    // Use Promise.resolve().then(callback) to queue as microtask
    let context = scope.get_current_context();
    let global = context.global(scope);

    let promise_key = v8::String::new(scope, "Promise").unwrap();
    let promise_constructor = global.get(scope, promise_key.into()).unwrap();
    let promise_obj = promise_constructor.to_object(scope).unwrap();

    let resolve_key = v8::String::new(scope, "resolve").unwrap();
    let resolve_fn = promise_obj.get(scope, resolve_key.into()).unwrap();
    let resolve_fn = v8::Local::<v8::Function>::try_from(resolve_fn).unwrap();

    let undefined = v8::undefined(scope);
    let resolved = resolve_fn
        .call(scope, promise_constructor, &[undefined.into()])
        .unwrap();

    let resolved_obj = resolved.to_object(scope).unwrap();
    let then_key = v8::String::new(scope, "then").unwrap();
    let then_fn = resolved_obj.get(scope, then_key.into()).unwrap();
    let then_fn = v8::Local::<v8::Function>::try_from(then_fn).unwrap();

    then_fn.call(scope, resolved, &[callback]);
}

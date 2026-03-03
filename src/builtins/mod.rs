mod console;
pub mod fetch;

use rusty_v8 as v8;

pub fn setup(scope: &mut v8::ContextScope<v8::HandleScope>, context: v8::Local<v8::Context>) {
    let global = context.global(scope);
    console::init(scope, global);
    fetch::init(scope, global);
}

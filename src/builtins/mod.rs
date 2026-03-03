mod clone;
mod console;
mod crypto;
mod encoding;
pub mod fetch;
pub mod fs;
mod microtask;
mod path;
mod performance;
pub mod timers;
mod url;

use rusty_v8 as v8;

pub fn setup(scope: &mut v8::ContextScope<v8::HandleScope>, context: v8::Local<v8::Context>) {
    let global = context.global(scope);
    console::init(scope, global);
    fetch::init(scope, global);
    timers::init(scope, global);
    encoding::init(scope, global);
    url::init(scope, global);
    clone::init(scope, global);
    microtask::init(scope, global);
    performance::init(scope, global);
    crypto::init(scope, global);
    fs::init(scope, global);
    path::init(scope, global);
}

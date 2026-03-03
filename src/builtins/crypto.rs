use rusty_v8 as v8;
use std::io::Read;

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    // Create crypto object
    let crypto = v8::Object::new(scope);

    // crypto.randomUUID()
    let uuid_fn = v8::Function::new(scope, random_uuid).unwrap();
    let uuid_key = v8::String::new(scope, "randomUUID").unwrap();
    crypto.set(scope, uuid_key.into(), uuid_fn.into());

    // crypto.getRandomValues(array)
    let random_values_fn = v8::Function::new(scope, get_random_values).unwrap();
    let random_values_key = v8::String::new(scope, "getRandomValues").unwrap();
    crypto.set(scope, random_values_key.into(), random_values_fn.into());

    // Set crypto on global
    let crypto_key = v8::String::new(scope, "crypto").unwrap();
    global.set(scope, crypto_key.into(), crypto.into());
}

fn random_uuid(
    scope: &mut v8::HandleScope,
    _args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    // Generate 16 random bytes
    let mut bytes = [0u8; 16];
    if let Err(_) = fill_random(&mut bytes) {
        let err = v8::String::new(scope, "Failed to generate random bytes").unwrap();
        scope.throw_exception(err.into());
        return;
    }

    // Set version (4) and variant (RFC 4122)
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant RFC 4122

    // Format as UUID string
    let uuid = format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5],
        bytes[6], bytes[7],
        bytes[8], bytes[9],
        bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    );

    let result = v8::String::new(scope, &uuid).unwrap();
    rv.set(result.into());
}

fn get_random_values(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let array = args.get(0);

    // Check if it's a TypedArray
    if !array.is_typed_array() {
        let err = v8::String::new(
            scope,
            "crypto.getRandomValues: argument must be a TypedArray",
        )
        .unwrap();
        scope.throw_exception(err.into());
        return;
    }

    let typed_array = v8::Local::<v8::TypedArray>::try_from(array).unwrap();
    let byte_length = typed_array.byte_length();

    // Check length limit (65536 bytes max per spec)
    if byte_length > 65536 {
        let err = v8::String::new(
            scope,
            "crypto.getRandomValues: array byte length exceeds 65536",
        )
        .unwrap();
        scope.throw_exception(err.into());
        return;
    }

    // Get the backing store and fill with random bytes
    let backing_store = typed_array.buffer(scope).unwrap().get_backing_store();

    let byte_offset = typed_array.byte_offset();
    let data = backing_store.data();

    if !data.is_null() {
        let slice = unsafe {
            std::slice::from_raw_parts_mut((data as *mut u8).add(byte_offset), byte_length)
        };

        if let Err(_) = fill_random(slice) {
            let err = v8::String::new(scope, "Failed to generate random bytes").unwrap();
            scope.throw_exception(err.into());
            return;
        }
    }

    // Return the same array
    rv.set(array);
}

fn fill_random(buf: &mut [u8]) -> std::io::Result<()> {
    let mut file = std::fs::File::open("/dev/urandom")?;
    file.read_exact(buf)?;
    Ok(())
}

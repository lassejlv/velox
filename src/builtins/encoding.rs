use rusty_v8 as v8;

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    init_text_encoder(scope, global);
    init_text_decoder(scope, global);
    init_base64(scope, global);
}

fn init_base64(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let btoa_fn = v8::Function::new(scope, btoa_callback).unwrap();
    let btoa_key = v8::String::new(scope, "btoa").unwrap();
    global.set(scope, btoa_key.into(), btoa_fn.into());

    let atob_fn = v8::Function::new(scope, atob_callback).unwrap();
    let atob_key = v8::String::new(scope, "atob").unwrap();
    global.set(scope, atob_key.into(), atob_fn.into());
}

const BASE64_CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn btoa_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let input = if args.length() > 0 {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };

    for c in input.chars() {
        if c as u32 > 255 {
            let msg = v8::String::new(
                scope,
                "InvalidCharacterError: String contains characters outside of the Latin1 range",
            )
            .unwrap();
            let exception = v8::Exception::error(scope, msg);
            scope.throw_exception(exception);
            return;
        }
    }

    let bytes: Vec<u8> = input.chars().map(|c| c as u8).collect();
    let encoded = base64_encode(&bytes);
    let result = v8::String::new(scope, &encoded).unwrap();
    rv.set(result.into());
}

fn atob_callback(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let input = if args.length() > 0 {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };

    let clean: String = input.chars().filter(|c| !c.is_whitespace()).collect();

    match base64_decode(&clean) {
        Ok(bytes) => {
            let decoded: String = bytes.iter().map(|&b| b as char).collect();
            let result = v8::String::new(scope, &decoded).unwrap();
            rv.set(result.into());
        }
        Err(e) => {
            let msg = v8::String::new(scope, &format!("InvalidCharacterError: {}", e)).unwrap();
            let exception = v8::Exception::error(scope, msg);
            scope.throw_exception(exception);
        }
    }
}

fn base64_encode(data: &[u8]) -> String {
    let mut result = String::new();
    let chunks = data.chunks(3);

    for chunk in chunks {
        let b0 = chunk[0] as usize;
        let b1 = chunk.get(1).copied().unwrap_or(0) as usize;
        let b2 = chunk.get(2).copied().unwrap_or(0) as usize;

        result.push(BASE64_CHARS[b0 >> 2] as char);
        result.push(BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)] as char);

        if chunk.len() > 1 {
            result.push(BASE64_CHARS[((b1 & 0x0F) << 2) | (b2 >> 6)] as char);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            result.push(BASE64_CHARS[b2 & 0x3F] as char);
        } else {
            result.push('=');
        }
    }

    result
}

fn base64_decode(data: &str) -> Result<Vec<u8>, &'static str> {
    if data.is_empty() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    let chars: Vec<char> = data.chars().collect();

    if chars.len() % 4 != 0 {
        return Err("Invalid base64 string length");
    }

    for chunk in chars.chunks(4) {
        let mut values = [0u8; 4];
        let mut padding = 0;

        for (i, &c) in chunk.iter().enumerate() {
            if c == '=' {
                padding += 1;
                values[i] = 0;
            } else {
                values[i] = match c {
                    'A'..='Z' => c as u8 - b'A',
                    'a'..='z' => c as u8 - b'a' + 26,
                    '0'..='9' => c as u8 - b'0' + 52,
                    '+' => 62,
                    '/' => 63,
                    _ => return Err("Invalid base64 character"),
                };
            }
        }

        result.push((values[0] << 2) | (values[1] >> 4));
        if padding < 2 {
            result.push((values[1] << 4) | (values[2] >> 2));
        }
        if padding < 1 {
            result.push((values[2] << 6) | values[3]);
        }
    }

    Ok(result)
}

fn init_text_encoder(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let template = v8::FunctionTemplate::new(scope, text_encoder_constructor);
    let func = template.get_function(scope).unwrap();
    let key = v8::String::new(scope, "TextEncoder").unwrap();
    global.set(scope, key.into(), func.into());
}

fn text_encoder_constructor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();

    let encoding = v8::String::new(scope, "utf-8").unwrap();
    let encoding_key = v8::String::new(scope, "encoding").unwrap();
    this.set(scope, encoding_key.into(), encoding.into());

    let encode_fn = v8::Function::new(scope, text_encoder_encode).unwrap();
    let encode_key = v8::String::new(scope, "encode").unwrap();
    this.set(scope, encode_key.into(), encode_fn.into());

    let encode_into_fn = v8::Function::new(scope, text_encoder_encode_into).unwrap();
    let encode_into_key = v8::String::new(scope, "encodeInto").unwrap();
    this.set(scope, encode_into_key.into(), encode_into_fn.into());

    rv.set(this.into());
}

fn text_encoder_encode(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let input = if args.length() > 0 {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        String::new()
    };

    let bytes = input.as_bytes();
    let len = bytes.len();

    let array_buffer = v8::ArrayBuffer::new(scope, len);

    if len > 0 {
        let backing_store = array_buffer.get_backing_store();
        let data_ptr = backing_store.data();
        if !data_ptr.is_null() {
            unsafe {
                let ptr = data_ptr as *mut u8;
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, len);
            }
        }
    }

    let uint8_array = v8::Uint8Array::new(scope, array_buffer, 0, len).unwrap();
    rv.set(uint8_array.into());
}

fn text_encoder_encode_into(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 2 {
        let result = v8::Object::new(scope);
        let read_key = v8::String::new(scope, "read").unwrap();
        let written_key = v8::String::new(scope, "written").unwrap();
        let zero = v8::Integer::new(scope, 0);
        result.set(scope, read_key.into(), zero.into());
        result.set(scope, written_key.into(), zero.into());
        rv.set(result.into());
        return;
    }

    let input = args.get(0).to_rust_string_lossy(scope);
    let dest = args.get(1);

    if !dest.is_uint8_array() {
        let result = v8::Object::new(scope);
        let read_key = v8::String::new(scope, "read").unwrap();
        let written_key = v8::String::new(scope, "written").unwrap();
        let zero = v8::Integer::new(scope, 0);
        result.set(scope, read_key.into(), zero.into());
        result.set(scope, written_key.into(), zero.into());
        rv.set(result.into());
        return;
    }

    let uint8_array = v8::Local::<v8::Uint8Array>::try_from(dest).unwrap();
    let dest_len = uint8_array.byte_length();
    let array_buffer = uint8_array.buffer(scope).unwrap();
    let offset = uint8_array.byte_offset();
    let backing_store = array_buffer.get_backing_store();

    let bytes = input.as_bytes();

    let mut chars_read = 0;
    let mut bytes_written = 0;

    for ch in input.chars() {
        let ch_len = ch.len_utf8();
        if bytes_written + ch_len > dest_len {
            break;
        }
        chars_read += 1;
        bytes_written += ch_len;
    }

    if bytes_written > 0 {
        let data_ptr = backing_store.data();
        if !data_ptr.is_null() {
            unsafe {
                let ptr = (data_ptr as *mut u8).add(offset);
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes_written);
            }
        }
    }

    let result = v8::Object::new(scope);
    let read_key = v8::String::new(scope, "read").unwrap();
    let written_key = v8::String::new(scope, "written").unwrap();
    let read_val = v8::Integer::new(scope, chars_read as i32);
    let written_val = v8::Integer::new(scope, bytes_written as i32);
    result.set(scope, read_key.into(), read_val.into());
    result.set(scope, written_key.into(), written_val.into());
    rv.set(result.into());
}

fn init_text_decoder(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let template = v8::FunctionTemplate::new(scope, text_decoder_constructor);
    let func = template.get_function(scope).unwrap();
    let key = v8::String::new(scope, "TextDecoder").unwrap();
    global.set(scope, key.into(), func.into());
}

fn text_decoder_constructor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();

    let encoding = if args.length() > 0 && !args.get(0).is_undefined() {
        args.get(0).to_rust_string_lossy(scope).to_lowercase()
    } else {
        "utf-8".to_string()
    };

    let encoding_str = v8::String::new(scope, &encoding).unwrap();
    let encoding_key = v8::String::new(scope, "encoding").unwrap();
    this.set(scope, encoding_key.into(), encoding_str.into());

    let decode_fn = v8::Function::new(scope, text_decoder_decode).unwrap();
    let decode_key = v8::String::new(scope, "decode").unwrap();
    this.set(scope, decode_key.into(), decode_fn.into());

    rv.set(this.into());
}

fn text_decoder_decode(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 || args.get(0).is_undefined() {
        let empty = v8::String::new(scope, "").unwrap();
        rv.set(empty.into());
        return;
    }

    let input = args.get(0);

    let bytes: Vec<u8> = if input.is_array_buffer() {
        let array_buffer = v8::Local::<v8::ArrayBuffer>::try_from(input).unwrap();
        let backing_store = array_buffer.get_backing_store();
        let len = array_buffer.byte_length();
        let mut bytes = vec![0u8; len];
        if len > 0 {
            let data_ptr = backing_store.data();
            if !data_ptr.is_null() {
                unsafe {
                    let ptr = data_ptr as *const u8;
                    std::ptr::copy_nonoverlapping(ptr, bytes.as_mut_ptr(), len);
                }
            }
        }
        bytes
    } else if input.is_uint8_array() {
        let uint8_array = v8::Local::<v8::Uint8Array>::try_from(input).unwrap();
        let len = uint8_array.byte_length();
        let mut bytes = vec![0u8; len];
        if len > 0 {
            uint8_array.copy_contents(&mut bytes);
        }
        bytes
    } else if input.is_array_buffer_view() {
        let view = v8::Local::<v8::ArrayBufferView>::try_from(input).unwrap();
        let len = view.byte_length();
        let mut bytes = vec![0u8; len];
        if len > 0 {
            view.copy_contents(&mut bytes);
        }
        bytes
    } else {
        let empty = v8::String::new(scope, "").unwrap();
        rv.set(empty.into());
        return;
    };

    let decoded = String::from_utf8_lossy(&bytes);
    let result = v8::String::new(scope, &decoded).unwrap();
    rv.set(result.into());
}

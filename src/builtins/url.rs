use rusty_v8 as v8;

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    init_url_search_params(scope, global);
    init_url(scope, global);
}

fn init_url(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let template = v8::FunctionTemplate::new(scope, url_constructor);
    let func = template.get_function(scope).unwrap();
    let key = v8::String::new(scope, "URL").unwrap();
    global.set(scope, key.into(), func.into());
}

fn url_constructor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    if args.length() < 1 {
        let msg = v8::String::new(scope, "URL constructor requires at least 1 argument").unwrap();
        let exception = v8::Exception::type_error(scope, msg);
        scope.throw_exception(exception);
        return;
    }

    let url_str = args.get(0).to_rust_string_lossy(scope);
    let base_str = if args.length() > 1 && !args.get(1).is_undefined() {
        Some(args.get(1).to_rust_string_lossy(scope))
    } else {
        None
    };

    let parsed = match parse_url(&url_str, base_str.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            let msg = v8::String::new(scope, &format!("Invalid URL: {}", e)).unwrap();
            let exception = v8::Exception::type_error(scope, msg);
            scope.throw_exception(exception);
            return;
        }
    };

    let this = args.this();
    set_url_properties(scope, this, &parsed);

    let search_params = create_search_params_object(scope, &parsed.search);
    let sp_key = v8::String::new(scope, "searchParams").unwrap();
    this.set(scope, sp_key.into(), search_params.into());

    let to_string_fn = v8::Function::new(scope, url_to_string).unwrap();
    let to_string_key = v8::String::new(scope, "toString").unwrap();
    this.set(scope, to_string_key.into(), to_string_fn.into());

    let to_json_fn = v8::Function::new(scope, url_to_string).unwrap();
    let to_json_key = v8::String::new(scope, "toJSON").unwrap();
    this.set(scope, to_json_key.into(), to_json_fn.into());

    rv.set(this.into());
}

fn url_to_string(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let href_key = v8::String::new(scope, "href").unwrap();
    if let Some(href) = this.get(scope, href_key.into()) {
        rv.set(href);
    }
}

#[derive(Default)]
struct ParsedUrl {
    href: String,
    protocol: String,
    username: String,
    password: String,
    host: String,
    hostname: String,
    port: String,
    pathname: String,
    search: String,
    hash: String,
    origin: String,
}

fn parse_url(url: &str, base: Option<&str>) -> Result<ParsedUrl, String> {
    let full_url = if let Some(base_url) = base {
        if url.starts_with("//") {
            let base_parsed = parse_url(base_url, None)?;
            format!("{}{}", base_parsed.protocol, url)
        } else if url.starts_with('/') {
            let base_parsed = parse_url(base_url, None)?;
            format!("{}//{}{}", base_parsed.protocol, base_parsed.host, url)
        } else if url.contains("://") {
            url.to_string()
        } else {
            let base_parsed = parse_url(base_url, None)?;
            let base_path = if base_parsed.pathname.contains('/') {
                base_parsed
                    .pathname
                    .rsplit_once('/')
                    .map(|(p, _)| p)
                    .unwrap_or("")
            } else {
                ""
            };
            format!(
                "{}//{}{}/{}",
                base_parsed.protocol, base_parsed.host, base_path, url
            )
        }
    } else {
        url.to_string()
    };

    let mut parsed = ParsedUrl::default();

    let (protocol, rest) = full_url
        .split_once("://")
        .ok_or("Invalid URL: missing protocol")?;
    parsed.protocol = format!("{}:", protocol);

    let (authority, path_and_query) = if let Some(idx) = rest.find('/') {
        (&rest[..idx], &rest[idx..])
    } else if let Some(idx) = rest.find('?') {
        (&rest[..idx], &rest[idx..])
    } else if let Some(idx) = rest.find('#') {
        (&rest[..idx], &rest[idx..])
    } else {
        (rest, "/")
    };

    let (userinfo, hostport) = if let Some(at_idx) = authority.find('@') {
        (&authority[..at_idx], &authority[at_idx + 1..])
    } else {
        ("", authority)
    };

    if !userinfo.is_empty() {
        if let Some((user, pass)) = userinfo.split_once(':') {
            parsed.username = user.to_string();
            parsed.password = pass.to_string();
        } else {
            parsed.username = userinfo.to_string();
        }
    }

    if hostport.starts_with('[') {
        if let Some(bracket_end) = hostport.find(']') {
            parsed.hostname = hostport[..=bracket_end].to_string();
            if hostport.len() > bracket_end + 1
                && hostport.chars().nth(bracket_end + 1) == Some(':')
            {
                parsed.port = hostport[bracket_end + 2..].to_string();
            }
        } else {
            parsed.hostname = hostport.to_string();
        }
    } else if let Some((host, port)) = hostport.rsplit_once(':') {
        parsed.hostname = host.to_string();
        parsed.port = port.to_string();
    } else {
        parsed.hostname = hostport.to_string();
    }

    parsed.host = if parsed.port.is_empty() {
        parsed.hostname.clone()
    } else {
        format!("{}:{}", parsed.hostname, parsed.port)
    };

    let path_and_query = if path_and_query.is_empty() || !path_and_query.starts_with('/') {
        format!("/{}", path_and_query.trim_start_matches('/'))
    } else {
        path_and_query.to_string()
    };

    let (path_search, hash) = if let Some(hash_idx) = path_and_query.find('#') {
        (&path_and_query[..hash_idx], &path_and_query[hash_idx..])
    } else {
        (path_and_query.as_str(), "")
    };
    parsed.hash = hash.to_string();

    let (pathname, search) = if let Some(q_idx) = path_search.find('?') {
        (&path_search[..q_idx], &path_search[q_idx..])
    } else {
        (path_search, "")
    };
    parsed.pathname = pathname.to_string();
    parsed.search = search.to_string();

    parsed.origin = format!("{}//{}", parsed.protocol, parsed.host);

    let mut href = parsed.protocol.clone();
    href.push_str("//");
    if !parsed.username.is_empty() {
        href.push_str(&parsed.username);
        if !parsed.password.is_empty() {
            href.push(':');
            href.push_str(&parsed.password);
        }
        href.push('@');
    }
    href.push_str(&parsed.host);
    href.push_str(&parsed.pathname);
    href.push_str(&parsed.search);
    href.push_str(&parsed.hash);
    parsed.href = href;

    Ok(parsed)
}

fn set_url_properties(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>, parsed: &ParsedUrl) {
    let props = [
        ("href", &parsed.href),
        ("protocol", &parsed.protocol),
        ("username", &parsed.username),
        ("password", &parsed.password),
        ("host", &parsed.host),
        ("hostname", &parsed.hostname),
        ("port", &parsed.port),
        ("pathname", &parsed.pathname),
        ("search", &parsed.search),
        ("hash", &parsed.hash),
        ("origin", &parsed.origin),
    ];

    for (name, value) in props {
        let key = v8::String::new(scope, name).unwrap();
        let val = v8::String::new(scope, value).unwrap();
        obj.set(scope, key.into(), val.into());
    }
}

fn init_url_search_params(
    scope: &mut v8::ContextScope<v8::HandleScope>,
    global: v8::Local<v8::Object>,
) {
    let template = v8::FunctionTemplate::new(scope, url_search_params_constructor);
    let func = template.get_function(scope).unwrap();
    let key = v8::String::new(scope, "URLSearchParams").unwrap();
    global.set(scope, key.into(), func.into());
}

fn url_search_params_constructor(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let init = if args.length() > 0 {
        Some(args.get(0))
    } else {
        None
    };
    let search_str = if let Some(init_val) = init {
        if init_val.is_string() {
            let s = init_val.to_rust_string_lossy(scope);
            s.strip_prefix('?').unwrap_or(&s).to_string()
        } else if init_val.is_object() && !init_val.is_array() {
            let obj = init_val.to_object(scope).unwrap();
            if let Some(keys) = obj.get_own_property_names(scope) {
                let mut pairs = Vec::new();
                for i in 0..keys.length() {
                    let key = keys.get_index(scope, i).unwrap();
                    let val = obj.get(scope, key).unwrap();
                    let key_str = key.to_rust_string_lossy(scope);
                    let val_str = val.to_rust_string_lossy(scope);
                    pairs.push(format!(
                        "{}={}",
                        encode_uri_component(&key_str),
                        encode_uri_component(&val_str)
                    ));
                }
                pairs.join("&")
            } else {
                String::new()
            }
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    let this = args.this();
    let params_obj = create_search_params_from_string(scope, &search_str);

    let internal_key = v8::String::new(scope, "_params").unwrap();
    this.set(scope, internal_key.into(), params_obj.into());

    setup_search_params_methods(scope, this);

    rv.set(this.into());
}

fn create_search_params_object<'s>(
    scope: &mut v8::HandleScope<'s>,
    search: &str,
) -> v8::Local<'s, v8::Object> {
    let this = v8::Object::new(scope);
    let search_str = search.strip_prefix('?').unwrap_or(search);
    let params_obj = create_search_params_from_string(scope, search_str);

    let internal_key = v8::String::new(scope, "_params").unwrap();
    this.set(scope, internal_key.into(), params_obj.into());

    setup_search_params_methods(scope, this);
    this
}

fn create_search_params_from_string<'s>(
    scope: &mut v8::HandleScope<'s>,
    search: &str,
) -> v8::Local<'s, v8::Array> {
    let pairs: Vec<(&str, &str)> = search
        .split('&')
        .filter(|s| !s.is_empty())
        .filter_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let value = parts.next().unwrap_or("");
            Some((key, value))
        })
        .collect();

    let arr = v8::Array::new(scope, pairs.len() as i32);
    for (i, (key, value)) in pairs.iter().enumerate() {
        let pair_arr = v8::Array::new(scope, 2);
        let k = v8::String::new(scope, &decode_uri_component(key)).unwrap();
        let v = v8::String::new(scope, &decode_uri_component(value)).unwrap();
        pair_arr.set_index(scope, 0, k.into());
        pair_arr.set_index(scope, 1, v.into());
        arr.set_index(scope, i as u32, pair_arr.into());
    }
    arr
}

fn setup_search_params_methods(scope: &mut v8::HandleScope, obj: v8::Local<v8::Object>) {
    set_method(scope, obj, "get", sp_get);
    set_method(scope, obj, "getAll", sp_get_all);
    set_method(scope, obj, "has", sp_has);
    set_method(scope, obj, "set", sp_set);
    set_method(scope, obj, "append", sp_append);
    set_method(scope, obj, "delete", sp_delete);
    set_method(scope, obj, "toString", sp_to_string);
    set_method(scope, obj, "entries", sp_entries);
    set_method(scope, obj, "keys", sp_keys);
    set_method(scope, obj, "values", sp_values);
}

fn set_method(
    scope: &mut v8::HandleScope,
    obj: v8::Local<v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let func = v8::Function::new(scope, callback).unwrap();
    let key = v8::String::new(scope, name).unwrap();
    obj.set(scope, key.into(), func.into());
}

fn get_params_array<'s>(
    scope: &mut v8::HandleScope<'s>,
    this: v8::Local<v8::Object>,
) -> Option<v8::Local<'s, v8::Array>> {
    let key = v8::String::new(scope, "_params").unwrap();
    let val = this.get(scope, key.into())?;
    v8::Local::<v8::Array>::try_from(val).ok()
}

fn sp_get(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let name = if args.length() > 0 {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        return;
    };

    if let Some(params) = get_params_array(scope, this) {
        for i in 0..params.length() {
            if let Some(pair) = params.get_index(scope, i) {
                if let Ok(pair_arr) = v8::Local::<v8::Array>::try_from(pair) {
                    if let Some(k) = pair_arr.get_index(scope, 0) {
                        if k.to_rust_string_lossy(scope) == name {
                            if let Some(v) = pair_arr.get_index(scope, 1) {
                                rv.set(v);
                                return;
                            }
                        }
                    }
                }
            }
        }
    }
    rv.set(v8::null(scope).into());
}

fn sp_get_all(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let name = if args.length() > 0 {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        return;
    };

    let result = v8::Array::new(scope, 0);
    let mut idx = 0;

    if let Some(params) = get_params_array(scope, this) {
        for i in 0..params.length() {
            if let Some(pair) = params.get_index(scope, i) {
                if let Ok(pair_arr) = v8::Local::<v8::Array>::try_from(pair) {
                    if let Some(k) = pair_arr.get_index(scope, 0) {
                        if k.to_rust_string_lossy(scope) == name {
                            if let Some(v) = pair_arr.get_index(scope, 1) {
                                result.set_index(scope, idx, v);
                                idx += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    rv.set(result.into());
}

fn sp_has(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let name = if args.length() > 0 {
        args.get(0).to_rust_string_lossy(scope)
    } else {
        return;
    };

    let mut found = false;
    if let Some(params) = get_params_array(scope, this) {
        for i in 0..params.length() {
            if let Some(pair) = params.get_index(scope, i) {
                if let Ok(pair_arr) = v8::Local::<v8::Array>::try_from(pair) {
                    if let Some(k) = pair_arr.get_index(scope, 0) {
                        if k.to_rust_string_lossy(scope) == name {
                            found = true;
                            break;
                        }
                    }
                }
            }
        }
    }
    rv.set(v8::Boolean::new(scope, found).into());
}

fn sp_set(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    let this = args.this();
    if args.length() < 2 {
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);
    let value = args.get(1);

    if let Some(params) = get_params_array(scope, this) {
        let new_arr = v8::Array::new(scope, 0);
        let mut idx = 0;
        let mut set = false;

        for i in 0..params.length() {
            if let Some(pair) = params.get_index(scope, i) {
                if let Ok(pair_arr) = v8::Local::<v8::Array>::try_from(pair) {
                    if let Some(k) = pair_arr.get_index(scope, 0) {
                        if k.to_rust_string_lossy(scope) == name {
                            if !set {
                                let new_pair = v8::Array::new(scope, 2);
                                let k_str = v8::String::new(scope, &name).unwrap();
                                new_pair.set_index(scope, 0, k_str.into());
                                new_pair.set_index(scope, 1, value);
                                new_arr.set_index(scope, idx, new_pair.into());
                                idx += 1;
                                set = true;
                            }
                        } else {
                            new_arr.set_index(scope, idx, pair);
                            idx += 1;
                        }
                    }
                }
            }
        }

        if !set {
            let new_pair = v8::Array::new(scope, 2);
            let k_str = v8::String::new(scope, &name).unwrap();
            new_pair.set_index(scope, 0, k_str.into());
            new_pair.set_index(scope, 1, value);
            new_arr.set_index(scope, idx, new_pair.into());
        }

        let internal_key = v8::String::new(scope, "_params").unwrap();
        this.set(scope, internal_key.into(), new_arr.into());
    }
}

fn sp_append(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let this = args.this();
    if args.length() < 2 {
        return;
    }
    let name = args.get(0);
    let value = args.get(1);

    if let Some(params) = get_params_array(scope, this) {
        let new_pair = v8::Array::new(scope, 2);
        new_pair.set_index(scope, 0, name);
        new_pair.set_index(scope, 1, value);
        params.set_index(scope, params.length(), new_pair.into());
    }
}

fn sp_delete(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    _rv: v8::ReturnValue,
) {
    let this = args.this();
    if args.length() < 1 {
        return;
    }
    let name = args.get(0).to_rust_string_lossy(scope);

    if let Some(params) = get_params_array(scope, this) {
        let new_arr = v8::Array::new(scope, 0);
        let mut idx = 0;

        for i in 0..params.length() {
            if let Some(pair) = params.get_index(scope, i) {
                if let Ok(pair_arr) = v8::Local::<v8::Array>::try_from(pair) {
                    if let Some(k) = pair_arr.get_index(scope, 0) {
                        if k.to_rust_string_lossy(scope) != name {
                            new_arr.set_index(scope, idx, pair);
                            idx += 1;
                        }
                    }
                }
            }
        }

        let internal_key = v8::String::new(scope, "_params").unwrap();
        this.set(scope, internal_key.into(), new_arr.into());
    }
}

fn sp_to_string(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let mut parts = Vec::new();

    if let Some(params) = get_params_array(scope, this) {
        for i in 0..params.length() {
            if let Some(pair) = params.get_index(scope, i) {
                if let Ok(pair_arr) = v8::Local::<v8::Array>::try_from(pair) {
                    if let (Some(k), Some(v)) =
                        (pair_arr.get_index(scope, 0), pair_arr.get_index(scope, 1))
                    {
                        let key = k.to_rust_string_lossy(scope);
                        let val = v.to_rust_string_lossy(scope);
                        parts.push(format!(
                            "{}={}",
                            encode_uri_component(&key),
                            encode_uri_component(&val)
                        ));
                    }
                }
            }
        }
    }

    let result = v8::String::new(scope, &parts.join("&")).unwrap();
    rv.set(result.into());
}

fn sp_entries(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    if let Some(params) = get_params_array(scope, this) {
        rv.set(params.into());
    }
}

fn sp_keys(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let result = v8::Array::new(scope, 0);
    let mut idx = 0;

    if let Some(params) = get_params_array(scope, this) {
        for i in 0..params.length() {
            if let Some(pair) = params.get_index(scope, i) {
                if let Ok(pair_arr) = v8::Local::<v8::Array>::try_from(pair) {
                    if let Some(k) = pair_arr.get_index(scope, 0) {
                        result.set_index(scope, idx, k);
                        idx += 1;
                    }
                }
            }
        }
    }
    rv.set(result.into());
}

fn sp_values(
    scope: &mut v8::HandleScope,
    args: v8::FunctionCallbackArguments,
    mut rv: v8::ReturnValue,
) {
    let this = args.this();
    let result = v8::Array::new(scope, 0);
    let mut idx = 0;

    if let Some(params) = get_params_array(scope, this) {
        for i in 0..params.length() {
            if let Some(pair) = params.get_index(scope, i) {
                if let Ok(pair_arr) = v8::Local::<v8::Array>::try_from(pair) {
                    if let Some(v) = pair_arr.get_index(scope, 1) {
                        result.set_index(scope, idx, v);
                        idx += 1;
                    }
                }
            }
        }
    }
    rv.set(result.into());
}

fn encode_uri_component(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => result.push(c),
            _ => {
                for b in c.to_string().as_bytes() {
                    result.push_str(&format!("%{:02X}", b));
                }
            }
        }
    }
    result
}

fn decode_uri_component(s: &str) -> String {
    let mut result = Vec::new();
    let bytes = s.as_bytes();
    let mut i = 0;

    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                result.push(hex);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            result.push(b' ');
            i += 1;
            continue;
        }
        result.push(bytes[i]);
        i += 1;
    }

    String::from_utf8_lossy(&result).to_string()
}

use crate::colors;
use rusty_v8 as v8;
use std::collections::BTreeSet;

pub fn init(scope: &mut v8::ContextScope<v8::HandleScope>, global: v8::Local<v8::Object>) {
    let console = v8::Object::new(scope);

    set_method(scope, console, "log", log);
    set_method(scope, console, "error", error);
    set_method(scope, console, "warn", warn);
    set_method(scope, console, "info", info);
    set_method(scope, console, "debug", debug);
    set_method(scope, console, "table", table);

    let key = v8::String::new(scope, "console").unwrap();
    global.set(scope, key.into(), console.into());
}

fn set_method(
    scope: &mut v8::ContextScope<v8::HandleScope>,
    obj: v8::Local<v8::Object>,
    name: &str,
    callback: impl v8::MapFnTo<v8::FunctionCallback>,
) {
    let key = v8::String::new(scope, name).unwrap();
    let func = v8::Function::new(scope, callback).unwrap();
    obj.set(scope, key.into(), func.into());
}

fn stringify(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>) -> String {
    if value.is_string() {
        return value.to_rust_string_lossy(scope);
    }

    if value.is_object() || value.is_array() {
        let global = scope.get_current_context().global(scope);
        let json_key = v8::String::new(scope, "JSON").unwrap();
        let stringify_key = v8::String::new(scope, "stringify").unwrap();

        if let Some(json) = global.get(scope, json_key.into()) {
            if let Some(json_obj) = json.to_object(scope) {
                if let Some(stringify) = json_obj.get(scope, stringify_key.into()) {
                    if let Some(func) = v8::Local::<v8::Function>::try_from(stringify).ok() {
                        let null = v8::null(scope);
                        let indent = v8::Integer::new(scope, 2);
                        if let Some(result) = func.call(scope, json.into(), &[value, null.into(), indent.into()]) {
                            return result.to_rust_string_lossy(scope);
                        }
                    }
                }
            }
        }
    }

    value.to_rust_string_lossy(scope)
}

fn stringify_cell(scope: &mut v8::HandleScope, value: v8::Local<v8::Value>, max_width: usize) -> String {
    if value.is_null_or_undefined() {
        return String::new();
    }
    if value.is_object() && !value.is_array() {
        return "[object]".to_string();
    }
    if value.is_array() {
        return "[array]".to_string();
    }

    let s = value.to_rust_string_lossy(scope);
    truncate_cell(&s, max_width)
}

fn truncate_cell(s: &str, max_width: usize) -> String {
    let sanitized: String = s
        .chars()
        .map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .collect();

    if sanitized.len() <= max_width {
        sanitized
    } else {
        format!("{}…", &sanitized[..max_width - 1])
    }
}

fn format_args(scope: &mut v8::HandleScope, args: &v8::FunctionCallbackArguments) -> String {
    (0..args.length())
        .map(|i| stringify(scope, args.get(i)))
        .collect::<Vec<_>>()
        .join(" ")
}

fn log(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    println!("{}", format_args(scope, &args));
}

fn error(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    eprintln!("{}{}{}", colors::RED, format_args(scope, &args), colors::RESET);
}

fn warn(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    eprintln!("{}{}{}", colors::YELLOW, format_args(scope, &args), colors::RESET);
}

fn info(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    println!("{}{}{}", colors::CYAN, format_args(scope, &args), colors::RESET);
}

fn debug(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    println!("{}{}{}", colors::DIM, format_args(scope, &args), colors::RESET);
}

fn table(scope: &mut v8::HandleScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue) {
    const MAX_CELL_WIDTH: usize = 50;

    if args.length() < 1 {
        println!();
        return;
    }

    let data = args.get(0);

    if !data.is_array() {
        println!("{}", stringify(scope, data));
        return;
    }

    let arr = v8::Local::<v8::Array>::try_from(data).unwrap();
    let len = arr.length();

    if len == 0 {
        println!("[]");
        return;
    }

    let mut columns: BTreeSet<String> = BTreeSet::new();
    columns.insert("(index)".to_string());

    for i in 0..len {
        if let Some(item) = arr.get_index(scope, i) {
            if item.is_object() && !item.is_array() {
                let obj = item.to_object(scope).unwrap();
                if let Some(keys) = obj.get_own_property_names(scope) {
                    for j in 0..keys.length() {
                        let key = keys.get_index(scope, j).unwrap();
                        columns.insert(key.to_rust_string_lossy(scope));
                    }
                }
            } else {
                columns.insert("Values".to_string());
            }
        }
    }

    let columns: Vec<String> = columns.into_iter().collect();

    let mut rows: Vec<Vec<String>> = Vec::new();

    for i in 0..len {
        let mut row: Vec<String> = Vec::new();

        for col in &columns {
            if col == "(index)" {
                row.push(i.to_string());
            } else if let Some(item) = arr.get_index(scope, i) {
                if item.is_object() && !item.is_array() {
                    let obj = item.to_object(scope).unwrap();
                    let key = v8::String::new(scope, col).unwrap();
                    if let Some(val) = obj.get(scope, key.into()) {
                        row.push(stringify_cell(scope, val, MAX_CELL_WIDTH));
                    } else {
                        row.push(String::new());
                    }
                } else if col == "Values" {
                    row.push(stringify_cell(scope, item, MAX_CELL_WIDTH));
                } else {
                    row.push(String::new());
                }
            } else {
                row.push(String::new());
            }
        }

        rows.push(row);
    }

    let mut widths: Vec<usize> = columns.iter().map(|c| c.len()).collect();
    for row in &rows {
        for (i, cell) in row.iter().enumerate() {
            widths[i] = widths[i].max(cell.len());
        }
    }

    let separator: String = widths.iter().map(|w| "─".repeat(*w + 2)).collect::<Vec<_>>().join("┼");
    let top = format!("┌{}┐", widths.iter().map(|w| "─".repeat(*w + 2)).collect::<Vec<_>>().join("┬"));
    let mid = format!("├{}┤", separator);
    let bot = format!("└{}┘", widths.iter().map(|w| "─".repeat(*w + 2)).collect::<Vec<_>>().join("┴"));

    println!("{}", top);

    let header: String = columns
        .iter()
        .enumerate()
        .map(|(i, c)| format!(" {}{}{} ", colors::BOLD, pad(c, widths[i]), colors::RESET))
        .collect::<Vec<_>>()
        .join("│");
    println!("│{}│", header);
    println!("{}", mid);

    for row in &rows {
        let line: String = row
            .iter()
            .enumerate()
            .map(|(i, c)| format!(" {} ", pad(c, widths[i])))
            .collect::<Vec<_>>()
            .join("│");
        println!("│{}│", line);
    }

    println!("{}", bot);
}

fn pad(s: &str, width: usize) -> String {
    format!("{:width$}", s, width = width)
}

//! `node:sqlite` — synchronous embedded SQLite via `rusqlite` (SQLite compiled
//! in via the `bundled` feature, so there's no system dependency). The JS shim
//! (`src/builtins/sqlite.js`) wraps these natives in `DatabaseSync` /
//! `StatementSync`.
//!
//! Values cross the FFI as JSON. BLOBs and integers that don't fit a JS number
//! are encoded as tagged objects — `{"t":"blob","v":"<base64>"}` and
//! `{"t":"bigint","v":"<decimal>"}` — so binary data and >2^53 integers survive
//! the JSON hop; the shim reconstitutes them as `Buffer`/`BigInt`. Statements are
//! re-prepared from their SQL on each call (rusqlite's prepare is cheap and this
//! sidesteps holding a borrow of the connection across the JS boundary).
//!
//! Connections live in a thread-local registry keyed by id, so each worker
//! thread (which has its own JS context) gets an independent set.

use std::cell::RefCell;
use std::collections::HashMap;
use std::ptr;

use base64::Engine;
use objc2_javascript_core::{JSContextRef, JSObjectRef, JSValue, JSValueRef};
use rusqlite::Connection;
use rusqlite::types::{Value, ValueRef};
use serde_json::{Value as Json, json};

use crate::event_loop::{arg_slice, register};
use crate::node::{call_named, js_string};
use crate::runtime::js_value_to_string;

thread_local! {
    static DBS: RefCell<HashMap<u64, Connection>> = RefCell::new(HashMap::new());
    static NEXT_ID: RefCell<u64> = const { RefCell::new(1) };
}

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// The largest integer magnitude that round-trips exactly through an f64.
const MAX_SAFE_INT: i64 = 9_007_199_254_740_991;

/// Register the native SQLite functions.
pub fn install(ctx: JSContextRef) {
    unsafe {
        register(ctx, c"__velox_sqlite_open", open_fn);
        register(ctx, c"__velox_sqlite_close", close_fn);
        register(ctx, c"__velox_sqlite_exec", exec_fn);
        register(ctx, c"__velox_sqlite_run", run_fn);
        register(ctx, c"__velox_sqlite_query", query_fn);
        register(ctx, c"__velox_sqlite_create_function", create_function_fn);
        register(ctx, c"__velox_sqlite_create_aggregate", create_aggregate_fn);
    }
}

/// A `JSContextRef` captured into a rusqlite callback. The callback only ever
/// runs on the connection's owning thread (where the context lives), so sharing
/// the raw pointer is sound despite the `Send` bound `create_*_function` demands.
struct SendCtx(JSContextRef);
unsafe impl Send for SendCtx {}
impl SendCtx {
    /// Read the context pointer. Going through `&self` makes a closure capture
    /// the whole `SendCtx` (which is `Send`) rather than the bare pointer field
    /// (which isn't) under edition-2024 disjoint closure captures.
    fn ctx(&self) -> JSContextRef {
        self.0
    }
}

/// Marshal a function callback's SQL arguments to a JSON array string.
fn args_to_json(fctx: &rusqlite::functions::Context) -> String {
    let mut arr: Vec<Json> = Vec::with_capacity(fctx.len());
    for i in 0..fctx.len() {
        arr.push(sql_to_json(fctx.get_raw(i), false));
    }
    Json::Array(arr).to_string()
}

/// Interpret a JSON result returned from the JS side (a tagged value, or an
/// `{err}` marker) as a SQLite value or a user-function error.
fn json_result_to_sql(json: &str) -> rusqlite::Result<Value> {
    let parsed: Json = serde_json::from_str(json).unwrap_or(Json::Null);
    if let Json::Object(o) = &parsed
        && let Some(msg) = o.get("err").and_then(|e| e.as_str())
    {
        return Err(rusqlite::Error::UserFunctionError(msg.to_string().into()));
    }
    Ok(json_to_sql(&parsed))
}

unsafe fn throw(ctx: JSContextRef, exception: *mut JSValueRef, message: &str) -> JSValueRef {
    unsafe {
        let args = [js_string(ctx, "ERR_SQLITE_ERROR"), js_string(ctx, message)];
        let error = call_named(ctx, c"__velox_fs_error", &args);
        if !exception.is_null() {
            *exception = error;
        }
        JSValue::new_undefined(ctx)
    }
}

fn arg_string(ctx: JSContextRef, args: &[JSValueRef], i: usize) -> String {
    args.get(i)
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default()
}

fn arg_u64(ctx: JSContextRef, args: &[JSValueRef], i: usize) -> u64 {
    args.get(i)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| n as u64)
        .unwrap_or(0)
}

/// Convert a JSON parameter value into a SQLite value. Tagged objects carry
/// blobs/bigints; plain JSON numbers become INTEGER when integral, else REAL.
fn json_to_sql(v: &Json) -> Value {
    match v {
        Json::Null => Value::Null,
        Json::Bool(b) => Value::Integer(*b as i64),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                Value::Real(f)
            } else {
                Value::Null
            }
        }
        Json::String(s) => Value::Text(s.clone()),
        Json::Object(o) => match o.get("t").and_then(|t| t.as_str()) {
            Some("blob") => {
                let v = o.get("v").and_then(|x| x.as_str()).unwrap_or("");
                Value::Blob(B64.decode(v).unwrap_or_default())
            }
            Some("bigint") => {
                let v = o.get("v").and_then(|x| x.as_str()).unwrap_or("0");
                Value::Integer(v.parse().unwrap_or(0))
            }
            _ => Value::Null,
        },
        // Arrays aren't valid bind values.
        Json::Array(_) => Value::Null,
    }
}

/// Convert a SQLite column value into JSON for the JS side. Integers outside the
/// JS safe range (or when `bigints` is set) come back bigint-tagged.
fn sql_to_json(v: ValueRef, bigints: bool) -> Json {
    match v {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(i) => {
            if bigints || i > MAX_SAFE_INT || i < -MAX_SAFE_INT {
                json!({ "t": "bigint", "v": i.to_string() })
            } else {
                json!(i)
            }
        }
        ValueRef::Real(f) => json!(f),
        ValueRef::Text(t) => json!(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => json!({ "t": "blob", "v": B64.encode(b) }),
    }
}

/// Bind a parsed parameter set (JSON array → positional, JSON object → named) to
/// a prepared statement.
fn bind_params(stmt: &mut rusqlite::Statement, params: &Json) -> Result<(), rusqlite::Error> {
    match params {
        Json::Array(arr) => {
            for (i, v) in arr.iter().enumerate() {
                stmt.raw_bind_parameter(i + 1, json_to_sql(v))?;
            }
        }
        Json::Object(obj) => {
            for (k, v) in obj {
                // The shim sends names with their sigil (`:name`/`@name`/`$name`).
                if let Some(idx) = stmt.parameter_index(k)? {
                    stmt.raw_bind_parameter(idx, json_to_sql(v))?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

/// `__velox_sqlite_open(path)` → numeric connection id. `:memory:`/empty opens an
/// in-memory database.
unsafe extern "C-unwind" fn open_fn(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let path = arg_string(ctx, args, 0);
    let conn = if path.is_empty() || path == ":memory:" {
        Connection::open_in_memory()
    } else {
        Connection::open(&path)
    };
    match conn {
        Ok(c) => {
            let id = NEXT_ID.with(|n| {
                let mut n = n.borrow_mut();
                let id = *n;
                *n += 1;
                id
            });
            DBS.with(|d| d.borrow_mut().insert(id, c));
            unsafe { JSValue::new_number(ctx, id as f64) }
        }
        Err(e) => unsafe { throw(ctx, exc, &e.to_string()) },
    }
}

/// `__velox_sqlite_close(id)` — close and drop the connection.
unsafe extern "C-unwind" fn close_fn(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_u64(ctx, args, 0);
    DBS.with(|d| d.borrow_mut().remove(&id));
    unsafe { JSValue::new_undefined(ctx) }
}

/// `__velox_sqlite_exec(id, sql)` — run a batch of statements, no results.
unsafe extern "C-unwind" fn exec_fn(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_u64(ctx, args, 0);
    let sql = arg_string(ctx, args, 1);
    let result = DBS.with(|d| {
        d.borrow()
            .get(&id)
            .ok_or_else(|| "database is not open".to_string())
            .and_then(|c| c.execute_batch(&sql).map_err(|e| e.to_string()))
    });
    match result {
        Ok(()) => unsafe { JSValue::new_undefined(ctx) },
        Err(e) => unsafe { throw(ctx, exc, &e) },
    }
}

/// `__velox_sqlite_run(id, sql, paramsJson)` → JSON `{changes, lastInsertRowid}`.
unsafe extern "C-unwind" fn run_fn(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_u64(ctx, args, 0);
    let sql = arg_string(ctx, args, 1);
    let params: Json = serde_json::from_str(&arg_string(ctx, args, 2)).unwrap_or(Json::Null);

    let result = DBS.with(|d| -> Result<String, String> {
        let dbs = d.borrow();
        let conn = dbs.get(&id).ok_or("database is not open")?;
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        bind_params(&mut stmt, &params).map_err(|e| e.to_string())?;
        let changes = stmt.raw_execute().map_err(|e| e.to_string())?;
        let last = conn.last_insert_rowid();
        let last_json = if last > MAX_SAFE_INT || last < -MAX_SAFE_INT {
            json!({ "t": "bigint", "v": last.to_string() })
        } else {
            json!(last)
        };
        Ok(json!({ "changes": changes, "lastInsertRowid": last_json }).to_string())
    });
    match result {
        Ok(s) => unsafe { js_string(ctx, &s) },
        Err(e) => unsafe { throw(ctx, exc, &e) },
    }
}

/// `__velox_sqlite_query(id, sql, paramsJson, bigints)` → JSON
/// `{columns: [...], rows: [[...], ...]}`. The shim turns this into objects and
/// picks the first row for `.get()` / all rows for `.all()` / an iterator for
/// `.iterate()`.
unsafe extern "C-unwind" fn query_fn(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_u64(ctx, args, 0);
    let sql = arg_string(ctx, args, 1);
    let params: Json = serde_json::from_str(&arg_string(ctx, args, 2)).unwrap_or(Json::Null);
    let bigints = args
        .get(3)
        .map(|v| unsafe { JSValue::to_boolean(ctx, *v) })
        .unwrap_or(false);

    let result = DBS.with(|d| -> Result<String, String> {
        let dbs = d.borrow();
        let conn = dbs.get(&id).ok_or("database is not open")?;
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let col_count = columns.len();
        bind_params(&mut stmt, &params).map_err(|e| e.to_string())?;
        let mut rows = stmt.raw_query();
        let mut out: Vec<Json> = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let mut cells: Vec<Json> = Vec::with_capacity(col_count);
            for i in 0..col_count {
                let v = row.get_ref(i).map_err(|e| e.to_string())?;
                cells.push(sql_to_json(v, bigints));
            }
            out.push(Json::Array(cells));
        }
        Ok(json!({ "columns": columns, "rows": out }).to_string())
    });
    match result {
        Ok(s) => unsafe { js_string(ctx, &s) },
        Err(e) => unsafe { throw(ctx, exc, &e) },
    }
}

/// `__velox_sqlite_create_function(id, name, nArgs)` — register a scalar SQL
/// function. When SQL invokes it, the closure marshals the args to JSON, calls
/// the JS dispatcher `__velox_sqlite_call_function(id, name, argsJson)`, and turns
/// the returned tagged value back into a SQLite value. The JS side holds the
/// user's function (GC-reachable), so nothing is protected on the Rust side.
unsafe extern "C-unwind" fn create_function_fn(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_u64(ctx, args, 0);
    let name = arg_string(ctx, args, 1);
    let n_args = args
        .get(2)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(-1.0) as i32;

    let sctx = SendCtx(ctx);
    let fname = name.clone();
    let dbid = id.to_string();

    let result = DBS.with(|d| -> Result<(), String> {
        let dbs = d.borrow();
        let conn = dbs.get(&id).ok_or("database is not open")?;
        conn.create_scalar_function(
            &name,
            if n_args < 0 { -1 } else { n_args },
            rusqlite::functions::FunctionFlags::SQLITE_UTF8,
            move |fctx| {
                let c = sctx.ctx();
                let args_json = args_to_json(fctx);
                let out = unsafe {
                    let jsargs = [
                        js_string(c, &dbid),
                        js_string(c, &fname),
                        js_string(c, &args_json),
                    ];
                    let r = call_named(c, c"__velox_sqlite_call_function", &jsargs);
                    js_value_to_string(c, r)
                };
                json_result_to_sql(&out)
            },
        )
        .map_err(|e| e.to_string())
    });
    match result {
        Ok(()) => unsafe { JSValue::new_undefined(ctx) },
        Err(e) => unsafe { throw(ctx, exc, &e) },
    }
}

/// A JS-backed aggregate. The accumulator crosses the FFI as a JSON string; each
/// phase calls the matching JS dispatcher.
struct JsAggregate {
    ctx: SendCtx,
    dbid: String,
    name: String,
}

impl rusqlite::functions::Aggregate<String, Value> for JsAggregate {
    fn init(&self, _: &mut rusqlite::functions::Context) -> rusqlite::Result<String> {
        let c = self.ctx.0;
        let out = unsafe {
            let jsargs = [js_string(c, &self.dbid), js_string(c, &self.name)];
            let r = call_named(c, c"__velox_sqlite_agg_start", &jsargs);
            js_value_to_string(c, r)
        };
        Ok(out)
    }

    fn step(
        &self,
        fctx: &mut rusqlite::functions::Context,
        acc: &mut String,
    ) -> rusqlite::Result<()> {
        let c = self.ctx.0;
        let args_json = args_to_json(fctx);
        let next = unsafe {
            let jsargs = [
                js_string(c, &self.dbid),
                js_string(c, &self.name),
                js_string(c, acc),
                js_string(c, &args_json),
            ];
            let r = call_named(c, c"__velox_sqlite_agg_step", &jsargs);
            js_value_to_string(c, r)
        };
        *acc = next;
        Ok(())
    }

    fn finalize(
        &self,
        _: &mut rusqlite::functions::Context,
        acc: Option<String>,
    ) -> rusqlite::Result<Value> {
        let c = self.ctx.0;
        let acc = acc.unwrap_or_else(|| "null".to_string());
        let out = unsafe {
            let jsargs = [
                js_string(c, &self.dbid),
                js_string(c, &self.name),
                js_string(c, &acc),
            ];
            let r = call_named(c, c"__velox_sqlite_agg_result", &jsargs);
            js_value_to_string(c, r)
        };
        json_result_to_sql(&out)
    }
}

/// `__velox_sqlite_create_aggregate(id, name, nArgs)` — register an aggregate
/// whose start/step/result callbacks live in JS.
unsafe extern "C-unwind" fn create_aggregate_fn(
    ctx: JSContextRef,
    _f: JSObjectRef,
    _t: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    exc: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let id = arg_u64(ctx, args, 0);
    let name = arg_string(ctx, args, 1);
    let n_args = args
        .get(2)
        .map(|v| unsafe { JSValue::to_number(ctx, *v, ptr::null_mut()) })
        .unwrap_or(-1.0) as i32;

    let aggr = JsAggregate {
        ctx: SendCtx(ctx),
        dbid: id.to_string(),
        name: name.clone(),
    };
    let result = DBS.with(|d| -> Result<(), String> {
        let dbs = d.borrow();
        let conn = dbs.get(&id).ok_or("database is not open")?;
        conn.create_aggregate_function(
            &name,
            if n_args < 0 { -1 } else { n_args },
            rusqlite::functions::FunctionFlags::SQLITE_UTF8,
            aggr,
        )
        .map_err(|e| e.to_string())
    });
    match result {
        Ok(()) => unsafe { JSValue::new_undefined(ctx) },
        Err(e) => unsafe { throw(ctx, exc, &e) },
    }
}

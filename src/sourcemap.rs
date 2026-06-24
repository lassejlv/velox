//! Maps runtime stack frames back to original source.
//!
//! velox evaluates one concatenated bundle, so JSC's `error.stack` frames point
//! at `velox:///bundle.js:<line>:<col>`. During [`crate::module`] emit we record,
//! per module, the bundle line range its body occupies plus that module's
//! codegen source-map tokens; [`rewrite_stack`] uses the table to turn each frame
//! into `at <fn> (<file>:<line>)`. Bundler-internal frames (the bootstrap IIFE,
//! the registry `require`, preludes) fall outside every module range and are
//! dropped. When no table is present (e.g. a cache hit, where the bundle isn't
//! rebuilt) frames are still cleaned up — the synthetic bundle URL is stripped.

use std::cell::RefCell;
use std::path::PathBuf;

use crate::jsc::{JSContextRef, JSObjectRef, JSValueRef};

use crate::event_loop::{arg_slice, register};
use crate::node::js_string;
use crate::runtime::js_value_to_string;

/// The synthetic URL velox evaluates the bundle under (see `runtime::eval`).
pub const BUNDLE_URL: &str = "velox:///bundle.js";

/// Register `__velox_remap_stack(stack)` so JS (the console inspector) can map a
/// raw `error.stack` back to source lines via [`rewrite_stack`].
pub fn install(ctx: JSContextRef) {
    unsafe { register(ctx, c"__velox_remap_stack", remap_stack) };
}

/// `__velox_remap_stack(stackString) -> mappedString`.
unsafe extern "C-unwind" fn remap_stack(
    ctx: JSContextRef,
    _function: JSObjectRef,
    _this: JSObjectRef,
    argc: usize,
    argv: *mut JSValueRef,
    _exception: *mut JSValueRef,
) -> JSValueRef {
    let args = arg_slice(argc, argv);
    let input = args
        .first()
        .map(|v| unsafe { js_value_to_string(ctx, *v) })
        .unwrap_or_default();
    unsafe { js_string(ctx, &rewrite_stack(&input)) }
}

/// One module's placement in the bundle, for mapping bundle lines to source.
pub struct ModuleSpan {
    /// 1-based bundle line where the module body begins.
    pub start_line: u32,
    /// 1-based bundle line of the module body's last line (inclusive).
    pub end_line: u32,
    /// Lines prepended to the body beyond the codegen output (the `__esModule`
    /// line for ESM modules), which shift body lines vs the map.
    pub esm_shift: u32,
    /// Display path of the module's source file.
    pub file: String,
    /// `(gen_line, gen_col, src_line)` codegen tokens, all 0-based.
    pub tokens: Vec<(u32, u32, u32)>,
}

thread_local! {
    static TABLE: RefCell<Vec<ModuleSpan>> = const { RefCell::new(Vec::new()) };
}

/// Install the bundle's module table (called at the end of bundle emit).
pub fn set_table(spans: Vec<ModuleSpan>) {
    TABLE.with(|t| *t.borrow_mut() = spans);
}

/// Serialize the current table to JSON for the bundle cache (so a cache hit can
/// still map frames without rebundling). Compact, hand-rolled to avoid a serde
/// derive on `ModuleSpan`.
pub fn serialize_table() -> String {
    TABLE.with(|t| {
        let spans = t.borrow();
        let mut s = String::from("[");
        for (i, m) in spans.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&format!(
                "{{\"s\":{},\"e\":{},\"sh\":{},\"f\":{},\"t\":[",
                m.start_line,
                m.end_line,
                m.esm_shift,
                json_string(&m.file)
            ));
            for (j, tok) in m.tokens.iter().enumerate() {
                if j > 0 {
                    s.push(',');
                }
                s.push_str(&format!("[{},{},{}]", tok.0, tok.1, tok.2));
            }
            s.push_str("]}");
        }
        s.push(']');
        s
    })
}

/// Load a table previously written by [`serialize_table`] (on a cache hit).
pub fn load_serialized(json: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return;
    };
    let Some(arr) = value.as_array() else {
        return;
    };
    let mut spans = Vec::with_capacity(arr.len());
    for m in arr {
        let tokens = m["t"]
            .as_array()
            .map(|ts| {
                ts.iter()
                    .filter_map(|t| {
                        let a = t.as_array()?;
                        Some((
                            a.first()?.as_u64()? as u32,
                            a.get(1)?.as_u64()? as u32,
                            a.get(2)?.as_u64()? as u32,
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        spans.push(ModuleSpan {
            start_line: m["s"].as_u64().unwrap_or(0) as u32,
            end_line: m["e"].as_u64().unwrap_or(0) as u32,
            esm_shift: m["sh"].as_u64().unwrap_or(0) as u32,
            file: m["f"].as_str().unwrap_or("").to_string(),
            tokens,
        });
    }
    set_table(spans);
}

/// Minimal JSON string escaping for file paths.
fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            _ => out.push(ch),
        }
    }
    out.push('"');
    out
}

/// A source file's path relative to the cwd when possible, else as given.
pub fn display_path(path: Option<&PathBuf>) -> String {
    let Some(path) = path else {
        return String::new();
    };
    if let Ok(cwd) = std::env::current_dir()
        && let Ok(rel) = path.strip_prefix(&cwd)
    {
        return rel.to_string_lossy().into_owned();
    }
    path.to_string_lossy().into_owned()
}

/// Map a 1-based bundle `(line, col)` to `(file, source_line_1based)`.
fn map_position(spans: &[ModuleSpan], line: u32, col: u32) -> Option<(String, u32)> {
    let m = spans
        .iter()
        .find(|s| line >= s.start_line && line <= s.end_line)?;
    // 0-based codegen line within the module = bundle line − body start − shift.
    let gen_line = line.checked_sub(m.start_line)?.checked_sub(m.esm_shift)?;
    let col0 = col.saturating_sub(1);

    // Among tokens on this generated line, take the one with the greatest column
    // not past `col0`; if none precede it, take the line's first token.
    let mut chosen: Option<&(u32, u32, u32)> = None;
    for tok in m.tokens.iter().filter(|t| t.0 == gen_line) {
        let better = match chosen {
            None => true,
            Some(c) => {
                if tok.1 <= col0 {
                    c.1 > col0 || tok.1 > c.1
                } else {
                    c.1 > col0 && tok.1 < c.1
                }
            }
        };
        if better {
            chosen = Some(tok);
        }
    }
    chosen.map(|t| (m.file.clone(), t.2 + 1))
}

/// Parse a JSC stack frame `name@velox:///bundle.js:line:col`. Returns
/// `(name, line, col)` with an empty name for anonymous frames. `None` if the
/// line isn't a bundle frame.
fn parse_frame(line: &str) -> Option<(String, u32, u32)> {
    let rest = line.trim();
    let at = format!("@{BUNDLE_URL}:");
    let idx = rest.find(&at)?;
    let name = rest[..idx].trim();
    let pos = &rest[idx + at.len()..];
    let mut it = pos.split(':');
    let l: u32 = it.next()?.parse().ok()?;
    let c: u32 = it.next().unwrap_or("0").parse().unwrap_or(0);
    Some((name.to_string(), l, c))
}

/// Rewrite a raw JSC stack string: map bundle frames to `at fn (file:line)`,
/// drop bundler-internal frames, and (without a table) at least strip the
/// synthetic bundle URL. The first line (the `Error: message`) is preserved.
pub fn rewrite_stack(stack: &str) -> String {
    TABLE.with(|table| {
        let spans = table.borrow();
        let mut out: Vec<String> = Vec::new();
        for raw in stack.lines() {
            match parse_frame(raw) {
                Some((name, line, col)) => {
                    if let Some((file, src)) = map_position(&spans, line, col) {
                        out.push(frame_line(&name, &format!("{file}:{src}")));
                    } else if spans.is_empty() {
                        // No map (cache hit): keep the frame but drop the URL.
                        out.push(frame_line(&name, ""));
                    }
                    // Mapped table + unmapped frame ⇒ bundler glue ⇒ drop.
                }
                // Builtin frames (eval'd via `new Function`, so no bundle URL)
                // show as `name@` / `name@[native code]` — render them cleanly.
                None => match builtin_frame_name(raw) {
                    Some(name) => out.push(frame_line(&name, "")),
                    // Anything else (the leading message line) is kept verbatim.
                    None => out.push(raw.to_string()),
                },
            }
        }
        out.join("\n")
    })
}

/// Extract the function name from a positionless JSC frame (`name@` or
/// `name@[native code]`). Returns `None` for non-frame lines (e.g. the error
/// message), guarding against an `@` that merely appears in a message.
fn builtin_frame_name(line: &str) -> Option<String> {
    let (name, loc) = line.trim().rsplit_once('@')?;
    if !(loc.is_empty() || loc == "[native code]") {
        return None;
    }
    // Real function names carry no path/position separators.
    if name.contains('/') || name.contains(':') {
        return None;
    }
    Some(name.to_string())
}

/// Render one cleaned frame: `    at name (loc)` / `    at name` / `    at loc`.
fn frame_line(name: &str, loc: &str) -> String {
    let name = if name.is_empty() || name == "global code" {
        "<anonymous>"
    } else {
        name
    };
    if loc.is_empty() {
        format!("at {name}")
    } else {
        format!("at {name} ({loc})")
    }
}

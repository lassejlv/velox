//! `velox.lock` — a YAML lockfile pinning the resolved dependency graph for
//! reproducible installs. The schema is flat and regular, so it round-trips
//! through a small hand-written reader/writer (no YAML crate needed):
//!
//! ```yaml
//! lockfileVersion: 1
//! packages:
//!   "lodash":
//!     version: 4.18.1
//!     resolved: https://registry.npmjs.org/lodash/-/lodash-4.18.1.tgz
//!     integrity: sha512-…
//! ```

use std::path::Path;

use super::resolve::Resolved;
use super::semver::Version;

pub const LOCKFILE: &str = "velox.lock";

/// Write `resolved` to `velox.lock` (sorted by name). Removes a stale
/// `velox-lock.json` from the previous JSON format if present.
pub fn write(resolved: &[Resolved]) -> Result<(), String> {
    let mut sorted: Vec<&Resolved> = resolved.iter().collect();
    sorted.sort_by(|a, b| a.name.cmp(&b.name));

    let mut out = String::from("# velox lockfile — generated, do not edit by hand\n");
    out.push_str("lockfileVersion: 1\n");
    out.push_str("packages:\n");
    for r in sorted {
        out.push_str(&format!("  {}:\n", quote(&r.name)));
        out.push_str(&format!("    version: {}\n", r.version));
        out.push_str(&format!("    resolved: {}\n", r.tarball));
        if let Some(integrity) = &r.integrity {
            out.push_str(&format!("    integrity: {integrity}\n"));
        }
    }

    std::fs::write(LOCKFILE, out).map_err(|e| format!("write {LOCKFILE}: {e}"))?;
    let _ = std::fs::remove_file("velox-lock.json");
    Ok(())
}

/// Read `velox.lock` into resolvable entries, or None if absent/empty.
pub fn read() -> Option<Vec<Resolved>> {
    let text = std::fs::read_to_string(LOCKFILE).ok()?;
    let mut entries: Vec<Resolved> = Vec::new();
    let mut in_packages = false;
    let mut name: Option<String> = None;
    let mut version: Option<String> = None;
    let mut resolved: Option<String> = None;
    let mut integrity: Option<String> = None;

    let flush = |entries: &mut Vec<Resolved>,
                 name: &Option<String>,
                 version: &Option<String>,
                 resolved: &Option<String>,
                 integrity: &Option<String>| {
        if let (Some(n), Some(v), Some(r)) = (name, version, resolved)
            && let Some(ver) = Version::parse(v)
        {
            entries.push(Resolved {
                name: n.clone(),
                version: ver,
                tarball: r.clone(),
                integrity: integrity.clone(),
                shasum: None,
            });
        }
    };

    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if trimmed == "packages:" {
            in_packages = true;
            continue;
        }
        if !in_packages {
            continue;
        }
        // A package key: 2-space indent, ends with `:`.
        if line.starts_with("  ") && !line.starts_with("    ") && trimmed.ends_with(':') {
            flush(&mut entries, &name, &version, &resolved, &integrity);
            name = Some(unquote(trimmed.trim_end_matches(':').trim()));
            version = None;
            resolved = None;
            integrity = None;
        } else if line.starts_with("    ") {
            if let Some(v) = trimmed.strip_prefix("version:") {
                version = Some(unquote(v.trim()));
            } else if let Some(v) = trimmed.strip_prefix("resolved:") {
                resolved = Some(unquote(v.trim()));
            } else if let Some(v) = trimmed.strip_prefix("integrity:") {
                integrity = Some(unquote(v.trim()));
            }
        }
    }
    flush(&mut entries, &name, &version, &resolved, &integrity);

    if entries.is_empty() {
        None
    } else {
        Some(entries)
    }
}

/// Drop the named packages from `velox.lock` (used by `velox remove`). No-op if
/// there is no lockfile.
pub fn remove_names(names: &[String]) {
    if !Path::new(LOCKFILE).exists() {
        return;
    }
    let Some(mut entries) = read() else { return };
    entries.retain(|e| !names.contains(&e.name));
    let _ = write(&entries);
}

/// Quote a mapping key as a double-quoted YAML scalar.
fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Strip optional surrounding single/double quotes.
fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s[1..s.len() - 1]
            .replace("\\\"", "\"")
            .replace("\\\\", "\\")
    } else {
        s.to_string()
    }
}

//! Dependency resolution: walk the `dependencies` graph from a set of roots and
//! choose one version per package (a flat `node_modules`, like npm's hoisting
//! for the common, conflict-free case). Conflicts resolve to the higher version
//! with a warning — velox does not nest duplicate versions.

use std::collections::{BTreeMap, VecDeque};

use owo_colors::OwoColorize;
use serde_json::Value;

use super::registry;
use super::semver::{Range, Version};

#[derive(Debug, Clone)]
pub struct Resolved {
    pub name: String,
    pub version: Version,
    pub tarball: String,
    /// `dist.integrity` (sha512, base64) when the registry provides it.
    pub integrity: Option<String>,
    /// `dist.shasum` (sha1, hex) fallback.
    pub shasum: Option<String>,
}

/// Resolve the full transitive closure of `roots` (name, range pairs).
/// Returns one [`Resolved`] per package name.
pub fn resolve(roots: &[(String, String)]) -> Result<Vec<Resolved>, String> {
    let mut cache: BTreeMap<String, Value> = BTreeMap::new();
    let mut chosen: BTreeMap<String, Resolved> = BTreeMap::new();
    let mut queue: VecDeque<(String, String)> = roots.iter().cloned().collect();

    while let Some((name, range_str)) = queue.pop_front() {
        // Skip if we already picked a version that satisfies this range.
        if let Some(existing) = chosen.get(&name)
            && range_matches(&range_str, &existing.version)
        {
            continue;
        }

        let meta = match cache.get(&name) {
            Some(m) => m,
            None => {
                let m = registry::fetch_metadata(&name)?;
                cache.entry(name.clone()).or_insert(m)
            }
        };

        let version = pick_version(meta, &range_str)
            .ok_or_else(|| format!("no version of {name} satisfies \"{range_str}\""))?;
        let vmeta = &meta["versions"][version.to_string()];
        let dist = &vmeta["dist"];
        let tarball = dist["tarball"]
            .as_str()
            .ok_or_else(|| format!("{name}@{version} has no tarball"))?
            .to_string();

        // Conflict handling: keep the higher version, warn once.
        if let Some(existing) = chosen.get(&name) {
            if existing.version >= version {
                continue;
            }
            eprintln!(
                "  {} {name}: {} and {} both required — using {}",
                "!".yellow(),
                existing.version,
                version,
                version
            );
        }

        let resolved = Resolved {
            name: name.clone(),
            version: version.clone(),
            tarball,
            integrity: dist["integrity"].as_str().map(String::from),
            shasum: dist["shasum"].as_str().map(String::from),
        };
        chosen.insert(name.clone(), resolved);

        // Enqueue runtime dependencies of the chosen version.
        if let Some(deps) = vmeta["dependencies"].as_object() {
            for (dep, dep_range) in deps {
                let r = dep_range.as_str().unwrap_or("*").to_string();
                // Skip non-registry specifiers (git/url/file/workspace).
                if is_registry_range(&r) {
                    queue.push_back((dep.clone(), r));
                }
            }
        }
    }

    Ok(chosen.into_values().collect())
}

/// Choose the best version of a package for `range`, honoring dist-tags.
fn pick_version(meta: &Value, range_str: &str) -> Option<Version> {
    // A dist-tag like `latest`/`next`.
    if let Some(tag) = meta["dist-tags"].get(range_str).and_then(|v| v.as_str())
        && let Some(v) = Version::parse(tag)
    {
        return Some(v);
    }
    let versions: Vec<Version> = meta["versions"]
        .as_object()
        .map(|o| o.keys().filter_map(|k| Version::parse(k)).collect())
        .unwrap_or_default();
    let range = Range::parse(range_str);
    let best = range.max_satisfying(&versions).cloned();
    // Empty/`*` ranges fall back to the `latest` dist-tag, then the max version.
    best.or_else(|| {
        meta["dist-tags"]["latest"]
            .as_str()
            .and_then(Version::parse)
    })
    .or_else(|| versions.iter().max().cloned())
}

fn range_matches(range_str: &str, v: &Version) -> bool {
    // Treat dist-tags as "any" for the satisfied check.
    if matches!(range_str, "latest" | "next" | "*" | "") {
        return true;
    }
    Range::parse(range_str).matches(v)
}

/// Whether a dependency range refers to the npm registry (vs git/url/file/etc.).
fn is_registry_range(range: &str) -> bool {
    let r = range.trim();
    !(r.contains('/') && (r.contains(':') || r.starts_with("git") || r.starts_with("file")))
        && !r.starts_with("workspace:")
        && !r.starts_with("link:")
        && !r.starts_with("npm:")
}

//! Dependency resolution: walk the `dependencies` graph from a set of roots and
//! choose one version per package (a flat `node_modules`, like npm's hoisting
//! for the common, conflict-free case). Conflicts resolve to the higher version
//! with a warning — velox does not nest duplicate versions.

use std::collections::{BTreeMap, BTreeSet};

use owo_colors::OwoColorize;
use serde_json::Value;

use super::parallel::par_map;
use super::registry;
use super::semver::{Range, Version};

/// How many registry metadata requests to run concurrently per BFS wave.
const FETCH_WORKERS: usize = 16;

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
/// Returns one [`Resolved`] per package name. Each BFS wave fetches the
/// frontier's registry metadata concurrently.
pub fn resolve(roots: &[(String, String)]) -> Result<Vec<Resolved>, String> {
    let mut chosen: BTreeMap<String, Resolved> = BTreeMap::new();
    let mut frontier: Vec<(String, String)> = roots.to_vec();

    while !frontier.is_empty() {
        // Dedup this wave by name; drop names already satisfied by `chosen`.
        let mut wave: Vec<(String, String)> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for (name, range) in std::mem::take(&mut frontier) {
            if seen.contains(&name) {
                continue;
            }
            if let Some(existing) = chosen.get(&name)
                && range_matches(&range, &existing.version)
            {
                continue;
            }
            seen.insert(name.clone());
            wave.push((name, range));
        }
        if wave.is_empty() {
            break;
        }

        // Fetch the whole wave's metadata in parallel.
        let fetched = par_map(wave, FETCH_WORKERS, |(name, range)| {
            let meta = registry::fetch_metadata(&name);
            (name, range, meta)
        });

        let mut next: Vec<(String, String)> = Vec::new();
        for (name, range, meta_res) in fetched {
            let meta = meta_res?;
            let version = pick_version(&meta, &range)
                .ok_or_else(|| format!("no version of {name} satisfies \"{range}\""))?;
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

            chosen.insert(
                name.clone(),
                Resolved {
                    name: name.clone(),
                    version: version.clone(),
                    tarball,
                    integrity: dist["integrity"].as_str().map(String::from),
                    shasum: dist["shasum"].as_str().map(String::from),
                },
            );

            // Queue runtime dependencies for the next wave.
            if let Some(deps) = vmeta["dependencies"].as_object() {
                for (dep, dep_range) in deps {
                    let r = dep_range.as_str().unwrap_or("*").to_string();
                    if is_registry_range(&r) {
                        next.push((dep.clone(), r));
                    }
                }
            }
        }
        frontier = next;
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
pub fn is_registry_range(range: &str) -> bool {
    let r = range.trim();
    !(r.contains('/') && (r.contains(':') || r.starts_with("git") || r.starts_with("file")))
        && !r.starts_with("workspace:")
        && !r.starts_with("link:")
        && !r.starts_with("npm:")
}

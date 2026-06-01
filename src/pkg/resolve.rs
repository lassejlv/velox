//! Dependency resolution: walk the `dependencies` graph from a set of roots and
//! hoist one version per package into the root `node_modules` (npm-style), and
//! when a package needs a version range the hoisted one doesn't satisfy, install
//! the conflicting version (and any of its deps the root can't satisfy) *nested*
//! under that package's own `node_modules` — so the module resolver, which walks
//! up from the importer, finds the right one (e.g. lazystream needs
//! `readable-stream@^2` while another dep pins `readable-stream@^4`).

use std::collections::{BTreeMap, BTreeSet};

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
    /// When `Some(parent)`, install nested at `<parent>/node_modules/<name>`
    /// instead of the root `node_modules` (its required range conflicts with the
    /// hoisted version).
    pub nest_under: Option<String>,
}

/// Resolve the full transitive closure of `roots` (name, range pairs), hoisting
/// one version per name and nesting conflicting versions under their dependents.
pub fn resolve(roots: &[(String, String)]) -> Result<Vec<Resolved>, String> {
    let (mut chosen, edges) = resolve_flat(roots)?;

    // Find dependency edges the hoisted version can't satisfy, and nest the
    // conflicting subtree under the dependent. `nested` is keyed by
    // (parent, name) so each dependent nests at most one version per dep.
    let mut nested: BTreeMap<(String, String), Resolved> = BTreeMap::new();
    let mut conflicts: Vec<Edge> = Vec::new();
    for (parent, dep, range) in &edges {
        if parent.is_empty() {
            continue; // a root edge: the hoisted version *is* the install
        }
        let satisfied = chosen
            .get(dep)
            .is_some_and(|h| range_matches(range, &h.version));
        if !satisfied {
            conflicts.push((parent.clone(), dep.clone(), range.clone()));
        }
    }

    for (parent, dep, range) in conflicts {
        if nested.contains_key(&(parent.clone(), dep.clone())) {
            continue;
        }
        // Resolve the conflicting dependency's own closure. Packages the root
        // already has at the same version are reused (the resolver walks up);
        // packages the root lacks are hoisted; the rest nest under `parent`.
        let (subtree, _) = resolve_flat(&[(dep.clone(), range.clone())])?;
        for (name, sub) in subtree {
            match chosen.get(&name) {
                Some(root) if root.version == sub.version => {} // root copy works
                Some(_) => {
                    // Root has a different version → nest this one under `parent`.
                    nested.insert(
                        (parent.clone(), name.clone()),
                        Resolved {
                            nest_under: Some(parent.clone()),
                            ..sub
                        },
                    );
                }
                None => {
                    // Root doesn't have it at all → hoist (no conflict).
                    chosen.insert(name.clone(), sub);
                }
            }
        }
    }

    let mut out: Vec<Resolved> = chosen.into_values().collect();
    out.extend(nested.into_values());
    Ok(out)
}

/// A dependency edge: `(parent, dependency, range)`; `parent` is empty for the
/// root requirements.
type Edge = (String, String, String);

/// The core BFS: hoist one version per name into a flat map, also returning every
/// `(parent, dependency, range)` edge so conflicts can be detected afterward.
fn resolve_flat(
    roots: &[(String, String)],
) -> Result<(BTreeMap<String, Resolved>, Vec<Edge>), String> {
    let mut chosen: BTreeMap<String, Resolved> = BTreeMap::new();
    let mut edges: Vec<(String, String, String)> = Vec::new();
    let mut frontier: Vec<(String, String, String)> = roots
        .iter()
        .map(|(n, r)| (String::new(), n.clone(), r.clone()))
        .collect();

    while !frontier.is_empty() {
        // Dedup this wave by name; drop names already satisfied by `chosen`.
        let mut wave: Vec<(String, String)> = Vec::new();
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for (parent, name, range) in std::mem::take(&mut frontier) {
            edges.push((parent, name.clone(), range.clone()));
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

        let mut next: Vec<(String, String, String)> = Vec::new();
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

            // Conflict handling: keep the higher version hoisted (the lower one,
            // if incompatible, is nested by the caller).
            if let Some(existing) = chosen.get(&name)
                && existing.version >= version
            {
                continue;
            }

            chosen.insert(
                name.clone(),
                Resolved {
                    name: name.clone(),
                    version: version.clone(),
                    tarball,
                    integrity: dist["integrity"].as_str().map(String::from),
                    shasum: dist["shasum"].as_str().map(String::from),
                    nest_under: None,
                },
            );

            // Queue runtime dependencies for the next wave.
            if let Some(deps) = vmeta["dependencies"].as_object() {
                for (dep, dep_range) in deps {
                    let r = dep_range.as_str().unwrap_or("*").to_string();
                    if is_registry_range(&r) {
                        next.push((name.clone(), dep.clone(), r));
                    }
                }
            }
            // Auto-install non-optional peer dependencies (npm 7+ behavior), so
            // plugin ecosystems (graphql, eslint, …) get their required peer.
            let peer_meta = vmeta["peerDependenciesMeta"].as_object();
            if let Some(peers) = vmeta["peerDependencies"].as_object() {
                for (dep, dep_range) in peers {
                    let optional = peer_meta
                        .and_then(|m| m.get(dep))
                        .and_then(|o| o["optional"].as_bool())
                        .unwrap_or(false);
                    let r = dep_range.as_str().unwrap_or("*").to_string();
                    if !optional && is_registry_range(&r) {
                        next.push((name.clone(), dep.clone(), r));
                    }
                }
            }
        }
        frontier = next;
    }

    Ok((chosen, edges))
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

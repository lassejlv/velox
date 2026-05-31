//! A global, on-disk tarball cache shared across every project. Downloaded
//! `.tgz` archives are stored under `$VELOX_CACHE` (or `~/.velox/cache`), keyed
//! by `name/version.tgz`, so re-installing the same package — in this project or
//! any other — skips the network entirely. Entries are always re-verified
//! against their integrity hash by the caller, so a corrupt cache file is
//! detected and re-fetched.

use std::path::PathBuf;

/// Root of the cache, or None if no home directory is available.
pub fn root() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("VELOX_CACHE") {
        return Some(PathBuf::from(dir));
    }
    std::env::var("HOME")
        .ok()
        .map(|h| PathBuf::from(h).join(".velox").join("cache"))
}

fn tarball_path(name: &str, version: &str) -> Option<PathBuf> {
    root().map(|r| r.join("tarballs").join(name).join(format!("{version}.tgz")))
}

/// Read a cached tarball, if present.
pub fn read(name: &str, version: &str) -> Option<Vec<u8>> {
    std::fs::read(tarball_path(name, version)?).ok()
}

/// Store a tarball in the cache (best-effort — failures are ignored).
pub fn write(name: &str, version: &str, bytes: &[u8]) {
    if let Some(path) = tarball_path(name, version) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, bytes);
    }
}

// --- registry metadata cache ------------------------------------------------
//
// Package *metadata* (the version document) is cached separately from tarballs,
// with a freshness TTL — re-resolving the same graph (every `add`/`install`
// without a lockfile) is otherwise dozens of network round-trips. Default TTL
// is 10 minutes; override with `$VELOX_METADATA_TTL` (seconds, 0 disables).

fn metadata_path(name: &str) -> Option<PathBuf> {
    root().map(|r| r.join("metadata").join(format!("{name}.json")))
}

fn metadata_ttl() -> u64 {
    std::env::var("VELOX_METADATA_TTL")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(600)
}

/// Cached metadata bytes if present and fresher than the TTL.
pub fn read_metadata(name: &str) -> Option<Vec<u8>> {
    let path = metadata_path(name)?;
    let meta = std::fs::metadata(&path).ok()?;
    let age = meta.modified().ok()?.elapsed().ok()?.as_secs();
    if age <= metadata_ttl() {
        std::fs::read(&path).ok()
    } else {
        None
    }
}

/// Cached metadata bytes regardless of age (used as an offline fallback when the
/// network is unreachable).
pub fn read_metadata_stale(name: &str) -> Option<Vec<u8>> {
    std::fs::read(metadata_path(name)?).ok()
}

/// Store package metadata (best-effort).
pub fn write_metadata(name: &str, bytes: &[u8]) {
    if let Some(path) = metadata_path(name) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, bytes);
    }
}

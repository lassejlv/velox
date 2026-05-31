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

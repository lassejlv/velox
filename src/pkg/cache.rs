use std::fs;
use std::fs::File;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const CACHE_ENV_VAR: &str = "VELOX_PKG_CACHE_DIR";
const METADATA_CACHE_DIR: &str = "metadata";
const TARBALL_CACHE_DIR: &str = "tarballs";

pub(super) fn ensure_cache_dirs() -> Result<PathBuf, String> {
    let root = cache_root();
    fs::create_dir_all(root.join(METADATA_CACHE_DIR))
        .map_err(|e| format!("Failed to create metadata cache dir: {}", e))?;
    fs::create_dir_all(root.join(TARBALL_CACHE_DIR))
        .map_err(|e| format!("Failed to create tarball cache dir: {}", e))?;
    Ok(root)
}

fn cache_root() -> PathBuf {
    if let Ok(path) = std::env::var(CACHE_ENV_VAR) {
        return PathBuf::from(path);
    }
    if let Ok(home) = std::env::var("HOME") {
        return Path::new(&home).join(".cache").join("velox").join("pkg");
    }
    std::env::temp_dir().join("velox-pkg-cache")
}

pub(super) fn cache_root_path() -> PathBuf {
    cache_root()
}

pub(super) fn clear_all_cache() -> Result<(), String> {
    let root = cache_root();
    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|e| format!("Failed to remove cache directory {}: {}", root.display(), e))?;
    }
    Ok(())
}

pub(super) fn cache_stats() -> Result<(u64, u64), String> {
    let root = cache_root();
    if !root.exists() {
        return Ok((0, 0));
    }
    calc_dir_stats(&root)
}

fn calc_dir_stats(path: &Path) -> Result<(u64, u64), String> {
    let mut files = 0u64;
    let mut bytes = 0u64;

    let entries = fs::read_dir(path)
        .map_err(|e| format!("Failed to read cache path {}: {}", path.display(), e))?;

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if meta.is_dir() {
            let (f, b) = calc_dir_stats(&p)?;
            files += f;
            bytes += b;
        } else if meta.is_file() {
            files += 1;
            bytes += meta.len();
        }
    }

    Ok((files, bytes))
}

pub(super) fn encode_registry_name(name: &str) -> String {
    name.replace('/', "%2F")
}

pub(super) fn metadata_cache_path(cache_root: &Path, package_name: &str) -> PathBuf {
    let encoded = encode_registry_name(package_name).replace('%', "_");
    cache_root
        .join(METADATA_CACHE_DIR)
        .join(format!("{}.json", encoded))
}

pub(super) fn tarball_cache_path(cache_root: &Path, tarball_url: &str) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    tarball_url.hash(&mut hasher);
    let digest = hasher.finish();
    cache_root
        .join(TARBALL_CACHE_DIR)
        .join(format!("{:016x}.tgz", digest))
}

pub(super) fn x_cache_dir_for_spec(cache_root: &Path, package_spec: &str) -> PathBuf {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    package_spec.hash(&mut hasher);
    let digest = hasher.finish();
    cache_root.join("x").join(format!("{:016x}", digest))
}

pub(super) fn download_to_file(url: &str, target: &Path) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create cache parent {}: {}", parent.display(), e))?;
    }

    let response = ureq::get(url)
        .call()
        .map_err(|e| format!("Failed to download tarball {}: {}", url, e))?;
    let mut reader = response.into_reader();

    let tmp = target.with_extension("tgz.part");
    let mut out = File::create(&tmp)
        .map_err(|e| format!("Failed to create temp cache file {}: {}", tmp.display(), e))?;
    std::io::copy(&mut reader, &mut out)
        .map_err(|e| format!("Failed to write tarball cache {}: {}", tmp.display(), e))?;
    fs::rename(&tmp, target).map_err(|e| {
        format!(
            "Failed to finalize tarball cache {} -> {}: {}",
            tmp.display(),
            target.display(),
            e
        )
    })?;
    Ok(())
}

pub(super) fn create_temp_dir(package_name: &str) -> Result<PathBuf, String> {
    let sanitized = package_name.replace('/', "_").replace('@', "");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);

    let path = std::env::temp_dir().join(format!("velox-pkg-{}-{}", sanitized, nanos));
    fs::create_dir_all(&path)
        .map_err(|e| format!("Failed to create temp directory {}: {}", path.display(), e))?;
    Ok(path)
}

pub(super) fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst)
        .map_err(|e| format!("Failed to create destination {}: {}", dst.display(), e))?;

    for entry in
        fs::read_dir(src).map_err(|e| format!("Failed to read source {}: {}", src.display(), e))?
    {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());

        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(|e| {
                format!(
                    "Failed to copy {} to {}: {}",
                    entry.path().display(),
                    target.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

pub(super) fn find_unpacked_root(temp_root: &Path) -> Option<PathBuf> {
    let standard = temp_root.join("package");
    if standard.exists() && standard.is_dir() {
        return Some(standard);
    }

    let mut dirs = fs::read_dir(temp_root)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_type().ok().filter(|t| t.is_dir()).map(|_| e.path()))
        .collect::<Vec<_>>();

    if dirs.len() == 1 {
        return dirs.pop();
    }

    None
}

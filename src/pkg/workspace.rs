//! Monorepo workspace support — npm/yarn (`"workspaces"` in package.json) and
//! pnpm (`pnpm-workspace.yaml`). Discovers member packages from glob patterns so
//! the installer can resolve every member's dependencies together, hoist them
//! into the root `node_modules`, and symlink the members so cross-package
//! imports resolve.

use std::path::{Path, PathBuf};

use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Member {
    pub name: String,
    pub dir: PathBuf,
    pub manifest: Value,
}

/// A discovered workspace and its member packages.
#[derive(Debug, Clone)]
pub struct Workspace {
    pub members: Vec<Member>,
}

impl Workspace {
    /// Names of all member packages (these resolve locally, not from the registry).
    pub fn member_names(&self) -> Vec<String> {
        self.members.iter().map(|m| m.name.clone()).collect()
    }
}

/// The glob patterns declared by a workspace root, or None if `dir` is not a
/// workspace root. npm reads `package.json` `"workspaces"`; pnpm reads
/// `pnpm-workspace.yaml`.
fn workspace_globs(dir: &Path) -> Option<Vec<String>> {
    // pnpm-workspace.yaml takes precedence when present.
    let pnpm = dir.join("pnpm-workspace.yaml");
    if let Ok(text) = std::fs::read_to_string(&pnpm) {
        return Some(parse_pnpm_packages(&text));
    }
    let manifest = std::fs::read_to_string(dir.join("package.json")).ok()?;
    let value: Value = serde_json::from_str(&manifest).ok()?;
    match &value["workspaces"] {
        Value::Array(arr) => Some(
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
        ),
        // Yarn object form: `{ "packages": [...] }`.
        Value::Object(obj) => obj["packages"].as_array().map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        }),
        _ => None,
    }
}

/// True if `dir` declares a workspace.
pub fn is_workspace_root(dir: &Path) -> bool {
    workspace_globs(dir).is_some_and(|g| !g.is_empty())
}

/// Discover the workspace rooted at `root`, if any.
pub fn discover(root: &Path) -> Option<Workspace> {
    let globs = workspace_globs(root)?;
    let mut members = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for glob in &globs {
        for dir in expand_glob(root, glob) {
            if !seen.insert(dir.clone()) {
                continue;
            }
            let manifest_path = dir.join("package.json");
            let Ok(text) = std::fs::read_to_string(&manifest_path) else {
                continue;
            };
            let Ok(manifest): Result<Value, _> = serde_json::from_str(&text) else {
                continue;
            };
            let Some(name) = manifest["name"].as_str() else {
                continue;
            };
            members.push(Member {
                name: name.to_string(),
                dir,
                manifest,
            });
        }
    }
    Some(Workspace { members })
}

/// Walk up from `start` to find the nearest workspace root, if any.
pub fn find_root(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if is_workspace_root(dir) {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

/// Expand a workspace glob (relative to `root`) into matching directories that
/// contain a `package.json`. Supports a trailing `*`/`**` segment and literal
/// path segments — the patterns npm/pnpm workspaces use in practice.
fn expand_glob(root: &Path, pattern: &str) -> Vec<PathBuf> {
    let pattern = pattern.trim().trim_end_matches('/');
    let segments: Vec<&str> = pattern.split('/').collect();
    let mut dirs = vec![root.to_path_buf()];
    for seg in segments {
        let mut next = Vec::new();
        match seg {
            "*" | "**" => {
                for dir in &dirs {
                    if let Ok(entries) = std::fs::read_dir(dir) {
                        for entry in entries.flatten() {
                            let p = entry.path();
                            if p.is_dir() && !is_hidden(&p) {
                                next.push(p);
                            }
                        }
                    }
                }
            }
            literal => {
                for dir in &dirs {
                    let p = dir.join(literal);
                    if p.is_dir() {
                        next.push(p);
                    }
                }
            }
        }
        dirs = next;
    }
    dirs.into_iter()
        .filter(|d| d.join("package.json").is_file())
        .collect()
}

fn is_hidden(p: &Path) -> bool {
    p.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with('.') || n == "node_modules")
}

/// Parse the `packages:` list from a `pnpm-workspace.yaml`.
fn parse_pnpm_packages(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_packages = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        if trimmed == "packages:" || line.starts_with("packages:") {
            in_packages = true;
            continue;
        }
        if in_packages {
            if let Some(item) = trimmed.strip_prefix('-') {
                out.push(unquote(item.trim()));
            } else if !line.starts_with([' ', '\t']) {
                // A new top-level key ends the packages list.
                in_packages = false;
            }
        }
    }
    out
}

fn unquote(s: &str) -> String {
    let s = s.trim();
    if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
        || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
    {
        s[1..s.len() - 1].to_string()
    } else {
        s.to_string()
    }
}

/// Create a symlink at `link` pointing to `target` (replacing any existing
/// entry). Used to link workspace members into `node_modules`.
pub fn symlink_dir(target: &Path, link: &Path) -> Result<(), String> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    // Remove an existing file/symlink/dir at the link path.
    let _ = std::fs::remove_file(link);
    let _ = std::fs::remove_dir_all(link);
    std::os::unix::fs::symlink(target, link)
        .map_err(|e| format!("symlink {} -> {}: {e}", link.display(), target.display()))
}

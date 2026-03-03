//! Permissions system for Velox runtime
//!
//! Provides Deno-like security controls:
//! - `--allow-read[=<path>]` - Allow file system read access
//! - `--allow-write[=<path>]` - Allow file system write access
//! - `--allow-net[=<host>]` - Allow network access
//! - `--allow-run[=<program>]` - Allow running subprocesses
//! - `--allow-env[=<var>]` - Allow environment variable access
//! - `--allow-all` or `-A` - Allow all permissions

use std::collections::HashSet;
use std::path::Path;
use std::sync::RwLock;

/// Permission types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PermissionKind {
    Read,
    Write,
    Net,
    Run,
    Env,
}

impl std::fmt::Display for PermissionKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PermissionKind::Read => write!(f, "read"),
            PermissionKind::Write => write!(f, "write"),
            PermissionKind::Net => write!(f, "net"),
            PermissionKind::Run => write!(f, "run"),
            PermissionKind::Env => write!(f, "env"),
        }
    }
}

/// Permission state for a single permission type
#[derive(Debug, Clone)]
pub struct Permission {
    /// Full access granted (no restrictions)
    pub allow_all: bool,
    /// Specific allowed values (paths, hosts, programs, env vars)
    pub allowed: HashSet<String>,
}

impl Default for Permission {
    fn default() -> Self {
        Self {
            allow_all: false,
            allowed: HashSet::new(),
        }
    }
}

impl Permission {
    /// Check if access is allowed for a specific value
    pub fn check(&self, value: Option<&str>) -> bool {
        if self.allow_all {
            return true;
        }
        match value {
            Some(v) => self.allowed.contains(v) || self.check_prefix(v),
            None => false,
        }
    }

    /// Check if a path is allowed by checking parent directories
    fn check_prefix(&self, value: &str) -> bool {
        // For path-based permissions, check if any allowed path is a prefix
        let path = Path::new(value);
        for allowed in &self.allowed {
            let allowed_path = Path::new(allowed);
            if path.starts_with(allowed_path) {
                return true;
            }
        }
        false
    }
}

/// Global permissions state
#[derive(Debug, Default)]
pub struct Permissions {
    pub read: Permission,
    pub write: Permission,
    pub net: Permission,
    pub run: Permission,
    pub env: Permission,
    /// Whether permissions are enabled (false = allow all by default)
    pub enabled: bool,
}

impl Permissions {
    /// Create new permissions with everything denied
    pub fn new() -> Self {
        Self {
            enabled: true,
            ..Default::default()
        }
    }

    /// Create permissions with everything allowed (for backward compatibility)
    pub fn allow_all() -> Self {
        Self {
            read: Permission {
                allow_all: true,
                allowed: HashSet::new(),
            },
            write: Permission {
                allow_all: true,
                allowed: HashSet::new(),
            },
            net: Permission {
                allow_all: true,
                allowed: HashSet::new(),
            },
            run: Permission {
                allow_all: true,
                allowed: HashSet::new(),
            },
            env: Permission {
                allow_all: true,
                allowed: HashSet::new(),
            },
            enabled: false,
        }
    }

    /// Get permission for a kind
    pub fn get(&self, kind: PermissionKind) -> &Permission {
        match kind {
            PermissionKind::Read => &self.read,
            PermissionKind::Write => &self.write,
            PermissionKind::Net => &self.net,
            PermissionKind::Run => &self.run,
            PermissionKind::Env => &self.env,
        }
    }

    /// Get mutable permission for a kind
    pub fn get_mut(&mut self, kind: PermissionKind) -> &mut Permission {
        match kind {
            PermissionKind::Read => &mut self.read,
            PermissionKind::Write => &mut self.write,
            PermissionKind::Net => &mut self.net,
            PermissionKind::Run => &mut self.run,
            PermissionKind::Env => &mut self.env,
        }
    }
}

// Global permissions state
static PERMISSIONS: RwLock<Option<Permissions>> = RwLock::new(None);

/// Initialize global permissions
pub fn init(permissions: Permissions) {
    let mut perms = PERMISSIONS.write().unwrap();
    *perms = Some(permissions);
}

/// Reset permissions (useful for tests)
#[cfg(test)]
#[allow(dead_code)]
pub fn reset() {
    let mut perms = PERMISSIONS.write().unwrap();
    *perms = None;
}

/// Check if a permission is allowed
pub fn check(kind: PermissionKind, value: Option<&str>) -> Result<(), String> {
    let perms = PERMISSIONS.read().unwrap();

    match perms.as_ref() {
        None => Ok(()), // No permissions set = allow all (backward compatibility)
        Some(p) if !p.enabled => Ok(()), // Permissions disabled = allow all
        Some(p) => {
            let perm = p.get(kind);
            if perm.check(value) {
                Ok(())
            } else {
                let detail = value.map(|v| format!(" to '{}'", v)).unwrap_or_default();
                Err(format!(
                    "Requires {} access{}, run with --allow-{} flag",
                    kind, detail, kind
                ))
            }
        }
    }
}

/// Check read permission for a path
pub fn check_read(path: &str) -> Result<(), String> {
    // Normalize the path for checking
    let normalized = normalize_path(path);
    check(PermissionKind::Read, Some(&normalized))
}

/// Check write permission for a path
pub fn check_write(path: &str) -> Result<(), String> {
    let normalized = normalize_path(path);
    check(PermissionKind::Write, Some(&normalized))
}

/// Check net permission for a host
pub fn check_net(host: &str) -> Result<(), String> {
    check(PermissionKind::Net, Some(host))
}

/// Check run permission for a program
pub fn check_run(program: &str) -> Result<(), String> {
    check(PermissionKind::Run, Some(program))
}

/// Check env permission for a variable
pub fn check_env(var: &str) -> Result<(), String> {
    check(PermissionKind::Env, Some(var))
}

/// Normalize a path for permission checking
fn normalize_path(path: &str) -> String {
    // Try to canonicalize, fall back to the original path
    match std::fs::canonicalize(path) {
        Ok(p) => p.to_string_lossy().to_string(),
        Err(_) => {
            // Path doesn't exist yet (write operations), normalize manually
            let p = Path::new(path);
            if p.is_absolute() {
                path.to_string()
            } else {
                // Make it absolute relative to cwd
                match std::env::current_dir() {
                    Ok(cwd) => cwd.join(path).to_string_lossy().to_string(),
                    Err(_) => path.to_string(),
                }
            }
        }
    }
}

/// Parse permission flags from command line arguments
/// Returns (Permissions, remaining_args)
pub fn parse_flags(args: &[String]) -> (Permissions, Vec<String>) {
    let mut perms = Permissions::new();
    let mut remaining = Vec::new();
    let mut has_permission_flags = false;

    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];

        if arg == "--allow-all" || arg == "-A" {
            has_permission_flags = true;
            perms = Permissions::allow_all();
            perms.enabled = true; // Mark as explicitly set
            i += 1;
            continue;
        }

        if let Some(rest) = arg.strip_prefix("--allow-") {
            has_permission_flags = true;
            let (kind, value) = parse_permission_arg(rest);

            if let Some(k) = kind {
                let perm = perms.get_mut(k);
                match value {
                    Some(v) => {
                        // Specific value allowed
                        // Handle comma-separated values
                        for val in v.split(',') {
                            // Normalize paths for read/write permissions
                            let normalized =
                                if k == PermissionKind::Read || k == PermissionKind::Write {
                                    normalize_path(val)
                                } else {
                                    val.to_string()
                                };
                            perm.allowed.insert(normalized);
                        }
                    }
                    None => {
                        // Full access
                        perm.allow_all = true;
                    }
                }
            }
            i += 1;
            continue;
        }

        remaining.push(arg.clone());
        i += 1;
    }

    // If no permission flags were provided, disable the permission system
    // for backward compatibility
    if !has_permission_flags {
        perms.enabled = false;
    }

    (perms, remaining)
}

/// Parse a permission argument like "read=/path" or "net=localhost:3000"
fn parse_permission_arg(arg: &str) -> (Option<PermissionKind>, Option<&str>) {
    let (name, value) = if let Some(idx) = arg.find('=') {
        (&arg[..idx], Some(&arg[idx + 1..]))
    } else {
        (arg, None)
    };

    let kind = match name {
        "read" => Some(PermissionKind::Read),
        "write" => Some(PermissionKind::Write),
        "net" => Some(PermissionKind::Net),
        "run" => Some(PermissionKind::Run),
        "env" => Some(PermissionKind::Env),
        _ => None,
    };

    (kind, value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_allow_all() {
        let args = vec!["--allow-all".to_string(), "script.ts".to_string()];
        let (perms, remaining) = parse_flags(&args);

        assert!(perms.read.allow_all);
        assert!(perms.write.allow_all);
        assert!(perms.net.allow_all);
        assert!(perms.run.allow_all);
        assert!(perms.env.allow_all);
        assert_eq!(remaining, vec!["script.ts"]);
    }

    #[test]
    fn test_parse_specific_permissions() {
        let args = vec![
            "--allow-read=/tmp".to_string(),
            "--allow-net=localhost".to_string(),
            "script.ts".to_string(),
        ];
        let (perms, remaining) = parse_flags(&args);

        assert!(!perms.read.allow_all);
        assert!(perms.read.allowed.contains("/tmp"));
        assert!(!perms.net.allow_all);
        assert!(perms.net.allowed.contains("localhost"));
        assert!(!perms.write.allow_all);
        assert_eq!(remaining, vec!["script.ts"]);
    }

    #[test]
    fn test_parse_full_permission() {
        let args = vec!["--allow-read".to_string(), "script.ts".to_string()];
        let (perms, remaining) = parse_flags(&args);

        assert!(perms.read.allow_all);
        assert!(!perms.write.allow_all);
        assert_eq!(remaining, vec!["script.ts"]);
    }

    #[test]
    fn test_permission_check_path_prefix() {
        let mut perm = Permission::default();
        perm.allowed.insert("/home/user".to_string());

        assert!(perm.check(Some("/home/user/file.txt")));
        assert!(perm.check(Some("/home/user/subdir/file.txt")));
        assert!(!perm.check(Some("/home/other/file.txt")));
    }

    #[test]
    fn test_no_flags_allows_all() {
        let args = vec!["script.ts".to_string()];
        let (perms, _) = parse_flags(&args);

        // When no flags are provided, permissions are disabled
        assert!(!perms.enabled);
    }
}

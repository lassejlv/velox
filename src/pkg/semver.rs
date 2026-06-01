//! A practical subset of node-semver: version parsing plus range matching for
//! the forms that appear in real `package.json` files — caret (`^`), tilde
//! (`~`), exact, x-ranges (`1.x`, `1`), comparators (`>=`, `>`, `<=`, `<`, `=`),
//! wildcards (`*`, `latest`, empty), space-joined AND, and `||` OR.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    /// Pre-release identifiers (e.g. `beta.1`), empty for a normal release.
    pub pre: Vec<String>,
}

impl Version {
    pub fn parse(s: &str) -> Option<Version> {
        let s = s.trim().trim_start_matches('v');
        // Split off build metadata (ignored) and pre-release.
        let s = s.split('+').next().unwrap_or(s);
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, p.split('.').map(|x| x.to_string()).collect()),
            None => (s, Vec::new()),
        };
        let mut it = core.split('.');
        let major = it.next()?.parse().ok()?;
        let minor = it.next().unwrap_or("0").parse().ok()?;
        let patch = it.next().unwrap_or("0").parse().ok()?;
        Some(Version {
            major,
            minor,
            patch,
            pre,
        })
    }

    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl std::fmt::Display for Version {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.pre.is_empty() {
            write!(f, "-{}", self.pre.join("."))?;
        }
        Ok(())
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| cmp_pre(&self.pre, &other.pre))
    }
}
impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// Pre-release precedence: a version with no pre-release outranks one with.
fn cmp_pre(a: &[String], b: &[String]) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => Ordering::Equal,
        (true, false) => Ordering::Greater,
        (false, true) => Ordering::Less,
        (false, false) => {
            for (x, y) in a.iter().zip(b.iter()) {
                let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(nx), Ok(ny)) => nx.cmp(&ny),
                    (Ok(_), Err(_)) => Ordering::Less, // numeric < alphanumeric
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => x.cmp(y),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            a.len().cmp(&b.len())
        }
    }
}

/// A single comparator: an operator plus a bound.
#[derive(Debug, Clone)]
struct Comparator {
    op: Op,
    v: Version,
}

#[derive(Debug, Clone, PartialEq)]
enum Op {
    Lt,
    Lte,
    Gt,
    Gte,
    Eq,
}

impl Comparator {
    fn matches(&self, v: &Version) -> bool {
        let ord = v.cmp(&self.v);
        match self.op {
            Op::Lt => ord == Ordering::Less,
            Op::Lte => ord != Ordering::Greater,
            Op::Gt => ord == Ordering::Greater,
            Op::Gte => ord != Ordering::Less,
            Op::Eq => ord == Ordering::Equal,
        }
    }
}

/// A parsed range: an OR of comparator-sets (each set is an AND).
#[derive(Debug, Clone)]
pub struct Range {
    sets: Vec<Vec<Comparator>>,
    any: bool,
}

impl Range {
    pub fn parse(input: &str) -> Range {
        let input = input.trim();
        if input.is_empty() || input == "*" || input == "latest" || input == "x" || input == "X" {
            return Range {
                sets: Vec::new(),
                any: true,
            };
        }
        let mut sets = Vec::new();
        for part in input.split("||") {
            sets.push(parse_comparator_set(part.trim()));
        }
        Range { sets, any: false }
    }

    pub fn matches(&self, v: &Version) -> bool {
        if self.any {
            // A bare `*` excludes pre-releases unless asked for one explicitly.
            return !v.is_prerelease();
        }
        self.sets.iter().any(|set| {
            if set.is_empty() {
                return !v.is_prerelease();
            }
            // A pre-release version only matches if some comparator in the set
            // names the same [major,minor,patch] tuple (node-semver rule).
            if v.is_prerelease()
                && !set.iter().any(|c| {
                    c.v.is_prerelease()
                        && (c.v.major, c.v.minor, c.v.patch) == (v.major, v.minor, v.patch)
                })
            {
                return false;
            }
            set.iter().all(|c| c.matches(v))
        })
    }

    /// Highest version in `versions` that satisfies the range (stable releases
    /// preferred; falls back to the highest matching pre-release).
    pub fn max_satisfying<'a>(&self, versions: &'a [Version]) -> Option<&'a Version> {
        versions
            .iter()
            .filter(|v| self.matches(v))
            .max_by(|a, b| a.cmp(b))
    }
}

/// Parse a space-joined comparator set, expanding `^`/`~`/x-ranges/bare versions
/// into one or two `>=`/`<` comparators.
fn parse_comparator_set(set: &str) -> Vec<Comparator> {
    let mut out = Vec::new();
    // Handle hyphen ranges: `1.2.3 - 2.3.4`.
    if let Some((lo, hi)) = split_hyphen_range(set) {
        if let Some(v) = Version::parse(lo) {
            out.push(Comparator { op: Op::Gte, v });
        }
        if let Some(c) = upper_from_partial(hi) {
            out.push(c);
        }
        return out;
    }
    // npm allows a space between a comparator operator and its version
    // (`>= 1.5.0 < 2`); glue a bare operator token onto the version that follows.
    let tokens: Vec<&str> = set.split_whitespace().collect();
    let mut i = 0;
    while i < tokens.len() {
        let t = tokens[i];
        if matches!(t, ">=" | "<=" | ">" | "<" | "=") && i + 1 < tokens.len() {
            expand_token(&format!("{t}{}", tokens[i + 1]), &mut out);
            i += 2;
        } else {
            expand_token(t, &mut out);
            i += 1;
        }
    }
    out
}

fn split_hyphen_range(set: &str) -> Option<(&str, &str)> {
    let parts: Vec<&str> = set.split(" - ").collect();
    if parts.len() == 2 {
        Some((parts[0].trim(), parts[1].trim()))
    } else {
        None
    }
}

/// For the upper bound of a hyphen range: `2` → `<3.0.0`, `2.3` → `<2.4.0`,
/// `2.3.4` → `<=2.3.4`.
fn upper_from_partial(s: &str) -> Option<Comparator> {
    let nums: Vec<&str> = s.split('.').collect();
    match nums.len() {
        1 => {
            Version::parse(&format!("{}.0.0", inc(nums[0])?)).map(|v| Comparator { op: Op::Lt, v })
        }
        2 => Version::parse(&format!("{}.{}.0", nums[0], inc(nums[1])?))
            .map(|v| Comparator { op: Op::Lt, v }),
        _ => Version::parse(s).map(|v| Comparator { op: Op::Lte, v }),
    }
}

fn inc(s: &str) -> Option<u64> {
    s.parse::<u64>().ok().map(|n| n + 1)
}

/// Expand one token into 0..2 comparators appended to `out`.
fn expand_token(token: &str, out: &mut Vec<Comparator>) {
    let token = token.trim();
    if token.is_empty() || token == "*" || token == "x" || token == "X" {
        return; // matches anything → no constraint
    }
    // Explicit comparators.
    for (prefix, op) in [
        (">=", Op::Gte),
        ("<=", Op::Lte),
        (">", Op::Gt),
        ("<", Op::Lt),
        ("=", Op::Eq),
    ] {
        if let Some(rest) = token.strip_prefix(prefix) {
            if let Some(v) = parse_partial_as_version(rest.trim()) {
                out.push(Comparator { op, v });
            }
            return;
        }
    }
    if let Some(rest) = token.strip_prefix('^') {
        caret(rest, out);
        return;
    }
    if let Some(rest) = token.strip_prefix('~') {
        tilde(rest, out);
        return;
    }
    // Bare version or x-range: `1.2.3`, `1.2`, `1`, `1.x`.
    bare_or_xrange(token, out);
}

fn parse_partial_as_version(s: &str) -> Option<Version> {
    Version::parse(s)
}

/// `^1.2.3` → `>=1.2.3 <2.0.0`; `^0.2.3` → `>=0.2.3 <0.3.0`; `^0.0.3` → `>=0.0.3 <0.0.4`.
fn caret(s: &str, out: &mut Vec<Comparator>) {
    let Some(v) = Version::parse(s) else { return };
    out.push(Comparator {
        op: Op::Gte,
        v: v.clone(),
    });
    let upper = if v.major > 0 {
        Version {
            major: v.major + 1,
            minor: 0,
            patch: 0,
            pre: vec![],
        }
    } else if v.minor > 0 {
        Version {
            major: 0,
            minor: v.minor + 1,
            patch: 0,
            pre: vec![],
        }
    } else {
        Version {
            major: 0,
            minor: 0,
            patch: v.patch + 1,
            pre: vec![],
        }
    };
    out.push(Comparator {
        op: Op::Lt,
        v: upper,
    });
}

/// `~1.2.3` → `>=1.2.3 <1.3.0`; `~1.2` → `>=1.2.0 <1.3.0`; `~1` → `>=1.0.0 <2.0.0`.
fn tilde(s: &str, out: &mut Vec<Comparator>) {
    let nums: Vec<&str> = s.split('.').collect();
    let Some(v) = Version::parse(s) else { return };
    out.push(Comparator {
        op: Op::Gte,
        v: v.clone(),
    });
    let upper = if nums.len() >= 2 {
        Version {
            major: v.major,
            minor: v.minor + 1,
            patch: 0,
            pre: vec![],
        }
    } else {
        Version {
            major: v.major + 1,
            minor: 0,
            patch: 0,
            pre: vec![],
        }
    };
    out.push(Comparator {
        op: Op::Lt,
        v: upper,
    });
}

/// Bare versions and x-ranges. `1.2.3` → `=1.2.3`; `1.2`/`1.2.x` → `>=1.2.0 <1.3.0`;
/// `1`/`1.x` → `>=1.0.0 <2.0.0`.
fn bare_or_xrange(token: &str, out: &mut Vec<Comparator>) {
    let parts: Vec<&str> = token.split('.').collect();
    let is_x = |p: &str| p == "x" || p == "X" || p == "*";
    // Find how many leading numeric components there are.
    let major = parts.first().copied().unwrap_or("0");
    if is_x(major) {
        return; // `x` / `*`
    }
    let major_n: u64 = match major.parse() {
        Ok(n) => n,
        Err(_) => return,
    };
    let minor = parts.get(1).copied();
    let patch = parts.get(2).copied();

    match (minor, patch) {
        (None, _) | (Some("x"), _) | (Some("X"), _) | (Some("*"), _) => {
            // `1` / `1.x` → >=1.0.0 <2.0.0
            out.push(Comparator {
                op: Op::Gte,
                v: Version {
                    major: major_n,
                    minor: 0,
                    patch: 0,
                    pre: vec![],
                },
            });
            out.push(Comparator {
                op: Op::Lt,
                v: Version {
                    major: major_n + 1,
                    minor: 0,
                    patch: 0,
                    pre: vec![],
                },
            });
        }
        (Some(m), None) | (Some(m), Some("x")) | (Some(m), Some("X")) | (Some(m), Some("*")) => {
            // `1.2` / `1.2.x` → >=1.2.0 <1.3.0
            if let Ok(minor_n) = m.parse::<u64>() {
                out.push(Comparator {
                    op: Op::Gte,
                    v: Version {
                        major: major_n,
                        minor: minor_n,
                        patch: 0,
                        pre: vec![],
                    },
                });
                out.push(Comparator {
                    op: Op::Lt,
                    v: Version {
                        major: major_n,
                        minor: minor_n + 1,
                        patch: 0,
                        pre: vec![],
                    },
                });
            }
        }
        (Some(_), Some(_)) => {
            // Fully specified → exact match.
            if let Some(v) = Version::parse(token) {
                out.push(Comparator { op: Op::Eq, v });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap()
    }

    #[test]
    fn ordering() {
        assert!(v("1.2.3") < v("1.2.4"));
        assert!(v("1.2.3") > v("1.2.3-beta")); // release > prerelease
        assert!(v("1.2.3-beta.2") > v("1.2.3-beta.1"));
        assert!(v("2.0.0") > v("1.9.9"));
    }

    #[test]
    fn caret_ranges() {
        let r = Range::parse("^1.2.3");
        assert!(r.matches(&v("1.2.3")));
        assert!(r.matches(&v("1.9.0")));
        assert!(!r.matches(&v("2.0.0")));
        assert!(!r.matches(&v("1.2.2")));

        let r0 = Range::parse("^0.2.3");
        assert!(r0.matches(&v("0.2.9")));
        assert!(!r0.matches(&v("0.3.0")));
    }

    #[test]
    fn tilde_ranges() {
        let r = Range::parse("~1.2.3");
        assert!(r.matches(&v("1.2.9")));
        assert!(!r.matches(&v("1.3.0")));
    }

    #[test]
    fn xranges_and_wildcards() {
        assert!(Range::parse("1.x").matches(&v("1.5.0")));
        assert!(!Range::parse("1.x").matches(&v("2.0.0")));
        assert!(Range::parse("*").matches(&v("9.9.9")));
        assert!(Range::parse("").matches(&v("1.0.0")));
    }

    #[test]
    fn comparators_and_compound() {
        let r = Range::parse(">=1.2.0 <2.0.0");
        assert!(r.matches(&v("1.5.0")));
        assert!(!r.matches(&v("2.0.0")));
        let or = Range::parse("1.2.3 || >=2.0.0");
        assert!(or.matches(&v("1.2.3")));
        assert!(or.matches(&v("3.0.0")));
        assert!(!or.matches(&v("1.5.0")));
    }

    #[test]
    fn space_between_operator_and_version() {
        // npm allows `>= 1.5.0 < 2` (operator separated from its version).
        let r = Range::parse(">= 1.5.0 < 2");
        assert!(r.matches(&v("1.5.0")));
        assert!(r.matches(&v("1.9.9")));
        assert!(!r.matches(&v("2.0.0")));
        assert!(!r.matches(&v("1.4.0")));
        assert_eq!(
            r.max_satisfying(&[v("1.4.0"), v("1.5.0"), v("2.0.2")])
                .unwrap(),
            &v("1.5.0")
        );
    }

    #[test]
    fn max_satisfying_picks_highest() {
        let vs = vec![v("1.0.0"), v("1.2.0"), v("1.9.0"), v("2.0.0")];
        assert_eq!(
            Range::parse("^1.0.0").max_satisfying(&vs).unwrap(),
            &v("1.9.0")
        );
    }

    #[test]
    fn prerelease_excluded_by_default() {
        assert!(!Range::parse("^1.0.0").matches(&v("2.0.0-beta")));
        assert!(Range::parse(">=1.0.0-beta <2.0.0").matches(&v("1.0.0-beta")));
    }
}

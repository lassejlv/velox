//! Extract an npm package tarball (`.tgz`) into a directory. npm tarballs are
//! gzip-compressed POSIX tar archives whose entries are all prefixed with
//! `package/`; that prefix is stripped so files land at the package root.
//!
//! Handles regular files, the GNU long-name (`L`) and POSIX pax extended
//! (`x`) records that carry paths longer than the 100-byte `name` field, and
//! ignores directories/symlinks/metadata entries.

use std::io::Read;
use std::path::Path;

use flate2::read::GzDecoder;

const BLOCK: usize = 512;

/// Decompress and extract `tgz` into `dest`, stripping the leading path
/// component (npm's `package/`). Returns the number of files written.
pub fn extract(tgz: &[u8], dest: &Path) -> Result<usize, String> {
    let mut decoder = GzDecoder::new(tgz);
    let mut data = Vec::new();
    decoder
        .read_to_end(&mut data)
        .map_err(|e| format!("gunzip failed: {e}"))?;

    let mut pos = 0;
    let mut written = 0;
    // A pending long path from an `L` (GNU) or `x` (pax) header applies to the
    // next file entry.
    let mut pending_name: Option<String> = None;

    while pos + BLOCK <= data.len() {
        let header = &data[pos..pos + BLOCK];
        // Two consecutive zero blocks mark the end of the archive.
        if header.iter().all(|&b| b == 0) {
            break;
        }
        pos += BLOCK;

        let size = parse_octal(&header[124..136]).unwrap_or(0) as usize;
        let typeflag = header[156];
        let entry_data_end = pos + size.div_ceil(BLOCK) * BLOCK;
        if entry_data_end > data.len() {
            return Err("truncated tar entry".to_string());
        }
        let body = &data[pos..pos + size];

        match typeflag {
            b'L' => {
                // GNU long name: the body is the name for the next entry.
                pending_name = Some(trim_nul(body).trim_end_matches('/').to_string());
            }
            b'x' | b'g' => {
                // pax extended header: parse `path=` from the records.
                if let Some(p) = pax_path(body) {
                    pending_name = Some(p);
                }
            }
            b'0' | 0 => {
                // Regular file.
                let raw_name = pending_name
                    .take()
                    .unwrap_or_else(|| header_name(header));
                if let Some(rel) = strip_package_prefix(&raw_name) {
                    write_file(dest, &rel, body)?;
                    written += 1;
                } else {
                    pending_name = None;
                }
            }
            _ => {
                // Directory ('5'), symlink ('2'), etc. — skip, drop any pending.
                if typeflag != b'L' && typeflag != b'x' && typeflag != b'g' {
                    pending_name = None;
                }
            }
        }

        pos = entry_data_end;
    }

    Ok(written)
}

/// The 100-byte name field, with the `prefix` field (offset 345) honored.
fn header_name(header: &[u8]) -> String {
    let name = trim_nul(&header[0..100]);
    let prefix = trim_nul(&header[345..500]);
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

/// Strip the leading path component (npm's `package/`). Returns None for the
/// bare top directory or paths that escape via `..`.
fn strip_package_prefix(name: &str) -> Option<String> {
    let name = name.trim_start_matches("./");
    let rel = match name.split_once('/') {
        Some((_, rest)) => rest,
        None => return None, // top-level dir entry, nothing under it
    };
    if rel.is_empty() || rel.split('/').any(|c| c == "..") {
        return None;
    }
    Some(rel.to_string())
}

fn write_file(dest: &Path, rel: &str, body: &[u8]) -> Result<(), String> {
    let path = dest.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("mkdir {}: {e}", parent.display()))?;
    }
    std::fs::write(&path, body).map_err(|e| format!("write {}: {e}", path.display()))
}

fn trim_nul(bytes: &[u8]) -> &str {
    let end = bytes.iter().position(|&b| b == 0).unwrap_or(bytes.len());
    std::str::from_utf8(&bytes[..end]).unwrap_or("")
}

/// Parse a NUL/space-terminated octal number from a tar header field.
fn parse_octal(field: &[u8]) -> Option<u64> {
    let s = trim_nul(field).trim();
    if s.is_empty() {
        return Some(0);
    }
    u64::from_str_radix(s.trim_end_matches(|c: char| !c.is_digit(8)), 8).ok()
}

/// Extract the `path=` value from a pax extended-header body. Records look like
/// `"<len> key=value\n"`.
fn pax_path(body: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(body).ok()?;
    let mut rest = text;
    while !rest.is_empty() {
        let space = rest.find(' ')?;
        let len: usize = rest[..space].parse().ok()?;
        if len == 0 || len > rest.len() {
            break;
        }
        let record = &rest[space + 1..len];
        if let Some(val) = record.strip_prefix("path=") {
            return Some(val.trim_end_matches('\n').trim_end_matches('/').to_string());
        }
        rest = &rest[len..];
    }
    None
}

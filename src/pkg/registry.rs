//! A small blocking HTTPS client plus npm-registry helpers. Reuses rustls (the
//! same TLS stack as `fetch.rs`) over a plain `std::net::TcpStream` — no async,
//! since the package manager runs as a one-shot CLI command.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;

use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use rustls_pki_types::ServerName;

/// Default registry; overridable via `$VELOX_REGISTRY` or `$npm_config_registry`.
pub fn registry_base() -> String {
    std::env::var("VELOX_REGISTRY")
        .or_else(|_| std::env::var("npm_config_registry"))
        .unwrap_or_else(|_| "https://registry.npmjs.org".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn tls_config() -> Arc<ClientConfig> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    Arc::new(
        ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
}

/// A parsed HTTP response: status code, headers, and body bytes.
type Response = (u16, Vec<(String, String)>, Vec<u8>);

struct Url {
    host: String,
    port: u16,
    path: String,
}

fn parse_url(url: &str) -> Result<Url, String> {
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| format!("only https URLs are supported: {url}"))?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().unwrap_or(443)),
        None => (authority.to_string(), 443),
    };
    Ok(Url { host, port, path: path.to_string() })
}

/// Perform an HTTPS GET, following up to 5 redirects. Returns the raw body bytes.
pub fn https_get(url: &str, accept: &str) -> Result<Vec<u8>, String> {
    let mut current = url.to_string();
    for _ in 0..6 {
        let (status, headers, body) = get_once(&current, accept)?;
        if (300..400).contains(&status) {
            let location = header(&headers, "location")
                .ok_or_else(|| format!("redirect {status} without Location"))?;
            current = if location.starts_with("http") {
                location
            } else {
                // Relative redirect — resolve against the current origin.
                let u = parse_url(&current)?;
                format!("https://{}{}", u.host, location)
            };
            continue;
        }
        if status == 200 {
            return Ok(body);
        }
        return Err(format!("HTTP {status} for {current}"));
    }
    Err(format!("too many redirects for {url}"))
}

/// One request/response cycle.
fn get_once(url: &str, accept: &str) -> Result<Response, String> {
    let u = parse_url(url)?;
    let server_name = ServerName::try_from(u.host.clone())
        .map_err(|_| format!("invalid host {}", u.host))?;
    let conn = ClientConnection::new(tls_config(), server_name)
        .map_err(|e| format!("TLS init: {e}"))?;
    let sock = TcpStream::connect((u.host.as_str(), u.port))
        .map_err(|e| format!("connect {}: {e}", u.host))?;
    let _ = sock.set_read_timeout(Some(std::time::Duration::from_secs(60)));
    let mut tls = StreamOwned::new(conn, sock);

    let request = format!(
        "GET {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: velox-pkg/0.1\r\nAccept: {}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n",
        u.path, u.host, accept
    );
    tls.write_all(request.as_bytes())
        .map_err(|e| format!("write: {e}"))?;

    let mut raw = Vec::new();
    // `Connection: close` → read until EOF.
    if let Err(e) = tls.read_to_end(&mut raw) {
        // A clean close sometimes surfaces as an error after the body; tolerate
        // it if we already have a parseable response.
        if raw.is_empty() {
            return Err(format!("read: {e}"));
        }
    }

    parse_response(&raw)
}

fn parse_response(raw: &[u8]) -> Result<Response, String> {
    let split = find_header_end(raw).ok_or("malformed HTTP response (no header end)")?;
    let head = std::str::from_utf8(&raw[..split]).map_err(|_| "non-utf8 headers")?;
    let body = &raw[split + 4..];

    let mut lines = head.split("\r\n");
    let status_line = lines.next().ok_or("empty response")?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or("no status code")?;

    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_lowercase(), v.trim().to_string()));
        }
    }

    let body = if header(&headers, "transfer-encoding")
        .map(|v| v.to_lowercase().contains("chunked"))
        .unwrap_or(false)
    {
        dechunk(body)?
    } else {
        body.to_vec()
    };

    Ok((status, headers, body))
}

fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|w| w == b"\r\n\r\n")
}

fn header(headers: &[(String, String)], name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.clone())
}

/// Decode HTTP/1.1 chunked transfer encoding.
fn dechunk(mut data: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let line_end = data
            .windows(2)
            .position(|w| w == b"\r\n")
            .ok_or("chunk size line missing")?;
        let size_str = std::str::from_utf8(&data[..line_end]).map_err(|_| "bad chunk size")?;
        let size = usize::from_str_radix(size_str.split(';').next().unwrap_or("").trim(), 16)
            .map_err(|_| "invalid chunk size")?;
        data = &data[line_end + 2..];
        if size == 0 {
            break;
        }
        if size > data.len() {
            return Err("truncated chunk".to_string());
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size + 2..]; // skip trailing CRLF
    }
    Ok(out)
}

/// Fetch and parse the (abbreviated) package document for `name`. Served from
/// the global metadata cache when fresh; on a network failure, falls back to a
/// stale cache entry if one exists (so installs work offline).
pub fn fetch_metadata(name: &str) -> Result<serde_json::Value, String> {
    use super::cache;

    if let Some(cached) = cache::read_metadata(name)
        && let Ok(value) = serde_json::from_slice(&cached)
    {
        return Ok(value);
    }

    let url = format!("{}/{}", registry_base(), encode_name(name));
    match https_get(&url, "application/vnd.npm.install-v1+json") {
        Ok(body) => {
            let value = serde_json::from_slice(&body)
                .map_err(|e| format!("parse metadata for {name}: {e}"))?;
            cache::write_metadata(name, &body);
            Ok(value)
        }
        Err(net_err) => {
            // Offline fallback: any cached copy beats failing outright.
            if let Some(stale) = cache::read_metadata_stale(name)
                && let Ok(value) = serde_json::from_slice(&stale)
            {
                return Ok(value);
            }
            Err(net_err)
        }
    }
}

/// Percent-encode a scoped package name's `/` (e.g. `@scope/pkg` → `@scope%2fpkg`).
fn encode_name(name: &str) -> String {
    if name.starts_with('@') {
        name.replacen('/', "%2f", 1)
    } else {
        name.to_string()
    }
}

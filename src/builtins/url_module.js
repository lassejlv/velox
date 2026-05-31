// node:url — exposes the global URL/URLSearchParams plus the legacy helpers.

function fileURLToPath(u) {
  var url = typeof u === "string" ? new URL(u) : u;
  return decodeURIComponent(url.pathname);
}
function pathToFileURL(p) {
  var u = new URL("file://");
  u.pathname = encodeURI(String(p));
  return u;
}
function parse(urlStr, parseQueryString) {
  urlStr = String(urlStr);
  var u, rel = false;
  try {
    u = new URL(urlStr);
  } catch (e) {
    try { u = new URL(urlStr, "http://localhost"); rel = true; } catch (e2) { u = null; }
  }
  if (!u) return { href: urlStr, path: urlStr, pathname: urlStr };
  var query = u.search ? u.search.slice(1) : null;
  return {
    protocol: rel ? null : u.protocol,
    slashes: rel ? null : true,
    host: rel ? null : u.host,
    hostname: rel ? null : u.hostname || null,
    port: u.port || null,
    hash: u.hash || null,
    search: u.search || null,
    query: parseQueryString ? Object.fromEntries(new URLSearchParams(u.search)) : query,
    pathname: u.pathname || null,
    path: (u.pathname || "") + (u.search || "") || null,
    href: rel ? urlStr : u.href,
  };
}
function format(urlObj) {
  if (urlObj instanceof URL) return urlObj.href;
  if (typeof urlObj === "string") return urlObj;
  var proto = urlObj.protocol ? urlObj.protocol.replace(/:?$/, ":") : "";
  var host = urlObj.host || (urlObj.hostname || "") + (urlObj.port ? ":" + urlObj.port : "");
  var path = urlObj.pathname || "";
  var search = urlObj.search || (urlObj.query ? "?" + (typeof urlObj.query === "string" ? urlObj.query : new URLSearchParams(urlObj.query).toString()) : "");
  var hash = urlObj.hash || "";
  return proto + (host ? "//" + host : "") + path + search + hash;
}
function resolve(from, to) {
  try { return new URL(to, from).href; } catch (e) { return to; }
}

module.exports = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  fileURLToPath: fileURLToPath,
  pathToFileURL: pathToFileURL,
  parse: parse,
  format: format,
  resolve: resolve,
  domainToASCII: function (d) { return String(d).toLowerCase(); },
  domainToUnicode: function (d) { return String(d); },
};
module.exports.default = module.exports;

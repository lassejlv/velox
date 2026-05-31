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
// Legacy `url.Url` class — `url.parse()` returns instances of it, and libraries
// (e.g. nock) do `x instanceof url.Url` to detect legacy parsed URLs.
function Url() {
  this.protocol = null; this.slashes = null; this.auth = null; this.host = null;
  this.port = null; this.hostname = null; this.hash = null; this.search = null;
  this.query = null; this.pathname = null; this.path = null; this.href = null;
}
Url.prototype.format = function () { return format(this); };

function parse(urlStr, parseQueryString) {
  urlStr = String(urlStr);
  var u, rel = false;
  try {
    u = new URL(urlStr);
  } catch (e) {
    try { u = new URL(urlStr, "http://localhost"); rel = true; } catch (e2) { u = null; }
  }
  var out = new Url();
  if (!u) { out.href = urlStr; out.path = urlStr; out.pathname = urlStr; return out; }
  var query = u.search ? u.search.slice(1) : null;
  out.protocol = rel ? null : u.protocol;
  out.slashes = rel ? null : true;
  out.auth = u.username ? (u.username + (u.password ? ":" + u.password : "")) : null;
  out.host = rel ? null : u.host;
  out.hostname = rel ? null : (u.hostname || null);
  out.port = u.port || null;
  out.hash = u.hash || null;
  out.search = u.search || null;
  out.query = parseQueryString ? Object.fromEntries(new URLSearchParams(u.search)) : query;
  out.pathname = u.pathname || null;
  out.path = (u.pathname || "") + (u.search || "") || null;
  out.href = rel ? urlStr : u.href;
  return out;
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
// Convert a WHATWG URL into the legacy http.request() options shape.
function urlToHttpOptions(url) {
  var options = {
    protocol: url.protocol,
    hostname: typeof url.hostname === "string" && url.hostname[0] === "[" ? url.hostname.slice(1, -1) : url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: (url.pathname || "") + (url.search || ""),
    href: url.href,
  };
  if (url.port !== "" && url.port != null) options.port = Number(url.port);
  if (url.username || url.password) {
    options.auth = decodeURIComponent(url.username || "") + ":" + decodeURIComponent(url.password || "");
  }
  return options;
}

module.exports = {
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  Url: Url,
  fileURLToPath: fileURLToPath,
  pathToFileURL: pathToFileURL,
  urlToHttpOptions: urlToHttpOptions,
  parse: parse,
  format: format,
  resolve: resolve,
  domainToASCII: function (d) { return String(d).toLowerCase(); },
  domainToUnicode: function (d) { return String(d); },
};
module.exports.default = module.exports;

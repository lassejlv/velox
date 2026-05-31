// WHATWG URL conformance — a battery drawn from the URL Standard's
// web-platform-tests (urltestdata.json): whitespace/control stripping, backslash
// handling in special schemes, default-port dropping, dot-segment normalization,
// userinfo/query/fragment percent-encoding, IPv6 hosts, relative resolution, and
// parse failures. Run: cargo run -- examples/url-conformance.ts
type Case = { input: string; base?: string; href?: string; failure?: boolean;
  protocol?: string; host?: string; hostname?: string; port?: string; pathname?: string; search?: string; hash?: string; username?: string; password?: string };
const cases: Case[] = [
  // whitespace + control stripping
  { input: "  http://example.com/  ", protocol: "http:", hostname: "example.com", pathname: "/" },
  { input: "http://example.com/\t\n", hostname: "example.com", pathname: "/" },
  { input: "ht\ttp://example.com/", protocol: "http:", hostname: "example.com" },
  // backslashes as separators in special schemes
  { input: "http:\\\\example.com\\path", protocol: "http:", hostname: "example.com", pathname: "/path" },
  { input: "https://example.com\\foo\\bar", hostname: "example.com", pathname: "/foo/bar" },
  // scheme/host case
  { input: "HTTP://EXAMPLE.com/", protocol: "http:", hostname: "example.com" },
  // default ports
  { input: "http://x.com:80/", port: "", host: "x.com" },
  { input: "https://x.com:443/", port: "" },
  { input: "ws://x.com:80/", port: "" },
  { input: "ftp://x.com:21/", port: "" },
  { input: "http://x.com:8080/", port: "8080", host: "x.com:8080" },
  // path normalization
  { input: "http://x.com/a/b/../../../c", pathname: "/c" },
  { input: "http://x.com/./a/./b/", pathname: "/a/b/" },
  { input: "http://x.com/..", pathname: "/" },
  { input: "http://x.com/a/..", pathname: "/" },
  // empty path → /
  { input: "http://x.com", pathname: "/" },
  // userinfo
  { input: "http://user:pass@x.com/", username: "user", password: "pass" },
  { input: "http://user@x.com/", username: "user", password: "" },
  // userinfo percent-encoding
  { input: "http://us er:p@ss@x.com/", username: "us%20er" },
  // query / fragment encoding
  { input: "http://x.com/?a=b c", search: "?a=b%20c" },
  { input: "http://x.com/#a b", hash: "#a%20b" },
  { input: "http://x.com/p a t h", pathname: "/p%20a%20t%20h" },
  // IPv6
  { input: "http://[2001:db8::1]:8080/", hostname: "[2001:db8::1]", port: "8080" },
  { input: "http://[::1]/", hostname: "[::1]" },
  // relative resolution
  { input: "../c", base: "http://x.com/a/b/d", pathname: "/a/c" },
  { input: "/c", base: "http://x.com/a/b", pathname: "/c" },
  { input: "?q", base: "http://x.com/a/b", pathname: "/a/b", search: "?q" },
  { input: "#h", base: "http://x.com/a/b?q", search: "?q", hash: "#h" },
  { input: "//other.com/p", base: "https://x.com/", hostname: "other.com", protocol: "https:" },
  { input: "g", base: "http://x.com/a/b/c", pathname: "/a/b/g" },
  // IPv4 host normalization (decimal / hex / octal / single-number / short forms)
  { input: "http://0x7f.0.0.1/", hostname: "127.0.0.1" },
  { input: "http://0177.0.0.1/", hostname: "127.0.0.1" },
  { input: "http://2130706433/", hostname: "127.0.0.1" },
  { input: "http://0x7f000001/", hostname: "127.0.0.1" },
  { input: "http://1.1/", hostname: "1.0.0.1" },
  { input: "http://192.168.000.001/", hostname: "192.168.0.1" },
  // IDN → Punycode (RFC 3492)
  { input: "http://日本語.jp/", hostname: "xn--wgv71a119e.jp" },
  { input: "http://münchen.de/", hostname: "xn--mnchen-3ya.de" },
  { input: "http://例え.テスト/", hostname: "xn--r8jz45g.xn--zckzah" },
  // failures
  { input: "http://", failure: true },
  { input: "https://#", failure: true },
  { input: "://nope", failure: true },
  { input: "foo", failure: true }, // no base, no scheme
  // file URLs
  { input: "file:///a/b", protocol: "file:", pathname: "/a/b" },
  // non-special scheme: opaque path
  { input: "mailto:a@b.com", protocol: "mailto:", pathname: "a@b.com" },
  { input: "data:text/plain,hi", protocol: "data:", pathname: "text/plain,hi" },
  // trailing/multiple slashes after authority
  { input: "http://x.com//a", pathname: "//a" },
  // tab/newline inside removed
  { input: "http://x.com/a\tb", pathname: "/ab" },
];

let pass = 0, fail = 0;
function eq(a: any, b: any) { return a === b; }
for (const c of cases) {
  try {
    const u = c.base ? new URL(c.input, c.base) : new URL(c.input);
    if (c.failure) { fail++; console.log("FAIL (should-throw):", JSON.stringify(c.input)); continue; }
    let ok = true, why = "";
    for (const k of ["protocol", "host", "hostname", "port", "pathname", "search", "hash", "username", "password"] as const) {
      if (c[k] !== undefined && !eq((u as any)[k], c[k])) { ok = false; why += ` ${k}=${JSON.stringify((u as any)[k])}≠${JSON.stringify(c[k])}`; }
    }
    if (ok) pass++; else { fail++; console.log("FAIL", JSON.stringify(c.input), why); }
  } catch (e: any) {
    if (c.failure) { pass++; } else { fail++; console.log("FAIL (threw):", JSON.stringify(c.input), e.message); }
  }
}
console.log("\nWHATWG URL: " + pass + "/" + (pass + fail) + " passed");
if (fail > 0) process.exit(1);

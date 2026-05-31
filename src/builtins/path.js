// node:path shim for velox (POSIX semantics).
//
// This file is a CommonJS module body, wrapped by the runtime as:
//   __modules['node:path'] = async function (module, exports, require) { ... };
// so we use `module.exports` / `exports.*` rather than ESM import/export.
//
// All logic implements POSIX path rules (the default `path` on macOS/Linux),
// closely mirroring Node's own lib/path.js behaviour.

'use strict';

// POSIX uses '/' as path separator and ':' as the PATH delimiter.
const sep = '/';
const delimiter = ':';

const CHAR_FORWARD_SLASH = '/';
const CHAR_DOT = '.';

function assertString(p, name) {
  if (typeof p !== 'string') {
    throw new TypeError(
      `Path "${name}" must be a string. Received ${typeof p}`
    );
  }
}

// Core normalization of the segment string between an (already-stripped)
// leading slash and trailing slash. Resolves '.' and '..' segments and
// collapses duplicate slashes.
//
// `path`           - the raw string to normalize
// `allowAboveRoot` - when true (relative paths), leading '..' are preserved
//
// Returns the normalized middle portion WITHOUT leading/trailing slash
// handling — callers add those back.
function normalizeString(path, allowAboveRoot) {
  let res = '';
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;

  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) {
      code = path.charCodeAt(i);
    } else if (path.charCodeAt(i) === 47 /* '/' */ || i === path.length) {
      code = 47; // treat end-of-string like a trailing slash
    }

    if (code === 47 /* '/' */) {
      if (lastSlash === i - 1 || dots === 1) {
        // Empty segment ("//") or a single "." segment — skip it.
      } else if (dots === 2) {
        // A ".." segment.
        if (
          res.length < 2 ||
          lastSegmentLength !== 2 ||
          res.charCodeAt(res.length - 1) !== 46 /* '.' */ ||
          res.charCodeAt(res.length - 2) !== 46 /* '.' */
        ) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf('/');
            if (lastSlashIndex === -1) {
              res = '';
              lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf('/');
            }
            lastSlash = i;
            dots = 0;
            continue;
          } else if (res.length !== 0) {
            // res is "a" or "ab": drop it entirely.
            res = '';
            lastSegmentLength = 0;
            lastSlash = i;
            dots = 0;
            continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? '/..' : '..';
          lastSegmentLength = 2;
        }
      } else {
        // A normal segment — append it.
        if (res.length > 0) {
          res += '/' + path.slice(lastSlash + 1, i);
        } else {
          res = path.slice(lastSlash + 1, i);
        }
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i;
      dots = 0;
    } else if (code === 46 /* '.' */ && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

function isPosixPathSeparator(code) {
  return code === 47; // '/'
}

// --- Exported functions -------------------------------------------------

function isAbsolute(path) {
  assertString(path, 'path');
  return path.length > 0 && path.charCodeAt(0) === 47; // starts with '/'
}

function normalize(path) {
  assertString(path, 'path');

  if (path.length === 0) return '.';

  const isAbsolutePath = path.charCodeAt(0) === 47; // '/'
  const trailingSeparator = path.charCodeAt(path.length - 1) === 47; // '/'

  // Resolve '.' and '..' segments.
  path = normalizeString(path, !isAbsolutePath);

  if (path.length === 0) {
    if (isAbsolutePath) return '/';
    return trailingSeparator ? './' : '.';
  }
  if (trailingSeparator) path += '/';

  return isAbsolutePath ? '/' + path : path;
}

function join(...args) {
  if (args.length === 0) return '.';
  let joined;
  for (let i = 0; i < args.length; ++i) {
    const arg = args[i];
    assertString(arg, 'path');
    if (arg.length > 0) {
      if (joined === undefined) joined = arg;
      else joined += '/' + arg;
    }
  }
  if (joined === undefined) return '.';
  return normalize(joined);
}

function resolve(...args) {
  let resolvedPath = '';
  let resolvedAbsolute = false;

  for (let i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    const path = i >= 0 ? args[i] : globalThis.process.cwd();
    assertString(path, 'path');

    // Skip empty entries.
    if (path.length === 0) continue;

    resolvedPath = path + '/' + resolvedPath;
    resolvedAbsolute = path.charCodeAt(0) === 47; // '/'
  }

  // Normalize, allowing leading '..' only when not absolute.
  resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);

  if (resolvedAbsolute) {
    return '/' + resolvedPath;
  }
  return resolvedPath.length > 0 ? resolvedPath : '.';
}

function relative(from, to) {
  assertString(from, 'from');
  assertString(to, 'to');

  if (from === to) return '';

  // Resolve both paths against cwd first.
  from = resolve(from);
  to = resolve(to);

  if (from === to) return '';

  const fromStart = 1; // skip leading '/'
  const fromEnd = from.length;
  const fromLen = fromEnd - fromStart;
  const toStart = 1;
  const toLen = to.length - toStart;

  // Find the length of the common prefix (by path segment).
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    if (fromCode === 47) lastCommonSep = i; // '/'
  }
  if (i === length) {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === 47) {
        // to is a subpath of from: e.g. from=/a, to=/a/b -> b
        return to.slice(toStart + i + 1);
      }
      if (i === 0) {
        // from is root.
        return to.slice(toStart + i);
      }
    } else if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === 47) {
        lastCommonSep = i;
      } else if (i === 0) {
        lastCommonSep = 0;
      }
    }
  }

  let out = '';
  // For each remaining segment in `from`, emit a '..'.
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === 47) {
      out += out.length === 0 ? '..' : '/..';
    }
  }

  // Append the rest of `to` after the common prefix.
  return out + to.slice(toStart + lastCommonSep);
}

function dirname(path) {
  assertString(path, 'path');
  if (path.length === 0) return '.';

  const hasRoot = path.charCodeAt(0) === 47; // '/'
  let end = -1;
  let matchedSlash = true;
  for (let i = path.length - 1; i >= 1; --i) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        end = i;
        break;
      }
    } else {
      matchedSlash = false;
    }
  }

  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 1) return '//';
  return path.slice(0, end);
}

function basename(path, suffix) {
  if (suffix !== undefined) assertString(suffix, 'suffix');
  assertString(path, 'path');

  let start = 0;
  let end = -1;
  let matchedSlash = true;

  if (
    suffix !== undefined &&
    suffix.length > 0 &&
    suffix.length <= path.length
  ) {
    if (suffix === path) return '';
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= 0; --i) {
      const code = path.charCodeAt(i);
      if (code === 47) {
        // path separator
        if (!matchedSlash) {
          start = i + 1;
          break;
        }
      } else {
        if (firstNonSlashEnd === -1) {
          matchedSlash = false;
          firstNonSlashEnd = i + 1;
        }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) {
            if (--extIdx === -1) {
              end = i; // matched full suffix
            }
          } else {
            extIdx = -1;
            end = firstNonSlashEnd;
          }
        }
      }
    }

    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }

  for (let i = path.length - 1; i >= 0; --i) {
    if (path.charCodeAt(i) === 47) {
      if (!matchedSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
  }

  if (end === -1) return '';
  return path.slice(start, end);
}

function extname(path) {
  assertString(path, 'path');
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  // Index of the first non-dot character we've seen in this segment.
  let preDotState = 0;

  for (let i = path.length - 1; i >= 0; --i) {
    const code = path.charCodeAt(i);
    if (code === 47) {
      // reached a path separator — stop, we're outside the basename.
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      // first non-separator char from the end: marks the end of the ext.
      matchedSlash = false;
      end = i + 1;
    }
    if (code === 46) {
      // a dot
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      // a non-dot char after we saw a dot — extension is valid.
      preDotState = -1;
    }
  }

  if (
    startDot === -1 ||
    end === -1 ||
    // The dot is the first char of the basename (e.g. ".bashrc").
    preDotState === 0 ||
    // The extension is a trailing run of dots (e.g. "..").
    (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)
  ) {
    return '';
  }
  return path.slice(startDot, end);
}

function parse(path) {
  assertString(path, 'path');

  const ret = { root: '', dir: '', base: '', ext: '', name: '' };
  if (path.length === 0) return ret;

  const isAbsolutePath = path.charCodeAt(0) === 47; // '/'
  let start;
  if (isAbsolutePath) {
    ret.root = '/';
    start = 1;
  } else {
    start = 0;
  }

  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let i = path.length - 1;
  let preDotState = 0;

  // Walk backwards to find base/ext boundaries.
  for (; i >= start; --i) {
    const code = path.charCodeAt(i);
    if (code === 47) {
      if (!matchedSlash) {
        startPart = i + 1;
        break;
      }
      continue;
    }
    if (end === -1) {
      matchedSlash = false;
      end = i + 1;
    }
    if (code === 46) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }

  if (end !== -1) {
    const start2 = startPart === 0 && isAbsolutePath ? 1 : startPart;
    if (
      startDot === -1 ||
      preDotState === 0 ||
      (preDotState === 1 &&
        startDot === end - 1 &&
        startDot === startPart + 1)
    ) {
      ret.base = ret.name = path.slice(start2, end);
    } else {
      ret.name = path.slice(start2, startDot);
      ret.base = path.slice(start2, end);
      ret.ext = path.slice(startDot, end);
    }
  }

  if (startPart > 0) {
    ret.dir = path.slice(0, startPart - 1);
  } else if (isAbsolutePath) {
    ret.dir = '/';
  }

  return ret;
}

function format(pathObject) {
  if (pathObject === null || typeof pathObject !== 'object') {
    throw new TypeError(
      `The "pathObject" argument must be of type object. Received ${typeof pathObject}`
    );
  }
  // `dir` overrides `root`; `base` overrides `name`+`ext`.
  const dir = pathObject.dir || pathObject.root;
  const base =
    pathObject.base || `${pathObject.name || ''}${pathObject.ext || ''}`;
  if (!dir) {
    return base;
  }
  if (dir === pathObject.root) {
    return dir + base;
  }
  return dir + sep + base;
}

function toNamespacedPath(path) {
  // POSIX: non-op.
  return path;
}

// ===========================================================================
// Windows path semantics (`path.win32`), ported from Node's lib/path.js. Drive
// letters (`C:\`), UNC paths (`\\server\share`), and both `/` and `\` as
// separators are handled. The default `path` export is POSIX (velox is macOS),
// but cross-platform packages and tests use `path.win32` directly.
// ===========================================================================
const CC_DOT = 46;
const CC_SLASH = 47;
const CC_BSLASH = 92;
const CC_COLON = 58;
const CC_QMARK = 63;

function isPathSeparatorWin(code) {
  return code === CC_SLASH || code === CC_BSLASH;
}
function isWindowsDeviceRoot(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122); // A-Z a-z
}

// Node's generic normalizeString (parameterized separator + predicate).
function normalizeStringGeneric(path, allowAboveRoot, separator, isSep) {
  let res = '';
  let lastSegmentLength = 0;
  let lastSlash = -1;
  let dots = 0;
  let code = 0;
  for (let i = 0; i <= path.length; ++i) {
    if (i < path.length) code = path.charCodeAt(i);
    else if (isSep(code)) break;
    else code = CC_SLASH;

    if (isSep(code)) {
      if (lastSlash === i - 1 || dots === 1) {
        // NOOP
      } else if (dots === 2) {
        if (res.length < 2 || lastSegmentLength !== 2 ||
            res.charCodeAt(res.length - 1) !== CC_DOT ||
            res.charCodeAt(res.length - 2) !== CC_DOT) {
          if (res.length > 2) {
            const lastSlashIndex = res.lastIndexOf(separator);
            if (lastSlashIndex === -1) {
              res = ''; lastSegmentLength = 0;
            } else {
              res = res.slice(0, lastSlashIndex);
              lastSegmentLength = res.length - 1 - res.lastIndexOf(separator);
            }
            lastSlash = i; dots = 0; continue;
          } else if (res.length !== 0) {
            res = ''; lastSegmentLength = 0; lastSlash = i; dots = 0; continue;
          }
        }
        if (allowAboveRoot) {
          res += res.length > 0 ? `${separator}..` : '..';
          lastSegmentLength = 2;
        }
      } else {
        if (res.length > 0) res += `${separator}${path.slice(lastSlash + 1, i)}`;
        else res = path.slice(lastSlash + 1, i);
        lastSegmentLength = i - lastSlash - 1;
      }
      lastSlash = i; dots = 0;
    } else if (code === CC_DOT && dots !== -1) {
      ++dots;
    } else {
      dots = -1;
    }
  }
  return res;
}

function win32Resolve() {
  let resolvedDevice = '';
  let resolvedTail = '';
  let resolvedAbsolute = false;
  for (let i = arguments.length - 1; i >= -1; i--) {
    let path;
    if (i >= 0) {
      path = arguments[i];
      assertString(path, 'path');
      if (path.length === 0) continue;
    } else if (resolvedDevice.length === 0) {
      path = (typeof process !== 'undefined' && process.cwd) ? process.cwd() : '/';
    } else {
      path = (typeof process !== 'undefined' && process.env && process.env['=' + resolvedDevice]) ||
        (typeof process !== 'undefined' && process.cwd ? process.cwd() : '/');
      if (path === undefined ||
          (path.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() &&
           path.charCodeAt(2) === CC_BSLASH)) {
        path = `${resolvedDevice}\\`;
      }
    }
    const len = path.length;
    let rootEnd = 0;
    let device = '';
    let isAbsolute = false;
    const code = path.charCodeAt(0);
    if (len === 1) {
      if (isPathSeparatorWin(code)) { rootEnd = 1; isAbsolute = true; }
    } else if (isPathSeparatorWin(code)) {
      isAbsolute = true;
      if (isPathSeparatorWin(path.charCodeAt(1))) {
        let j = 2; let last = j;
        while (j < len && !isPathSeparatorWin(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          const firstPart = path.slice(last, j);
          last = j;
          while (j < len && isPathSeparatorWin(path.charCodeAt(j))) j++;
          if (j < len && j !== last) {
            last = j;
            while (j < len && !isPathSeparatorWin(path.charCodeAt(j))) j++;
            if (j === len || j !== last) {
              device = `\\\\${firstPart}\\${path.slice(last, j)}`;
              rootEnd = j;
            }
          }
        }
      } else {
        rootEnd = 1;
      }
    } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CC_COLON) {
      device = path.slice(0, 2);
      rootEnd = 2;
      if (len > 2 && isPathSeparatorWin(path.charCodeAt(2))) { isAbsolute = true; rootEnd = 3; }
    }
    if (device.length > 0) {
      if (resolvedDevice.length > 0) {
        if (device.toLowerCase() !== resolvedDevice.toLowerCase()) continue;
      } else {
        resolvedDevice = device;
      }
    }
    if (resolvedAbsolute) {
      if (resolvedDevice.length > 0) break;
    } else {
      resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`;
      resolvedAbsolute = isAbsolute;
      if (isAbsolute && resolvedDevice.length > 0) break;
    }
  }
  resolvedTail = normalizeStringGeneric(resolvedTail, !resolvedAbsolute, '\\', isPathSeparatorWin);
  return resolvedAbsolute
    ? `${resolvedDevice}\\${resolvedTail}`
    : `${resolvedDevice}${resolvedTail}` || '.';
}

function win32Normalize(path) {
  assertString(path, 'path');
  const len = path.length;
  if (len === 0) return '.';
  let rootEnd = 0;
  let device;
  let isAbsolute = false;
  const code = path.charCodeAt(0);
  if (len === 1) return isPosixPathSeparator(code) ? '\\' : path;
  if (isPathSeparatorWin(code)) {
    isAbsolute = true;
    if (isPathSeparatorWin(path.charCodeAt(1))) {
      let j = 2; let last = j;
      while (j < len && !isPathSeparatorWin(path.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        const firstPart = path.slice(last, j);
        last = j;
        while (j < len && isPathSeparatorWin(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isPathSeparatorWin(path.charCodeAt(j))) j++;
          if (j === len) return `\\\\${firstPart}\\${path.slice(last)}\\`;
          if (j !== last) { device = `\\\\${firstPart}\\${path.slice(last, j)}`; rootEnd = j; }
        }
      }
    } else {
      rootEnd = 1;
    }
  } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CC_COLON) {
    device = path.slice(0, 2);
    rootEnd = 2;
    if (len > 2 && isPathSeparatorWin(path.charCodeAt(2))) { isAbsolute = true; rootEnd = 3; }
  }
  let tail = rootEnd < len
    ? normalizeStringGeneric(path.slice(rootEnd), !isAbsolute, '\\', isPathSeparatorWin)
    : '';
  if (tail.length === 0 && !isAbsolute) tail = '.';
  if (tail.length > 0 && isPathSeparatorWin(path.charCodeAt(len - 1))) tail += '\\';
  if (device === undefined) {
    return isAbsolute ? `\\${tail}` : tail;
  }
  return isAbsolute ? `${device}\\${tail}` : `${device}${tail}`;
}

function win32IsAbsolute(path) {
  assertString(path, 'path');
  const len = path.length;
  if (len === 0) return false;
  const code = path.charCodeAt(0);
  return isPathSeparatorWin(code) ||
    (len > 2 && isWindowsDeviceRoot(code) && path.charCodeAt(1) === CC_COLON &&
     isPathSeparatorWin(path.charCodeAt(2)));
}

function win32Join() {
  if (arguments.length === 0) return '.';
  let joined; let firstPart;
  for (let i = 0; i < arguments.length; ++i) {
    const arg = arguments[i];
    assertString(arg, 'path');
    if (arg.length > 0) {
      if (joined === undefined) joined = firstPart = arg;
      else joined += `\\${arg}`;
    }
  }
  if (joined === undefined) return '.';
  let needsReplace = true;
  let slashCount = 0;
  if (isPathSeparatorWin(firstPart.charCodeAt(0))) {
    ++slashCount;
    const firstLen = firstPart.length;
    if (firstLen > 1 && isPathSeparatorWin(firstPart.charCodeAt(1))) {
      ++slashCount;
      if (firstLen > 2) {
        if (isPathSeparatorWin(firstPart.charCodeAt(2))) ++slashCount;
        else { needsReplace = false; }
      }
    }
  }
  if (needsReplace) {
    while (slashCount < joined.length && isPathSeparatorWin(joined.charCodeAt(slashCount))) slashCount++;
    if (slashCount >= 2) joined = `\\${joined.slice(slashCount)}`;
  }
  return win32Normalize(joined);
}

function win32Relative(from, to) {
  assertString(from, 'from');
  assertString(to, 'to');
  if (from === to) return '';
  const fromOrig = win32Resolve(from);
  const toOrig = win32Resolve(to);
  if (fromOrig === toOrig) return '';
  from = fromOrig.toLowerCase();
  to = toOrig.toLowerCase();
  if (from === to) return '';
  let fromStart = 0;
  while (fromStart < from.length && from.charCodeAt(fromStart) === CC_BSLASH) fromStart++;
  let fromEnd = from.length;
  while (fromEnd - 1 > fromStart && from.charCodeAt(fromEnd - 1) === CC_BSLASH) fromEnd--;
  const fromLen = fromEnd - fromStart;
  let toStart = 0;
  while (toStart < to.length && to.charCodeAt(toStart) === CC_BSLASH) toStart++;
  let toEnd = to.length;
  while (toEnd - 1 > toStart && to.charCodeAt(toEnd - 1) === CC_BSLASH) toEnd--;
  const toLen = toEnd - toStart;
  const length = fromLen < toLen ? fromLen : toLen;
  let lastCommonSep = -1;
  let i = 0;
  for (; i < length; i++) {
    const fromCode = from.charCodeAt(fromStart + i);
    if (fromCode !== to.charCodeAt(toStart + i)) break;
    else if (fromCode === CC_BSLASH) lastCommonSep = i;
  }
  if (i !== length) {
    if (lastCommonSep === -1) return toOrig;
  } else {
    if (toLen > length) {
      if (to.charCodeAt(toStart + i) === CC_BSLASH) return toOrig.slice(toStart + i + 1);
      if (i === 2) return toOrig.slice(toStart + i);
    }
    if (fromLen > length) {
      if (from.charCodeAt(fromStart + i) === CC_BSLASH) lastCommonSep = i;
      else if (i === 2) lastCommonSep = 3;
    }
    if (lastCommonSep === -1) lastCommonSep = 0;
  }
  let out = '';
  for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
    if (i === fromEnd || from.charCodeAt(i) === CC_BSLASH) {
      out += out.length === 0 ? '..' : '\\..';
    }
  }
  toStart += lastCommonSep;
  if (out.length > 0) return `${out}${toOrig.slice(toStart, toEnd)}`;
  if (toOrig.charCodeAt(toStart) === CC_BSLASH) ++toStart;
  return toOrig.slice(toStart, toEnd);
}

function win32ToNamespacedPath(path) {
  if (typeof path !== 'string' || path.length === 0) return path;
  const resolvedPath = win32Resolve(path);
  if (resolvedPath.length <= 2) return path;
  if (resolvedPath.charCodeAt(0) === CC_BSLASH) {
    if (resolvedPath.charCodeAt(1) === CC_BSLASH) {
      const code = resolvedPath.charCodeAt(2);
      if (code !== CC_QMARK && code !== CC_DOT) {
        return `\\\\?\\UNC\\${resolvedPath.slice(2)}`;
      }
    }
  } else if (isWindowsDeviceRoot(resolvedPath.charCodeAt(0)) &&
             resolvedPath.charCodeAt(1) === CC_COLON &&
             resolvedPath.charCodeAt(2) === CC_BSLASH) {
    return `\\\\?\\${resolvedPath}`;
  }
  return path;
}

function win32Dirname(path) {
  assertString(path, 'path');
  const len = path.length;
  if (len === 0) return '.';
  let rootEnd = -1;
  let offset = 0;
  const code = path.charCodeAt(0);
  if (len === 1) return isPathSeparatorWin(code) ? path : '.';
  if (isPathSeparatorWin(code)) {
    rootEnd = offset = 1;
    if (isPathSeparatorWin(path.charCodeAt(1))) {
      let j = 2; let last = j;
      while (j < len && !isPathSeparatorWin(path.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        last = j;
        while (j < len && isPathSeparatorWin(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isPathSeparatorWin(path.charCodeAt(j))) j++;
          if (j === len) return path;
          if (j !== last) rootEnd = offset = j + 1;
        }
      }
    }
  } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CC_COLON) {
    rootEnd = len > 2 && isPathSeparatorWin(path.charCodeAt(2)) ? 3 : 2;
    offset = rootEnd;
  }
  let end = -1;
  let matchedSlash = true;
  for (let i = len - 1; i >= offset; --i) {
    if (isPathSeparatorWin(path.charCodeAt(i))) {
      if (!matchedSlash) { end = i; break; }
    } else {
      matchedSlash = false;
    }
  }
  if (end === -1) {
    if (rootEnd === -1) return '.';
    end = rootEnd;
  }
  return path.slice(0, end);
}

function win32Basename(path, suffix) {
  if (suffix !== undefined) assertString(suffix, 'suffix');
  assertString(path, 'path');
  let start = 0;
  let end = -1;
  let matchedSlash = true;
  if (path.length >= 2 && isWindowsDeviceRoot(path.charCodeAt(0)) &&
      path.charCodeAt(1) === CC_COLON) start = 2;
  if (suffix !== undefined && suffix.length > 0 && suffix.length <= path.length) {
    if (suffix === path) return '';
    let extIdx = suffix.length - 1;
    let firstNonSlashEnd = -1;
    for (let i = path.length - 1; i >= start; --i) {
      const code = path.charCodeAt(i);
      if (isPathSeparatorWin(code)) {
        if (!matchedSlash) { start = i + 1; break; }
      } else {
        if (firstNonSlashEnd === -1) { matchedSlash = false; firstNonSlashEnd = i + 1; }
        if (extIdx >= 0) {
          if (code === suffix.charCodeAt(extIdx)) {
            if (--extIdx === -1) end = i;
          } else { extIdx = -1; end = firstNonSlashEnd; }
        }
      }
    }
    if (start === end) end = firstNonSlashEnd;
    else if (end === -1) end = path.length;
    return path.slice(start, end);
  }
  for (let i = path.length - 1; i >= start; --i) {
    if (isPathSeparatorWin(path.charCodeAt(i))) {
      if (!matchedSlash) { start = i + 1; break; }
    } else if (end === -1) {
      matchedSlash = false; end = i + 1;
    }
  }
  if (end === -1) return '';
  return path.slice(start, end);
}

function win32Extname(path) {
  assertString(path, 'path');
  let start = 0;
  let startDot = -1;
  let startPart = 0;
  let end = -1;
  let matchedSlash = true;
  let preDotState = 0;
  if (path.length >= 2 && path.charCodeAt(1) === CC_COLON &&
      isWindowsDeviceRoot(path.charCodeAt(0))) start = startPart = 2;
  for (let i = path.length - 1; i >= start; --i) {
    const code = path.charCodeAt(i);
    if (isPathSeparatorWin(code)) {
      if (!matchedSlash) { startPart = i + 1; break; }
      continue;
    }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (code === CC_DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (startDot === -1 || end === -1 || preDotState === 0 ||
      (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
    return '';
  }
  return path.slice(startDot, end);
}

function win32Format(pathObject) {
  if (pathObject === null || typeof pathObject !== 'object') {
    throw new TypeError(`The "pathObject" argument must be of type object. Received ${typeof pathObject}`);
  }
  const dir = pathObject.dir || pathObject.root;
  const base = pathObject.base || `${pathObject.name || ''}${pathObject.ext || ''}`;
  if (!dir) return base;
  return dir === pathObject.root ? `${dir}${base}` : `${dir}\\${base}`;
}

function win32Parse(path) {
  assertString(path, 'path');
  const ret = { root: '', dir: '', base: '', ext: '', name: '' };
  if (path.length === 0) return ret;
  const len = path.length;
  let rootEnd = 0;
  let code = path.charCodeAt(0);
  if (len === 1) {
    if (isPathSeparatorWin(code)) { ret.root = ret.dir = path; return ret; }
    ret.base = ret.name = path; return ret;
  }
  if (isPathSeparatorWin(code)) {
    rootEnd = 1;
    if (isPathSeparatorWin(path.charCodeAt(1))) {
      let j = 2; let last = j;
      while (j < len && !isPathSeparatorWin(path.charCodeAt(j))) j++;
      if (j < len && j !== last) {
        last = j;
        while (j < len && isPathSeparatorWin(path.charCodeAt(j))) j++;
        if (j < len && j !== last) {
          last = j;
          while (j < len && !isPathSeparatorWin(path.charCodeAt(j))) j++;
          if (j === len) rootEnd = j;
          else if (j !== last) rootEnd = j + 1;
        }
      }
    }
  } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CC_COLON) {
    if (len <= 2) { ret.root = ret.dir = path; return ret; }
    rootEnd = 2;
    if (isPathSeparatorWin(path.charCodeAt(2))) {
      if (len === 3) { ret.root = ret.dir = path; return ret; }
      rootEnd = 3;
    }
  }
  if (rootEnd > 0) ret.root = path.slice(0, rootEnd);
  let startDot = -1;
  let startPart = rootEnd;
  let end = -1;
  let matchedSlash = true;
  let i = len - 1;
  let preDotState = 0;
  for (; i >= rootEnd; --i) {
    code = path.charCodeAt(i);
    if (isPathSeparatorWin(code)) {
      if (!matchedSlash) { startPart = i + 1; break; }
      continue;
    }
    if (end === -1) { matchedSlash = false; end = i + 1; }
    if (code === CC_DOT) {
      if (startDot === -1) startDot = i;
      else if (preDotState !== 1) preDotState = 1;
    } else if (startDot !== -1) {
      preDotState = -1;
    }
  }
  if (end !== -1) {
    if (startDot === -1 || preDotState === 0 ||
        (preDotState === 1 && startDot === end - 1 && startDot === startPart + 1)) {
      ret.base = ret.name = path.slice(startPart, end);
    } else {
      ret.name = path.slice(startPart, startDot);
      ret.base = path.slice(startPart, end);
      ret.ext = path.slice(startDot, end);
    }
  }
  if (startPart > 0 && startPart !== rootEnd) ret.dir = path.slice(0, startPart - 1);
  else ret.dir = ret.root;
  return ret;
}

// path.matchesGlob — glob matching (Node 20.17+). `**` spans separators, `*`/`?`
// don't, plus `[...]` classes. `winSep` true also treats `\` as a separator.
function globToRegExp(glob, winSep) {
  const sepClass = winSep ? '[^/\\\\]' : '[^/]';
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'; i++;
        if (glob[i + 1] === '/' || (winSep && glob[i + 1] === '\\')) i++;
      } else re += sepClass + '*';
    } else if (c === '?') {
      re += sepClass;
    } else if (c === '[') {
      let j = i + 1, cls = '[';
      if (glob[j] === '!' || glob[j] === '^') { cls += '^'; j++; }
      while (j < glob.length && glob[j] !== ']') { cls += glob[j] === '\\' ? '\\\\' : glob[j]; j++; }
      if (j < glob.length) { re += cls + ']'; i = j; } else re += '\\[';
    } else if (winSep && (c === '/' || c === '\\')) {
      re += '[/\\\\]';
    } else if ('.+^${}()|\\'.includes(c)) {
      re += '\\' + c;
    } else re += c;
  }
  return new RegExp(re + '$');
}
function makeMatchesGlob(winSep) {
  return function matchesGlob(path, glob) {
    assertString(path, 'path');
    assertString(glob, 'glob');
    return globToRegExp(glob, winSep).test(path);
  };
}

const win32 = {
  resolve: win32Resolve,
  normalize: win32Normalize,
  isAbsolute: win32IsAbsolute,
  join: win32Join,
  relative: win32Relative,
  toNamespacedPath: win32ToNamespacedPath,
  dirname: win32Dirname,
  basename: win32Basename,
  extname: win32Extname,
  format: win32Format,
  parse: win32Parse,
  matchesGlob: makeMatchesGlob(true),
  sep: '\\',
  delimiter: ';',
};

const posix = {
  resolve,
  normalize,
  isAbsolute,
  join,
  relative,
  toNamespacedPath,
  dirname,
  basename,
  extname,
  format,
  parse,
  matchesGlob: makeMatchesGlob(false),
  sep,
  delimiter,
};

// Both modules expose `.posix` and `.win32` cross-references (as Node does). The
// default export is POSIX (velox runs on macOS); `path.win32` is the real
// Windows implementation above.
posix.posix = win32.posix = posix;
posix.win32 = win32.win32 = win32;

module.exports = posix;

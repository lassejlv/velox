// node:querystring — the legacy URL query-string API.
//
// Repeated keys collapse into arrays on parse and expand back on stringify,
// matching Node's behaviour (`a=1&a=2` <-> `{ a: ['1', '2'] }`).

// ---------------------------------------------------------------------------
// escape / unescape
//
// Node's querystring.escape is essentially encodeURIComponent but it does not
// throw on lone surrogates (it replaces them). For our purposes we delegate to
// encodeURIComponent and fall back gracefully.
// ---------------------------------------------------------------------------

function escape(str) {
  str = String(str);
  try {
    return encodeURIComponent(str);
  } catch (e) {
    // Lone surrogate or similar: percent-encode byte by byte where possible.
    let out = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      try {
        out += encodeURIComponent(ch);
      } catch (e2) {
        out += ch;
      }
    }
    return out;
  }
}

function unescape(str) {
  str = String(str);
  // Node's unescape is tolerant: '+' is NOT converted here (that's parse's job
  // only for the legacy escape, but querystring.unescape leaves '+' alone).
  try {
    return decodeURIComponent(str);
  } catch (e) {
    return unescapeTolerant(str);
  }
}

// Decode percent-escapes one at a time, leaving malformed ones literal.
function unescapeTolerant(str) {
  let out = '';
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '%') {
      const hex = str.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        try {
          out += decodeURIComponent('%' + hex);
          i += 3;
          continue;
        } catch (e) {
          // fall through, keep the literal '%'
        }
      }
      out += '%';
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// parse / decode
// ---------------------------------------------------------------------------

function parse(qs, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  const obj = Object.create(null);

  if (typeof qs !== 'string' || qs.length === 0) {
    return obj;
  }

  const decode = (options && options.decodeURIComponent) || unescape;
  const maxKeys =
    options && typeof options.maxKeys === 'number' ? options.maxKeys : 1000;

  // The leading separator is stripped by Node.
  const parts = qs.split(sep);
  const limit = maxKeys > 0 ? Math.min(parts.length, maxKeys) : parts.length;

  for (let i = 0; i < limit; i++) {
    const part = parts[i].replace(/\+/g, '%20');
    if (part === '') continue;

    const idx = part.indexOf(eq);
    let key;
    let value;
    if (idx >= 0) {
      key = part.slice(0, idx);
      value = part.slice(idx + eq.length);
    } else {
      key = part;
      value = '';
    }

    key = decodeMaybe(decode, key);
    value = decodeMaybe(decode, value);

    if (!hasOwn(obj, key)) {
      obj[key] = value;
    } else if (Array.isArray(obj[key])) {
      obj[key].push(value);
    } else {
      obj[key] = [obj[key], value];
    }
  }

  return obj;
}

function decodeMaybe(decode, s) {
  try {
    return decode(s);
  } catch (e) {
    return s;
  }
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// ---------------------------------------------------------------------------
// stringify / encode
// ---------------------------------------------------------------------------

function stringifyPrimitive(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && isFinite(v)) return String(v);
  if (typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
}

function stringify(obj, sep, eq, options) {
  sep = sep || '&';
  eq = eq || '=';
  const encode = (options && options.encodeURIComponent) || escape;

  if (obj === null || typeof obj !== 'object') {
    return '';
  }

  const pairs = [];
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const encodedKey = encode(stringifyPrimitive(key));
    const value = obj[key];

    if (Array.isArray(value)) {
      for (let j = 0; j < value.length; j++) {
        pairs.push(encodedKey + eq + encode(stringifyPrimitive(value[j])));
      }
    } else {
      pairs.push(encodedKey + eq + encode(stringifyPrimitive(value)));
    }
  }

  return pairs.join(sep);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  parse,
  stringify,
  escape,
  unescape,
  encode: stringify, // alias
  decode: parse, // alias
};
module.exports.default = module.exports;

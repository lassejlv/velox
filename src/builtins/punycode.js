// node:punycode — the RFC 3492 Punycode/IDNA codec. Deprecated in Node but still
// present (and required by some packages). This is the canonical pure-JS
// implementation (Mathias Bynens' punycode.js, which Node vendors).

var maxInt = 2147483647;
var base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
var initialBias = 72, initialN = 128;
var delimiter = '-';
var regexPunycode = /^xn--/;
var regexNonASCII = /[^\0-\x7E]/;
var regexSeparators = /[\x2E。．｡]/g; // . 。 ．｡
var baseMinusTMin = base - tMin;
var floor = Math.floor;
var stringFromCharCode = String.fromCharCode;

function error(type) { throw new RangeError(type); }

function map(array, fn) {
  var result = [];
  var length = array.length;
  while (length--) result[length] = fn(array[length]);
  return result;
}

function mapDomain(str, fn) {
  var parts = str.split('@');
  var result = '';
  if (parts.length > 1) { result = parts[0] + '@'; str = parts[1]; }
  str = str.replace(regexSeparators, '\x2E');
  var labels = str.split('.');
  var encoded = map(labels, fn).join('.');
  return result + encoded;
}

function ucs2decode(string) {
  var output = [];
  var counter = 0;
  var length = string.length;
  while (counter < length) {
    var value = string.charCodeAt(counter++);
    if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
      var extra = string.charCodeAt(counter++);
      if ((extra & 0xFC00) == 0xDC00) {
        output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
      } else {
        output.push(value);
        counter--;
      }
    } else {
      output.push(value);
    }
  }
  return output;
}

function ucs2encode(array) {
  return map(array, function (value) {
    var output = '';
    if (value > 0xFFFF) {
      value -= 0x10000;
      output += stringFromCharCode((value >>> 10) & 0x3FF | 0xD800);
      value = 0xDC00 | value & 0x3FF;
    }
    output += stringFromCharCode(value);
    return output;
  }).join('');
}

function basicToDigit(codePoint) {
  if (codePoint - 0x30 < 0x0A) return codePoint - 0x16;
  if (codePoint - 0x41 < 0x1A) return codePoint - 0x41;
  if (codePoint - 0x61 < 0x1A) return codePoint - 0x61;
  return base;
}

function digitToBasic(digit, flag) {
  return digit + 22 + 75 * (digit < 26 ? 1 : 0) - ((flag != 0 ? 1 : 0) << 5);
}

function adapt(delta, numPoints, firstTime) {
  var k = 0;
  delta = firstTime ? floor(delta / damp) : delta >> 1;
  delta += floor(delta / numPoints);
  for (; delta > baseMinusTMin * tMax >> 1; k += base) {
    delta = floor(delta / baseMinusTMin);
  }
  return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
}

function decode(input) {
  var output = [];
  var inputLength = input.length;
  var i = 0;
  var n = initialN;
  var bias = initialBias;

  var basic = input.lastIndexOf(delimiter);
  if (basic < 0) basic = 0;

  for (var j = 0; j < basic; ++j) {
    if (input.charCodeAt(j) >= 0x80) error('not-basic');
    output.push(input.charCodeAt(j));
  }

  for (var index = basic > 0 ? basic + 1 : 0; index < inputLength;) {
    var oldi = i;
    for (var w = 1, k = base; ; k += base) {
      if (index >= inputLength) error('invalid-input');
      var digit = basicToDigit(input.charCodeAt(index++));
      if (digit >= base || digit > floor((maxInt - i) / w)) error('overflow');
      i += digit * w;
      var t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
      if (digit < t) break;
      var baseMinusT = base - t;
      if (w > floor(maxInt / baseMinusT)) error('overflow');
      w *= baseMinusT;
    }
    var out = output.length + 1;
    bias = adapt(i - oldi, out, oldi == 0);
    if (floor(i / out) > maxInt - n) error('overflow');
    n += floor(i / out);
    i %= out;
    output.splice(i++, 0, n);
  }
  return ucs2encode(output);
}

function encode(input) {
  var output = [];
  input = ucs2decode(input);
  var inputLength = input.length;
  var n = initialN;
  var delta = 0;
  var bias = initialBias;

  for (var j = 0; j < input.length; j++) {
    var cv = input[j];
    if (cv < 0x80) output.push(stringFromCharCode(cv));
  }

  var basicLength = output.length;
  var handledCPCount = basicLength;
  if (basicLength) output.push(delimiter);

  while (handledCPCount < inputLength) {
    var m = maxInt;
    for (var k = 0; k < input.length; k++) {
      var cp = input[k];
      if (cp >= n && cp < m) m = cp;
    }
    var handledCPCountPlusOne = handledCPCount + 1;
    if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) error('overflow');
    delta += (m - n) * handledCPCountPlusOne;
    n = m;
    for (var i2 = 0; i2 < input.length; i2++) {
      var c = input[i2];
      if (c < n && ++delta > maxInt) error('overflow');
      if (c == n) {
        var q = delta;
        for (var k2 = base; ; k2 += base) {
          var t = k2 <= bias ? tMin : (k2 >= bias + tMax ? tMax : k2 - bias);
          if (q < t) break;
          var qMinusT = q - t;
          var baseMinusT = base - t;
          output.push(stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0)));
          q = floor(qMinusT / baseMinusT);
        }
        output.push(stringFromCharCode(digitToBasic(q, 0)));
        bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
        delta = 0;
        ++handledCPCount;
      }
    }
    ++delta;
    ++n;
  }
  return output.join('');
}

function toUnicode(input) {
  return mapDomain(input, function (string) {
    return regexPunycode.test(string) ? decode(string.slice(4).toLowerCase()) : string;
  });
}

function toASCII(input) {
  return mapDomain(input, function (string) {
    return regexNonASCII.test(string) ? 'xn--' + encode(string) : string;
  });
}

module.exports = {
  version: '2.3.1',
  ucs2: { decode: ucs2decode, encode: ucs2encode },
  decode: decode,
  encode: encode,
  toASCII: toASCII,
  toUnicode: toUnicode,
};
module.exports.default = module.exports;

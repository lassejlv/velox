// node:readline/promises — the promise-based variant. Thin wrapper over
// node:readline where Interface.question returns a Promise.

var readline = require('node:readline');

function Interface(input, output, completer, terminal) {
  readline.Interface.call(this, input, output, completer, terminal);
}
Interface.prototype = Object.create(readline.Interface.prototype);
Interface.prototype.constructor = Interface;
Interface.prototype.question = function (query, options) {
  var self = this;
  var signal = options && options.signal;
  return new Promise(function (resolve, reject) {
    if (signal && signal.aborted) { reject(new Error('The operation was aborted')); return; }
    readline.Interface.prototype.question.call(self, query, function (answer) { resolve(answer); });
    if (signal) {
      signal.addEventListener('abort', function () { reject(new Error('The operation was aborted')); }, { once: true });
    }
  });
};

function createInterface(input, output, completer, terminal) {
  return new Interface(input, output, completer, terminal);
}

module.exports = {
  Interface: Interface,
  createInterface: createInterface,
};
module.exports.default = module.exports;

// Loads the app's classic scripts into Node's global scope for testing.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
module.exports = function load(...names) {
  globalThis.window = undefined;
  for (const n of names) {
    const file = path.join(__dirname, '..', 'js', n + '.js');
    vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
  }
  return globalThis.SF;
};

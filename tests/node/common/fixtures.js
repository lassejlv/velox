'use strict';
const path = require('path');
const fixturesDir = path.join(__dirname, '..', 'fixtures');
module.exports = { fixturesDir, path: (...a) => path.join(fixturesDir, ...a), readKey: () => '', readSync: () => '' };

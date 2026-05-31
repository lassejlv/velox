'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const p = path.join(os.tmpdir(), 'vx-node-test');
module.exports = { path: p, resolve: (...a) => path.join(p, ...a), refresh() { try { fs.rmSync(p, {recursive:true,force:true}); } catch(e){} try { fs.mkdirSync(p, {recursive:true}); } catch(e){} } };

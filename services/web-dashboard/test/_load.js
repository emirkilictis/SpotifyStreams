'use strict';
// Test helper: extract named function declarations out of the browser-side
// public/app.js (which is not a CommonJS module and executes DOM code at load)
// and evaluate just those functions in a sandboxed VM context so they can be
// unit-tested in Node without a browser.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extractFunction(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\(');
  const start = APP_SRC.search(re);
  if (start === -1) throw new Error('Function not found in app.js: ' + name);
  let i = APP_SRC.indexOf('{', start);
  let depth = 0;
  for (; i < APP_SRC.length; i++) {
    const ch = APP_SRC[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return APP_SRC.slice(start, i + 1);
    }
  }
  throw new Error('Unbalanced braces extracting: ' + name);
}

// Load a set of functions together so cross-references resolve.
// `globals` injects any module-level globals the functions read (e.g. currentArtist).
function loadAppFunctions(names, globals = {}) {
  const code = names.map(extractFunction).join('\n\n') +
    '\nglobalThis.__exports = {' + names.map(n => `${n}`).join(', ') + '};';
  const sandbox = Object.assign(
    { console, Math, Date, parseInt, parseFloat, isNaN, isFinite, Number, String, Array, JSON, RegExp },
    globals
  );
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__exports;
}

module.exports = { loadAppFunctions, extractFunction };

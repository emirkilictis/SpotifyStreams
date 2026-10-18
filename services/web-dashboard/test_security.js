// Legacy entry point: isolated security tests, no live database writes.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const result = spawnSync(process.execPath, ['--test',
  path.join(__dirname, 'test/security.test.js'),
  path.join(__dirname, 'test/security-http.test.js')], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;

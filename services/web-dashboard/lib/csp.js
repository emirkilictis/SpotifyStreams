'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function contentSecurityPolicy(publicDir) {
  const policies = new Map();
  for (const file of ['index.html', 'admin.html', 'guide.html']) {
    const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(match => !/\bsrc\s*=/i.test(match[1]))
      .map(match => `'sha256-${crypto.createHash('sha256').update(match[2]).digest('base64')}'`);
    policies.set(file, hashes.join(' '));
  }
  return (req, res, next) => {
    const file = req.path === '/admin' ? 'admin.html'
      : req.path === '/' ? 'index.html' : path.basename(req.path);
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      `script-src 'self' ${policies.get(file) || ''} https://cdn.jsdelivr.net/npm/apexcharts@8.3.1/dist/apexcharts.min.js https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js https://static.cloudflareinsights.com/beacon.min.js`,
      "script-src-attr 'none'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' https: data: blob:",
      "connect-src 'self' https:",
      "worker-src 'self' blob:",
      "object-src 'none'", "base-uri 'none'", "frame-ancestors 'self'", "form-action 'self'",
    ].join('; '));
    next();
  };
}

module.exports = { contentSecurityPolicy };

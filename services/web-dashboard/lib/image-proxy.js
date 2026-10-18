'use strict';
const dns = require('node:dns').promises;
const https = require('node:https');
const { isIP } = require('node:net');

function publicIPv4(address) {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

// Resolve once, reject private answers, and pin the checked address to the TLS
// connection. Re-resolving in the HTTP client would allow DNS rebinding.
async function fetchImage(url, hostAllowed, { lookup = dns.lookup, get = https.get } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password
    || (target.port && target.port !== '443') || !hostAllowed(target.hostname.toLowerCase())) {
    throw new Error('Image URL is not allowed.');
  }
  const addresses = await lookup(target.hostname, { family: 4, all: true });
  if (!addresses.length || addresses.some(x => !publicIPv4(x.address))) {
    throw new Error('Image host must resolve to public addresses.');
  }
  const maxBytes = 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const request = get(target, {
      family: 4,
      lookup: (_host, options, done) => done(null,
        options?.all ? [{ address: addresses[0].address, family: 4 }] : addresses[0].address, 4),
      headers: { 'User-Agent': 'SpotifyStreams image proxy' },
    }, upstream => {
      const type = (upstream.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      // Never follow redirects: even a later rejection would be too late to
      // prevent a request to an internal service. SVG/HTML are active content.
      if (upstream.statusCode !== 200 || !/^image\/(jpeg|png|gif|webp|avif)$/.test(type)
        || Number(upstream.headers['content-length'] || 0) > maxBytes) {
        upstream.destroy();
        request.destroy(new Error('Unsupported upstream image response.'));
        return;
      }
      let size = 0;
      const chunks = [];
      upstream.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) request.destroy(new Error('Image too large.'));
        else chunks.push(chunk);
      });
      upstream.on('error', reject);
      upstream.on('end', () => resolve({ type, body: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => request.destroy(new Error('Image request timed out.')), 8000);
    request.on('close', () => clearTimeout(timer));
    request.on('error', reject);
  });
}

module.exports = { publicIPv4, fetchImage };

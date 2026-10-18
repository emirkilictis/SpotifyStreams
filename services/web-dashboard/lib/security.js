'use strict';
const crypto = require('node:crypto');

function requiredSecret(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim().length < 32 || /^(.)\1+$/.test(value)) {
    throw new Error(`${name} must be set to a unique random secret of at least 32 characters.`);
  }
  return value;
}

const passHash = value => crypto.createHash('sha256').update(String(value)).digest();
const secretsMatch = (a, b) => typeof a === 'string' && typeof b === 'string'
  && a.length > 0 && b.length > 0 && crypto.timingSafeEqual(passHash(a), passHash(b));

function securityConfig(env = process.env) {
  const admin = requiredSecret(env, 'ADMIN_PASSCODE');
  const secadmin = requiredSecret(env, 'SECADMIN_PASSCODE');
  const ipHashSecret = requiredSecret(env, 'IP_HASH_SECRET');
  if (new Set([admin, secadmin, ipHashSecret]).size !== 3) {
    throw new Error('ADMIN_PASSCODE, SECADMIN_PASSCODE and IP_HASH_SECRET must be different.');
  }
  const jcPasscodes = (env.JC_PASSCODES || '').split(',').map(s => s.trim()).filter(Boolean);
  if (jcPasscodes.some(s => s.length < 32 || [admin, secadmin, ipHashSecret].includes(s))) {
    throw new Error('JC_PASSCODES must contain independent secrets of at least 32 characters.');
  }
  function getAdminRole(passcode) {
    if (typeof passcode !== 'string' || passcode.length > 1024) return null;
    if (secretsMatch(passcode, admin)) return 'admin';
    if (secretsMatch(passcode, secadmin)) return 'secadmin';
    const colon = passcode.indexOf(':');
    const user = passcode.slice(0, colon);
    const pass = passcode.slice(colon + 1);
    if (colon > 0 && user === 'admin' && secretsMatch(pass, admin)) return 'admin';
    if (colon > 0 && user === 'secadmin' && secretsMatch(pass, secadmin)) return 'secadmin';
    return null;
  }
  return {
    getAdminRole,
    isJcAllowed: passcode => jcPasscodes.some(s => secretsMatch(passcode, s)),
    hashIp: ip => crypto.createHmac('sha256', ipHashSecret).update(String(ip)).digest('hex').slice(0, 32),
  };
}

// One proxy hop on Render; never take the client-controlled leftmost XFF entry.
function proxyTrust(env = process.env) {
  const value = env.TRUST_PROXY_HOPS || (env.RENDER ? '1' : '0');
  if (!/^[0-5]$/.test(value)) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 5.');
  return Number(value);
}

function adminGuard(getAdminRole, { maxFailures = 10, lockMs = 15 * 60 * 1000, maxEntries = 5000 } = {}) {
  const failures = new Map();
  return (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const now = Date.now();
    const ip = req.ip || 'unknown';
    for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
    const rec = failures.get(ip);
    if (rec && rec.count >= maxFailures) {
      res.set('Retry-After', String(Math.ceil((rec.until - now) / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    // Header only: URL credentials leak into access logs and browser history.
    const role = getAdminRole(req.headers['x-admin-passcode']);
    if (!role) {
      // Refuse new sources at capacity instead of evicting active lockouts.
      if (!rec && failures.size >= maxEntries) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
      failures.set(ip, { count: (rec?.count || 0) + 1, until: now + lockMs });
      return res.status(403).json({ error: 'Forbidden' });
    }
    failures.delete(ip);
    req.adminRole = role;
    next();
  };
}

module.exports = { securityConfig, secretsMatch, proxyTrust, adminGuard };

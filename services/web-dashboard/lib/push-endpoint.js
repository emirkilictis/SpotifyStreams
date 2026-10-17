'use strict';

// Public subscriptions must not turn the dispatcher into an arbitrary HTTP
// client. Only browser-vendor push services can receive notifications.
function validPushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 1000) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash
      || (url.port && url.port !== '443')) return false;
    const host = url.hostname.toLowerCase();
    return host === 'fcm.googleapis.com' || host === 'android.googleapis.com'
      || host === 'updates.push.services.mozilla.com' || host === 'push.services.mozilla.com'
      || host === 'updates-push.services.mozaws.net'
      || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
  } catch { return false; }
}

function validPushKeys(keys) {
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return false;
  return /^[A-Za-z0-9_-]{87}=?$/.test(keys.p256dh)
    && Buffer.from(keys.p256dh, 'base64url').length === 65
    && /^[A-Za-z0-9_-]{22}(==)?$/.test(keys.auth)
    && Buffer.from(keys.auth, 'base64url').length === 16;
}

module.exports = { validPushEndpoint, validPushKeys };

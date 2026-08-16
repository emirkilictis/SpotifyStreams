// Service worker — exists for one reason: a browser can only receive push
// notifications through one. It deliberately does NOT cache anything; the whole
// point of this site is live numbers, and a stale cached dashboard would be
// worse than a slow one.

self.addEventListener('install', (event) => {
  // Take over straight away rather than waiting for every tab to close, so the
  // first subscribe works in the same visit that granted permission.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = data.title || 'Spotify Streams';
  const options = {
    body: data.body || 'New numbers are in.',
    icon: '/images/notification-icon.png',
    badge: '/images/notification-badge.png',
    // Same tag replaces an unread notification for the same artist+day instead
    // of stacking a second one.
    tag: data.tag || 'stream-update',
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Reuse a tab that already has the site open rather than piling up windows.
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

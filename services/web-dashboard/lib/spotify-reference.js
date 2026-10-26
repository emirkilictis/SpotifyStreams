'use strict';
const ID = /^[A-Za-z0-9]{22}$/;
function spotifyReference(value, bareKind = 'album') {
  if (typeof value !== 'string' || value.length > 2048) return null;
  const input = value.trim();
  if (ID.test(input)) return { kind: bareKind, id: input };
  const uri = /^spotify:(album|track):([A-Za-z0-9]{22})$/.exec(input);
  if (uri) return { kind: uri[1], id: uri[2] };
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.port || url.username || url.password) return null;
    const match = /^\/(?:intl-[a-z]{2}\/)?(album|track)\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
    return match ? { kind: match[1], id: match[2] } : null;
  } catch { return null; }
}
module.exports = { spotifyReference };

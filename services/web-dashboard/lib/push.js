// ---------------------------------------------------------------------------
// Web push: telling followers when a new stream day lands.
//
// The event people care about is the daily rollover — Spotify publishes the
// previous day's counts and the scraper captures them. That happens once a day
// per artist, so that is what gets announced: one notification, per artist a
// browser follows, per stream day.
//
// Dispatch is idempotent by design. push_sent_days holds one row per
// (artist, stream day) already announced, so this can be called by anything as
// often as it likes — the hourly scrape, a cron ping, the admin panel — and
// nobody is told twice. That matters more than it sounds: the scrape runs every
// hour and a run can be retried.
//
// Without VAPID keys in the environment the whole feature reports itself as
// unavailable and every entry point turns into a no-op, so a deploy that hasn't
// been given keys behaves exactly like one without the feature.
// ---------------------------------------------------------------------------
const webpush = require('web-push');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
// Push services want a contact for the sender. mailto: or an https URL.
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@spotifystreams.app';

const pushEnabled = Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn('[push] VAPID keys missing — push notifications are disabled.');
}

// A scrape run writes song by song, and it can be cut short by its time budget
// mid-artist. Announcing then would report a fraction of the day as the day's
// total. So an artist's day only counts as ready once nearly all of their
// tracked songs carry a row for it.
const DAY_COMPLETE_RATIO = 0.9;

// Nothing is worth announcing if the number is zero — that is a day the artist
// was scraped but Spotify had not published anything yet.
const MIN_DAILY_GAIN = 1;

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

// Which artists have a freshly-captured day that nobody has been told about.
// Everything here is per artist bucket, the same rule the dashboard reads by.
async function pendingAnnouncements(dbQuery, artistBucketSql, hiddenIdsSql) {
  const q = `
    WITH followed AS (
      SELECT DISTINCT artist_id FROM push_artist_follows
    ),
    scoped AS (
      SELECT ta.artist_id, ta.name
      FROM tracked_artists ta
      JOIN followed f ON f.artist_id = ta.artist_id
      WHERE ta.active = true
    )
    SELECT artist_id, name FROM scoped ORDER BY artist_id
  `;
  const artists = (await dbQuery(q)).rows;
  const out = [];
  for (const artist of artists) {
    const uri = `spotify:artist:${artist.artist_id}`;
    // The artist's newest captured day, how much of their catalogue it covers,
    // and what the day added — in one round trip per artist. Artists are few
    // (and only followed ones are here), days are one.
    const r = await dbQuery(
      `
      WITH bucket AS (
        SELECT s.id
        FROM songs s
        LEFT JOIN albums a ON s.album_id = a.id
        WHERE s.canonical_id IS NULL AND ${artistBucketSql}
          AND s.id NOT IN (${hiddenIdsSql})
      ),
      cs AS (
        SELECT COALESCE(s2.canonical_id, s2.id) AS canonical_id,
               ss.recorded_date,
               MAX(ss.stream_count) AS stream_count
        FROM stream_stats ss
        JOIN songs s2 ON s2.id = ss.song_id
        WHERE COALESCE(s2.canonical_id, s2.id) IN (SELECT id FROM bucket)
        GROUP BY 1, 2
      ),
      runmax AS (
        SELECT canonical_id, recorded_date,
               MAX(stream_count) OVER (
                 PARTITION BY canonical_id ORDER BY recorded_date
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS cumulative
        FROM cs
      ),
      gains AS (
        SELECT canonical_id, recorded_date, cumulative,
               (cumulative - LAG(cumulative) OVER w)
                 / NULLIF(recorded_date - LAG(recorded_date) OVER w, 0) AS daily_gain
        FROM runmax
        WINDOW w AS (PARTITION BY canonical_id ORDER BY recorded_date)
      ),
      latest AS (SELECT MAX(recorded_date) AS d FROM gains)
      SELECT
        (SELECT d FROM latest)::text            AS stream_date,
        COUNT(*) FILTER (WHERE g.recorded_date = (SELECT d FROM latest))::int AS songs_on_day,
        (SELECT COUNT(*) FROM bucket)::int      AS songs_tracked,
        COALESCE(SUM(g.daily_gain) FILTER (WHERE g.recorded_date = (SELECT d FROM latest)), 0)::bigint AS daily_gain,
        COALESCE(SUM(g.cumulative) FILTER (WHERE g.recorded_date = (SELECT d FROM latest)), 0)::bigint AS total
      FROM gains g
      `,
      [uri]
    );
    const row = r.rows[0];
    if (!row || !row.stream_date) continue;
    if (!row.songs_tracked || row.songs_on_day / row.songs_tracked < DAY_COMPLETE_RATIO) continue;
    if (Number(row.daily_gain) < MIN_DAILY_GAIN) continue;

    const already = await dbQuery(
      `SELECT 1 FROM push_sent_days WHERE artist_id = $1 AND stream_date = $2::date`,
      [artist.artist_id, row.stream_date]
    );
    if (already.rows.length) continue;

    out.push({
      artistId: artist.artist_id,
      name: artist.name,
      streamDate: row.stream_date,
      dailyGain: Number(row.daily_gain),
      total: Number(row.total),
    });
  }
  return out;
}

// Send one announcement to everyone following that artist. Subscriptions the
// push service has retired (410/404) are deleted — browsers rotate them when
// the user clears data or reinstalls, and a dead endpoint would otherwise be
// retried forever.
async function sendToFollowers(dbQuery, announcement) {
  const subs = await dbQuery(
    `SELECT s.endpoint, s.p256dh, s.auth
     FROM push_subscriptions s
     JOIN push_artist_follows f ON f.endpoint = s.endpoint
     WHERE f.artist_id = $1`,
    [announcement.artistId]
  );

  const payload = JSON.stringify({
    title: `${announcement.name} · +${fmt(announcement.dailyGain)} streams`,
    body: `New Spotify numbers are in — ${fmt(announcement.total)} total.`,
    artistId: announcement.artistId,
    url: `/?artist=${announcement.artistId}`,
    tag: `day-${announcement.artistId}-${announcement.streamDate}`,
  });

  let delivered = 0;
  const dead = [];
  for (const sub of subs.rows) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 12 * 60 * 60 }   // a day's numbers stop being news after that
      );
      delivered += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
      else console.warn('[push] send failed:', err.statusCode || err.message);
    }
  }
  if (dead.length) {
    await dbQuery(`DELETE FROM push_subscriptions WHERE endpoint = ANY($1::text[])`, [dead]);
  }
  return { delivered, expired: dead.length, followers: subs.rows.length };
}

module.exports = { pushEnabled, VAPID_PUBLIC, pendingAnnouncements, sendToFollowers };

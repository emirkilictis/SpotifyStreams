/**
 * reconcile-kworb.js — close the kworb gap AUTOMATICALLY, for every artist,
 * forever. The write-enabled twin of audit-kworb.js.
 *
 * Why this exists: adding an artist used to be a two-step ritual — add them,
 * notice days later that we sit below their kworb page, then hand-run an audit
 * and hand-edit code for each missing track. The gap is always the same two
 * mechanical causes (see kworb.js), and both are now repairable from data:
 *
 *   1. OTHER BUCKET → INSERT the track into extra_artist_songs. The track keeps
 *      its lead-artist bucket too, so it shows on both pages exactly like kworb
 *      — no double counting, since there is no roster-wide total.
 *   2. MISSING      → resolve the track's album from Spotify, verify the artist
 *      is really credited there, and pin it into extra_scrape_albums. The next
 *      scrape visits that album; processAlbum's track-level filter keeps only
 *      this artist's tracks on it.
 *
 * kworb is only a DISCOVERY hint. Every stored number still comes from Spotify's
 * own playcount, and nothing is pinned unless Spotify itself lists the artist in
 * the track's credits — so a kworb mis-attribution can't drag in a foreign album.
 *
 * Usage:
 *   node reconcile-kworb.js                        # eligible artists, oldest-checked first
 *   node reconcile-kworb.js --artists=<id>,<id>    # specific artists
 *   node reconcile-kworb.js --artists=<id> --force # ignore the per-artist cooldown
 *   node reconcile-kworb.js --dry-run              # report only, write nothing
 *
 * Env: RECONCILE_BUDGET_MS (default 7m), RECONCILE_COOLDOWN_HOURS (20),
 *      RECONCILE_MAX_ARTISTS (3), RECONCILE_MIN_STREAMS (100000).
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getPool, closePool, upsertAlbum } = require('./db');
const { fetchKworbSongs, loadOurBucket, classify, resolveTracks } = require('./kworb');

const RUN_START = Date.now();
const BUDGET_MS       = Number(process.env.RECONCILE_BUDGET_MS || 7 * 60 * 1000);
const COOLDOWN_HOURS  = Number(process.env.RECONCILE_COOLDOWN_HOURS || 20);
const MIN_STREAMS     = Number(process.env.RECONCILE_MIN_STREAMS || 100000);
// Per-artist blast radius. A kworb layout change or a bad match should cost us a
// handful of rows we can delete, never hundreds.
const MAX_LINKS_PER_ARTIST = Number(process.env.RECONCILE_MAX_LINKS || 60);
const MAX_PINS_PER_ARTIST  = Number(process.env.RECONCILE_MAX_PINS || 25);
const MAX_RESOLVE_PER_ARTIST = Number(process.env.RECONCILE_MAX_RESOLVE || 40);

const JT_ID = '31TPClRtHm23RisEBtV3X7';

const argv = process.argv.slice(2);
const arg = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : null;
};
const DRY_RUN = argv.includes('--dry-run');
const FORCE   = argv.includes('--force');
const ONLY    = (arg('artists') || '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_ARTISTS = Number(arg('max-artists') || process.env.RECONCILE_MAX_ARTISTS || 3);

const fmtM = (n) => (Number(n) / 1e6).toFixed(1) + 'M';
const sum = (arr) => arr.reduce((a, b) => a + b.streams, 0);

/**
 * Who to reconcile, in priority order.
 *
 * NEVER-CHECKED FIRST — that is the whole point: the artist you added yesterday
 * is the one whose gap nobody has closed yet. After that, oldest check first.
 *
 * Skipped by design:
 *  - album_only artists: their feature gaps are DELIBERATE (they track their own
 *    discography only), so "missing vs kworb" is the intended state, not a bug.
 *  - JT: the catch-all bucket ("everything no named artist claims"). Its
 *    membership rule isn't primary_artist, so this classifier doesn't model it.
 */
async function pickArtists(client) {
  const res = await client.query(`
    SELECT ta.artist_id, ta.name, ta.album_only, ka.checked_at
      FROM tracked_artists ta
      LEFT JOIN kworb_audit ka ON ka.artist_id = ta.artist_id
     WHERE ta.active = true
     ORDER BY (ka.checked_at IS NULL) DESC, ka.checked_at ASC NULLS FIRST, ta.sort_order
  `);
  const out = [];
  for (const a of res.rows) {
    if (ONLY.length && !ONLY.includes(a.artist_id)) continue;
    if (a.artist_id === JT_ID) {
      if (ONLY.length) console.log(`[reconcile] ${a.name}: skipped — catch-all bucket, not modelled by this audit.`);
      continue;
    }
    if (a.album_only) {
      if (ONLY.length) console.log(`[reconcile] ${a.name}: skipped — album_only, feature gaps are intentional.`);
      continue;
    }
    const ageH = a.checked_at ? (Date.now() - new Date(a.checked_at).getTime()) / 3600000 : Infinity;
    if (!FORCE && ageH < COOLDOWN_HOURS) continue;
    out.push(a);
  }
  return out;
}

async function reconcileArtist(client, artist, getPage) {
  const { artist_id: artistId, name } = artist;
  const artistUri = `spotify:artist:${artistId}`;
  console.log(`\n[reconcile] ── ${name} (${artistId})`);

  const [kworb, ours] = await Promise.all([
    fetchKworbSongs(artistId),
    loadOurBucket(client, artistId),
  ]);
  const { ok, otherBucket, missing, noId } = classify(kworb.tracks, ours);
  const gap = (kworb.headerStreams || 0) - ours.ourTotal;
  console.log(`[reconcile]   kworb ${(kworb.headerStreams / 1e9).toFixed(3)}B/${kworb.tracks.length} · ours ${(ours.ourTotal / 1e9).toFixed(3)}B/${ours.ourCount} · gap ${fmtM(gap)}`);
  console.log(`[reconcile]   ok ${ok.length} · other-bucket ${otherBucket.length} (${fmtM(sum(otherBucket))}) · missing ${missing.length} (${fmtM(sum(missing))}) · no-link ${noId.length}`);

  // ---- 1. other bucket → extra_artist_songs -------------------------------
  // Only when the current owner is a TRACKED artist. An untracked owner means
  // the track shows on nobody's page, so linking it here would be inventing
  // membership rather than mirroring kworb's every-credited-artist rule.
  const linkable = otherBucket
    .filter((t) => t.ownerTracked && t.headId)
    .sort((a, b) => b.streams - a.streams)
    .slice(0, MAX_LINKS_PER_ARTIST);
  let linked = 0;
  let repaired = 0;   // streams this pass accounted for — see kworb_audit.repaired_streams
  for (const t of linkable) {
    console.log(`[reconcile]   link ${String(fmtM(t.streams)).padStart(8)}  ${t.title}  ← ${ours.names.get(t.owner) || t.owner}`);
    repaired += t.streams;
    if (DRY_RUN) { linked++; continue; }
    // Always pin the CANONICAL HEAD (classify resolved it): the dashboard only
    // ever renders heads, so a pin on the alias id kworb happened to link would
    // be a silent no-op.
    const r = await client.query(
      'INSERT INTO extra_artist_songs (artist_id, song_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [artistId, t.headId]
    );
    linked += r.rowCount;
  }

  // ---- 2. missing → extra_scrape_albums -----------------------------------
  // Resolving costs a browser pageload each, so: skip the long tail below
  // MIN_STREAMS, and skip ids a previous pass already resolved to no useful
  // action (kworb_audit.unresolved) — otherwise every run re-pays for the same
  // permanently-unfixable rows.
  const priorRes = await client.query('SELECT unresolved FROM kworb_audit WHERE artist_id = $1', [artistId]);
  const priorUnresolved = new Set(
    FORCE ? [] : (priorRes.rows[0]?.unresolved || []).map((u) => (typeof u === 'string' ? u : u.trackId))
  );
  const pinnedRes = await client.query('SELECT album_id FROM extra_scrape_albums WHERE artist_id = $1', [artistId]);
  const alreadyPinned = new Set(pinnedRes.rows.map((r) => r.album_id));

  const toResolve = missing
    .filter((t) => t.streams >= MIN_STREAMS && !priorUnresolved.has(t.trackId))
    .sort((a, b) => b.streams - a.streams)
    .slice(0, MAX_RESOLVE_PER_ARTIST);

  let pinned = 0;
  const unresolved = [];
  // Everything we chose not to resolve stays on the manual tail so it's visible
  // (and so we don't silently drop it from the record).
  for (const t of missing) {
    if (!toResolve.includes(t)) unresolved.push({ trackId: t.trackId, title: t.title, streams: t.streams, why: priorUnresolved.has(t.trackId) ? 'prior-pass' : 'below-min' });
  }

  if (toResolve.length) {
    console.log(`[reconcile]   resolving ${toResolve.length} missing track(s) via Spotify…`);
    const page = await getPage();
    const resolved = await resolveTracks(page, toResolve.map((t) => t.trackId));
    const seen = new Set();
    for (const t of toResolve) {
      const a = resolved.get(t.trackId);
      if (!a) { unresolved.push({ trackId: t.trackId, title: t.title, streams: t.streams, why: 'unresolved' }); continue; }
      // THE guard: Spotify itself must credit this artist on the track. An EMPTY
      // credit list is a parse failure, not a verdict — flag it separately so a
      // schema change shows up as "credits-unknown" instead of quietly looking
      // like a clean "kworb was wrong about all 18 of these".
      if (!a.artistUris.length) {
        console.log(`[reconcile]   skip ${String(fmtM(t.streams)).padStart(8)}  ${t.title} — no credits returned (schema change?)`);
        unresolved.push({ trackId: t.trackId, title: t.title, streams: t.streams, why: 'credits-unknown' });
        continue;
      }
      if (!a.artistUris.includes(artistUri)) {
        console.log(`[reconcile]   skip ${String(fmtM(t.streams)).padStart(8)}  ${t.title} — Spotify does not credit this artist`);
        unresolved.push({ trackId: t.trackId, title: t.title, streams: t.streams, why: 'not-credited' });
        continue;
      }
      // One pinned album usually covers SEVERAL missing tracks (a remix EP), so a
      // track landing on an album already pinned this pass — or pinned earlier —
      // is repaired too, not skipped silently.
      if (seen.has(a.albumId) || alreadyPinned.has(a.albumId)) { repaired += t.streams; continue; }
      if (pinned >= MAX_PINS_PER_ARTIST) { unresolved.push({ trackId: t.trackId, title: t.title, streams: t.streams, why: 'pin-cap' }); continue; }
      seen.add(a.albumId);
      repaired += t.streams;
      console.log(`[reconcile]   pin  ${String(fmtM(t.streams)).padStart(8)}  ${a.albumName} (${a.albumId})  ← ${t.title}`);
      if (DRY_RUN) { pinned++; continue; }
      await upsertAlbum(client, { id: a.albumId, title: a.albumName, release_date: a.release, image_url: a.coverUrl });
      const r = await client.query(
        `INSERT INTO extra_scrape_albums (artist_id, album_id, title, release_date, is_featured, source, note)
         VALUES ($1, $2, $3, $4, true, 'kworb', $5) ON CONFLICT DO NOTHING`,
        [artistId, a.albumId, a.albumName, a.release, `auto-pinned for "${t.title}" (~${fmtM(t.streams)})`]
      );
      pinned += r.rowCount;
    }
  }

  if (!DRY_RUN) {
    await client.query(
      `INSERT INTO kworb_audit (artist_id, checked_at, kworb_total, our_total, kworb_tracks, our_tracks, gap, repaired_streams, linked_count, pinned_count, unresolved, error)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, NULL)
       ON CONFLICT (artist_id) DO UPDATE
         SET checked_at = NOW(), kworb_total = EXCLUDED.kworb_total, our_total = EXCLUDED.our_total,
             kworb_tracks = EXCLUDED.kworb_tracks, our_tracks = EXCLUDED.our_tracks, gap = EXCLUDED.gap,
             repaired_streams = EXCLUDED.repaired_streams,
             linked_count = EXCLUDED.linked_count, pinned_count = EXCLUDED.pinned_count,
             unresolved = EXCLUDED.unresolved, error = NULL`,
      [artistId, kworb.headerStreams, Math.round(ours.ourTotal), kworb.tracks.length, ours.ourCount,
       Math.round(gap), Math.round(repaired), linked, pinned, JSON.stringify(unresolved)]
    );
  }

  console.log(`[reconcile]   → linked ${linked}, pinned ${pinned}${pinned ? ' (live after the next scrape of this artist)' : ''}, repaired ${fmtM(repaired)}, residual ${fmtM(gap - repaired)}, manual tail ${unresolved.length}`);
  return { linked, pinned, unresolved: unresolved.length };
}

(async () => {
  if (!process.env.DATABASE_URL) { console.error('[reconcile] DATABASE_URL missing.'); process.exit(1); }
  const pool = getPool();
  const client = await pool.connect();

  // The browser is only needed for MISSING tracks, so it's opened lazily — a run
  // where everyone is already reconciled costs nothing but a few HTTP fetches.
  let browser = null, page = null;
  const getPage = async () => {
    if (!page) {
      if (!process.env.SP_DC) throw new Error('SP_DC missing — cannot resolve albums');
      const { launchBrowser } = require('./spotify');
      ({ browser, page } = await launchBrowser(process.env.SP_DC));
    }
    return page;
  };

  try {
    const artists = await pickArtists(client);
    if (!artists.length) {
      console.log(`[reconcile] Nothing due (cooldown ${COOLDOWN_HOURS}h). Use --force to re-check.`);
      return;
    }
    const batch = artists.slice(0, MAX_ARTISTS);
    console.log(`[reconcile] ${artists.length} artist(s) due, doing ${batch.length} this run${DRY_RUN ? ' (DRY RUN)' : ''}: ${batch.map((a) => a.name).join(', ')}`);

    let totals = { linked: 0, pinned: 0 };
    for (const a of batch) {
      if (Date.now() - RUN_START > BUDGET_MS) {
        console.log(`[reconcile] ⏱️ budget reached — remaining artists roll over to the next run.`);
        break;
      }
      try {
        const r = await reconcileArtist(client, a, getPage);
        totals.linked += r.linked;
        totals.pinned += r.pinned;
      } catch (err) {
        // One artist's failure (kworb 404/layout change, Spotify hiccup) must not
        // take the run down — record it and move on.
        console.error(`[reconcile] ${a.name}: FAILED — ${err.message}`);
        if (!DRY_RUN) {
          await client.query(
            `INSERT INTO kworb_audit (artist_id, checked_at, error) VALUES ($1, NOW(), $2)
             ON CONFLICT (artist_id) DO UPDATE SET checked_at = NOW(), error = EXCLUDED.error`,
            [a.artist_id, err.message]
          ).catch(() => {});
        }
      }
    }
    console.log(`\n[reconcile] ✅ linked ${totals.linked} collab track(s), pinned ${totals.pinned} album(s).`);
    if (totals.pinned) console.log('[reconcile]    Pinned albums are scraped on this artist\'s next scrape run.');
  } finally {
    client.release();
    await closePool();
    if (browser) await browser.close();
  }
})().catch((e) => { console.error('[reconcile] FATAL', e.message); process.exit(1); });

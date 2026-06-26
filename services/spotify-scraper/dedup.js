/**
 * Canonical song deduplication.
 *
 * Aynı şarkının farklı release'lerini gruplar:
 *   - Normalize edilmiş title eşleşirse
 *   - Duration ±4000ms toleransla aynıysa
 *   - VE aynı linked kayıtsa: playcount'lar drift toleransı içinde eşitse
 *     (Spotify linked kopyalarda aynı sayacı gösterir; aynı saat içinde farklı
 *     albümlerden scrape edilince binde birkaç oynar — birebir eşitlik İSTEME)
 *     YA DA kopyalardan biri donmuşsa (2+ gündür snapshot yok = delisted/hidden,
 *     sayacı geride kalmış linked kopya — FSLS standard vakası).
 *   - Bağımsız sayaçlı canlı kopyalar (re-recording'ler, örn. SKZ compilation
 *     versiyonları) MERGE EDİLMEZ — kworb gibi ikisi de ayrı sayılır.
 *   - Farklı dashboard artist bucket'ları ASLA merge edilmez.
 *
 * Canonical seçimi (öncelik sırası):
 *   1) Own (is_featured=false) > Featured
 *   2) Eski release_date > Yeni (orijinal albüm tercih)
 *   3) Track ID lexicographic (deterministic)
 */

const DURATION_TOLERANCE_MS = 4000;
// Wider tolerance applied only when two same-title copies have the EXACT same
// playcount (a near-certain linked-copy signal). Catches metadata-noise duration
// gaps (~4-10s) while still keeping genuinely different cuts (e.g. a 22s radio
// edit) apart.
const EXACT_MATCH_DURATION_TOLERANCE_MS = 12000;

// Linked kopya sayaç drift toleransı: aynı kayıt, scrape zamanı farkından
// kaynaklı sapma. Saatlik gain en büyük şarkıda bile %0.05'i geçmez; %0.5
// hem drift'i rahat kapsar hem de gerçek re-recording'leri (%10+) ayırır.
const LINKED_COUNT_TOLERANCE = 0.005;

// Default frozen eşiği: bir kopyanın last snapshot'ı global max'ten 1+ tam gün
// gerideyse donmuş sayılır (delisted/hidden/standart edition gibi linked-ama-
// scrape-edilmeyen kopyalar). 1 gün, Spotify'ın bir günlük gecikmesini tolere
// eder ve hâlâ FIFA WC Goals tipi 2 günlük gap'leri yakalar.
const DEFAULT_FROZEN_AFTER_MS = 24 * 60 * 60 * 1000;

// Per-artist override'lar: bağımsız sayaçlı canlı kopyaları olan sanatçılar
// için frozen eşiğini yukarı çek — re-recording'ler tek günlük başarısız bir
// scrape yüzünden yanlışlıkla orijinaliyle birleştirilmesin.
const ARTIST_FROZEN_AFTER_MS = {
  // Stray Kids: SKZ2020 ve diğer compilation'larda bağımsız sayaçlı çoklu
  // re-recording var — bunlar her gün canlı scrape ediliyor. 7 gün eşiği bir
  // hafta üst üste scrape kaçırılsa bile re-recording'leri korur.
  'spotify:artist:2dIgFjalVxs4ThymZ67YCE': 7 * 24 * 60 * 60 * 1000,
};
const frozenThresholdFor = (pa) => ARTIST_FROZEN_AFTER_MS[pa] ?? DEFAULT_FROZEN_AFTER_MS;

// JT, catch-all bucket'tır ("adlı hiçbir sanatçıya ait olmayan her şey").
// Named-artist setinden DIŞLANIR ki diğer 'collab' parçalarıyla aynı havuzda
// merge edebilsin. server.js'teki JT_ARTIST_ID ile aynı olmalı.
const JT_ARTIST_ID = '31TPClRtHm23RisEBtV3X7';

// Dashboard artist bucket'ları. KAYNAK = tracked_artists tablosu (server.js
// allArtistsCache ile aynı). Aşağıdaki liste yalnızca tablo okunamazsa devreye
// giren FALLBACK'tir; gerçek set runtime'da `loadNamedArtists()` ile DB'den
// yüklenir. Böylece panelden eklenen yeni sanatçı (Britney gibi) otomatik kendi
// bucket'ını alır ve catch-all'a sızıp aşırı-merge olmaz.
// Farklı bucket'lardaki şarkılar asla merge edilmez — jenerik isimli
// (Intro, Forever...) şarkıların sanatçılar arası yapışmasını önler.
const NAMED_ARTISTS_FALLBACK = new Set([
  'spotify:artist:5L1lO4eRHmJ7a0Q6csE5cT', // LISA
  'spotify:artist:1HY2Jd0NmPuamShAr6KMms', // Lady Gaga
  'spotify:artist:6qqNVTkY8uBg9cP3Jd7DAH', // Billie Eilish
  'spotify:artist:66CXWjxzNUsdJxJ2JdwvnR', // Ariana Grande
  'spotify:artist:6Ff53KvcvAj5U7Z1vojB5o', // *NSYNC
  'spotify:artist:3p3U04w2DaiBzuYMZnYr00', // JC Chasez
  'spotify:artist:3LHYvj5ZejV1NLqncEObSJ', // Vaelis
  'spotify:artist:2dIgFjalVxs4ThymZ67YCE', // Stray Kids
  'spotify:artist:4UIOuc84ExWojcUzFGtb8W', // Felix
  'spotify:artist:2W8yFh0Ga6Yf3jiayVxwkE', // Dove Cameron
  'spotify:artist:4qwGe91Bz9K2T8jXTZ815W', // Janet Jackson
]);

// tracked_artists'ten named-artist setini yükle (JT hariç). Tablo yoksa
// fallback'e düşer — davranış birebir eski hardcoded liste gibi olur.
async function loadNamedArtists(client) {
  try {
    const { rows } = await client.query(
      `SELECT artist_id FROM tracked_artists WHERE artist_id <> $1`,
      [JT_ARTIST_ID]
    );
    if (rows.length) {
      const set = new Set(rows.map(r => `spotify:artist:${r.artist_id}`));
      // Fallback'teki sanatçıları da union'la — tablo eksikse bile korunsunlar.
      for (const uri of NAMED_ARTISTS_FALLBACK) set.add(uri);
      return set;
    }
  } catch (e) {
    console.warn('[dedup] tracked_artists okunamadı, fallback named-artist seti:', e.code || e.message);
  }
  return new Set(NAMED_ARTISTS_FALLBACK);
}

// Adlı sanatçı değilse JT/collab havuzu — kendi içinde merge serbest.
const bucketOfWith = (namedArtists, pa) => (namedArtists.has(pa) ? pa : 'collab');

// Track IDs that must always remain independent — never merge into another canonical
const NEVER_MERGE = new Set([
  '6ToFxXRBtl5TJFEyIoYK3f', // Mirrors - Radio Edit (own streams, not a duplicate)
  '3VLiciQpebHm9Tbz3xNqKf', // Mirrors (Live) (own streams, not a duplicate)
  '1JmPASoql4lnXimD5ICqRP', // Not a Bad Thing (Short/Radio Edit version)
]);

// Force specific track IDs to be aliases of a given canonical (applied after main dedup)
const FORCE_CANONICAL = {
  '5oUnVKzkdNTaLtn4EnJjEP': '6ToFxXRBtl5TJFEyIoYK3f', // Mirrors - Radio Edit copy → main Radio Edit
  '6Ffur3eTvi1KhHwu7b9TQd': '6ToFxXRBtl5TJFEyIoYK3f', // Mirrors - Radio Edit copy → main Radio Edit
  '2iWljCivLjWnLkwItPZdRV': '13X42np3KJr0o2LkK1MG76', // My Love (Single Version) → My Love (Main Version)
  '24CBAWq81pQNTftNAxVLYk': '0Gasl1wiqhENYa8RskLpPw', // (Another Song) All Over Again FSLS standard → deluxe
  '2odDiXqmvqGNKzHUoEGTHB': '3hdGyxmW0eNskNwTwmXOIQ', // LISA Goals (FIFA WC 2026 standard, frozen) → Opening Ceremony Edition canonical
  '5GP8vMD6WaOffDeJfbit0m': '6ic8OlLUNEATToEFU3xmaH', // Gimme More ("Kimme More" Remix) (feat. Lil' Kim) → Gimme More (original)

  // Cardi B "ErrTime" remixes on AM I THE DRAMA (Ultimate Edition)/(The Snow Mix):
  // Spotify links these remix tracks to the ORIGINAL's playcount (byte-identical
  // count + duration), so Pass 2 merged them into the wrong canonical (plain
  // ErrTime / the Jeezy&Latto version) and the album view collapsed them away.
  // Re-point each to its OWN standalone-remix canonical so it shows as a distinct
  // row with its own streams. No total change — the targets are already counted heads.
  '1QonoQ0WvX2xYX5BNhTIeQ': '5CanskmqatfFbm9O9Epavt', // ErrTime (feat. Latto) [Remix] — Ultimate → standalone Latto remix
  '712SSg5i3QMK2yA7v2oV1D': '5CanskmqatfFbm9O9Epavt', // ErrTime (feat. Latto) [Remix] — Snow Mix → standalone Latto remix
  '6CbbaIFRxszOfvFN9ljlTk': '1dtdgZK7egg2fBVoeC0T5i', // ErrTime (feat. Jeezy) [Remix] — Ultimate → standalone Jeezy remix

  // Christina Aguilera "Moves Like Jagger": the "- Radio Edit" copy (1qIX, on a
  // junk comp) is the SAME linked recording as the "Studio Recording From The
  // Voice Performance" cluster (identical 2,190,350,928 play count). Admin merges
  // folded the Studio copies together but left the Radio Edit as its own head, so
  // the 2.19B recording was counted TWICE. Re-point it onto the Studio head; the
  // chain-flatten step then collapses the whole group (incl. the admin-rule 2-cycle)
  // onto one root, so it counts once. Drops Christina's bucket ~15.5B → ~11.1B
  // (kworb 10.97B). The 5 silent Studio dupes already fold here automatically.
  '1qIX1lGLyeCb2kxrb1ftRf': '1YsMJDSKkkyHcEvs52GXAe',
};

/**
 * Title normalization — versionsuz/featuresız ham hali.
 *  - lowercase
 *  - "(feat ...)" / "(with ...)" / "(featuring ...)" çıkar
 *  - "[Explicit]" / "[Clean]" çıkar
 *  - "(Remastered)" / "(20th Anniversary)" / "(Deluxe)" çıkar
 *  - punctuation normalize, whitespace collapse
 */
function normalizeTitle(title) {
  if (!title) return '';
  let t = title.toLowerCase();
  
  // Keep duet version of Until the End of Time separate from the solo version
  if (t.includes('until the end of time') && t.includes('beyoncé')) {
    return 'until the end of time duet';
  }
  
  t = t.replace(/\s*[\(\[][^\)\]]*(?:feat|featuring|with|ft\.?|ne-yo|bebe|spears|minaj|timberlake|lisa|gaga|eilish|grande|nsync|chasez|vaelis|stray|felix|dove|janet)\.?[^\)\]]*[\)\]]/gi, '');
  t = t.replace(/\s*[\(\[][^\)\]]*(?:remaster|remix|mix|version|edition|edit|anniversary|deluxe|bonus|instrumental|clean|explicit|live|acoustic|radio|extended|interlude|new\s+version|original|from)[^\)\]]*[\)\]]/gi, '');
  t = t.replace(/\s*-\s*(?:remaster|remix|version|edition|edit|anniversary|deluxe|bonus|instrumental|clean|explicit|live|acoustic|radio|extended|new\s+version|original|album\s+version|from).*$/gi, '');
  t = t.replace(/\b(?:interlude|explicit|clean|deluxe|remastered|remaster|album version)\b/gi, '');
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return t;
}

// Exact-stream-count auto-merge (Pass 2 in dedupCanonical) only fires above this
// floor. Spotify shows an identical play count, to the single stream, only for
// LINKED copies of one recording — so an exact match inside one artist bucket is
// a near-certain "same recording" signal. The ONE failure mode is coincidence at
// tiny counts (two unrelated B-sides both at, say, 200 streams — see the
// "Give It To Me" test fixture). A high floor removes that: two genuinely
// different songs essentially never share an exact integer count this large.
const EXACT_MERGE_FLOOR = 1_000_000;

// Words that survive normalizeTitle but carry no identity (so they don't count
// as a shared "this is the same song" token in the exact-count pass).
const TITLE_STOPWORDS = new Set([
  'version', 'remix', 'edit', 'mix', 'live', 'feat', 'with', 'from', 'original',
  'remaster', 'remastered', 'deluxe', 'radio', 'single', 'album', 'part',
  'club', 'extended', 'instrumental', 'acoustic',
]);

// True if two titles share a meaningful word (≥4 chars, not a stopword). Pairs
// the exact-count signal with a sanity check so two unrelated songs that happen
// to collide on a play count are still never glued together.
function shareSignificantToken(a, b) {
  const toks = (t) => new Set(
    normalizeTitle(t).split(' ').filter(w => w.length >= 4 && !TITLE_STOPWORDS.has(w))
  );
  const setB = toks(b);
  for (const w of toks(a)) if (setB.has(w)) return true;
  return false;
}

/**
 * Album scoring — eski ve own daha iyi.
 */
function scoreCanonical(song) {
  let score = 0;
  if (!song.is_featured) score += 1_000_000_000;
  if (song.release_date) {
    const year = parseInt(song.release_date.toISOString().slice(0, 4), 10);
    score += (3000 - year) * 100_000;
  }
  // Hardcoded overrides to force specific track IDs to be canonical
  if (song.id === '71BEy8FVmk4BCQ2TGhLlvm') {
    score += 500000000; // Force Love Train correct ID
  }
  if (song.id === '4NH5VZpm6y2Erde00suNUa') {
    score += 500000000; // Force What Goes Around main version ID
  }
  return score;
}

async function dedupCanonical(client) {
  console.log('[dedup] Canonical eşleştirme başlıyor...');

  // Named-artist seti = tracked_artists (JT hariç). Panelden eklenen sanatçılar
  // (Britney gibi) burada kendi bucket'larını alır → catch-all'a sızıp aşırı
  // merge olmazlar.
  const namedArtists = await loadNamedArtists(client);

  const maxDateRes = await client.query(`SELECT MAX(recorded_date) AS max_d FROM stream_stats`);
  const maxDate = maxDateRes.rows[0]?.max_d ? new Date(maxDateRes.rows[0].max_d).getTime() : 0;

  const { rows } = await client.query(`
    SELECT s.id, s.title, s.duration_ms, s.is_featured, s.album_id, s.primary_artist,
           a.release_date,
           COALESCE((SELECT MAX(stream_count) FROM stream_stats WHERE song_id = s.id), 0)::bigint AS max_streams,
           (SELECT MAX(recorded_date) FROM stream_stats WHERE song_id = s.id) AS last_date
    FROM songs s
    LEFT JOIN albums a ON a.id = s.album_id
    WHERE s.duration_ms IS NOT NULL
  `);

  // Normalize key → song[]
  const groups = new Map();
  for (const r of rows) {
    const key = normalizeTitle(r.title);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  let canonicalCount  = 0;
  let aliasCount      = 0;
  let resetCount      = 0;

  // Track the title-pass result so Pass 2 (exact-count) can skip already-merged
  // aliases and re-point a merged canonical's own aliases (never build a chain).
  const isAlias  = new Set();   // ids merged under some canonical
  const aliasesOf = new Map();  // canonicalId -> [aliasId, …]

  // Önce tüm canonical_id'leri sıfırla
  const reset = await client.query(`UPDATE songs SET canonical_id = NULL WHERE canonical_id IS NOT NULL`);
  resetCount = reset.rowCount;

  // Admin paneli kuralları (migration 016). Merge kuralı alias→canonical bağını
  // nightly reset'ten sonra tekrar uygular; split kuralı bir track'i bağımsız
  // sabitler (NEVER_MERGE gibi). Tablo yoksa sessizce atla.
  const manualMerge = {};        // aliasId -> canonicalId
  const manualSplit = new Set(); // bağımsız kalacak id'ler
  try {
    const mm = await client.query(`SELECT alias_id, canonical_id FROM manual_merges`);
    for (const row of mm.rows) {
      if (row.canonical_id) manualMerge[row.alias_id] = row.canonical_id;
      else manualSplit.add(row.alias_id);
    }
  } catch (e) {
    console.warn('[dedup] manual_merges tablosu yok/okunamadı:', e.code || e.message);
  }

  // Every id touched by a manual rule (as alias OR canonical). Pass 2 must leave
  // these alone: the rules are applied last and set their own direction, so if
  // Pass 2 merged the pair the other way first, the two would end up pointing at
  // each other (a canonical_id cycle) — both then drop out of the dashboard,
  // since neither is a NULL-canonical representative anymore.
  const manualIds = new Set([
    ...Object.keys(manualMerge),
    ...Object.values(manualMerge),
    ...manualSplit,
  ]);

function shouldKeepSeparate(title) {
  const lower = title.toLowerCase();
  return lower.includes('live') || 
         lower.includes('instrumental') || 
         lower.includes('remix') || 
         lower.includes('acoustic') ||
         lower.includes('performance') ||
         lower.includes('acapella') ||
         lower.includes('karaoke') ||
         lower.includes('tribute');
}

  for (const [key, items] of groups) {
    if (items.length < 2) continue;

    // Duration cluster'ları içinde grupla
    const clusters = [];
    for (const item of items) {
      // Skip tracks that must remain independent
      if (NEVER_MERGE.has(item.id) || manualSplit.has(item.id)) continue;
      let placed = false;
      for (const cluster of clusters) {
        const ref = cluster[0];

        // Farklı dashboard bucket'larındaki şarkılar asla birleşmez
        if (bucketOfWith(namedArtists, item.primary_artist) !== bucketOfWith(namedArtists, ref.primary_artist)) continue;

        // Prevent merging different versions (live, instrumental, etc.) for all artists
        const isRefSpecial = shouldKeepSeparate(ref.title);
        const isItemSpecial = shouldKeepSeparate(item.title);
        if (isRefSpecial !== isItemSpecial) continue;
        if (isRefSpecial && isItemSpecial) {
          const refTitleLower = ref.title.toLowerCase();
          const itemTitleLower = item.title.toLowerCase();
          if (refTitleLower.includes('live') !== itemTitleLower.includes('live')) continue;
          if (refTitleLower.includes('instrumental') !== itemTitleLower.includes('instrumental')) continue;
          if (refTitleLower.includes('remix') !== itemTitleLower.includes('remix')) continue;
          if (refTitleLower.includes('acoustic') !== itemTitleLower.includes('acoustic')) continue;
          if (refTitleLower.includes('performance') !== itemTitleLower.includes('performance')) continue;
        }

        const a = Number(item.max_streams) || 0;
        const b = Number(ref.max_streams) || 0;

        // EXACT same non-zero playcount = almost certainly the same linked
        // recording (Spotify only shows identical counts, to the single stream,
        // for linked copies). In that case widen the duration tolerance so a few
        // seconds of metadata noise (remaster length / edition tagging) doesn't
        // split them — this is what split JT's "(Another Song) All Over Again"
        // (4.0s spread) and Felix's "ReawakeR". We still cap it (12s) so genuinely
        // different cuts that merely share a count stay apart (e.g. a 22s-shorter
        // radio edit of "Give It To Me").
        const exactSameStreams = a > 0 && a === b;
        const durTol = exactSameStreams ? EXACT_MATCH_DURATION_TOLERANCE_MS : DURATION_TOLERANCE_MS;
        if (Math.abs(item.duration_ms - ref.duration_ms) > durTol) continue;

        // Linked kopya mı? Sayaçlar drift toleransı içinde eşitse aynı kayıttır.
        // Henüz hiç snapshot'ı olmayan yeni kopya da merge edilir (eski fallback).
        const sameLinkedCount = a === 0 || b === 0 ||
          Math.abs(a - b) <= Math.max(a, b) * LINKED_COUNT_TOLERANCE;

        // Donmuş kopya: artist-bazlı eşik kadar süredir snapshot yok
        // (delisted/hidden) — sayacı geride kalmış linked kopya, yine merge.
        // SKZ gibi bağımsız sayaçlı re-recording'i olan sanatçılarda eşik
        // yüksek, böylece tek günlük başarısız scrape'te re-recording'ler
        // yanlışlıkla orijinal ile birleştirilmez.
        const isFrozen = (d, pa) => {
          if (maxDate === 0) return false;
          if (!d) return true;
          const ms = frozenThresholdFor(pa);
          return new Date(d).getTime() < maxDate - ms;
        };
        const eitherFrozen = isFrozen(item.last_date, item.primary_artist) ||
                             isFrozen(ref.last_date, ref.primary_artist);

        if (sameLinkedCount || eitherFrozen) {
          cluster.push(item);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push([item]);
    }

    for (const cluster of clusters) {
      if (cluster.length < 2) continue;

      // En iyi skoru kazanan canonical
      cluster.sort((a, b) => {
        const sa = scoreCanonical(a), sb = scoreCanonical(b);
        if (sa !== sb) return sb - sa;
        return a.id.localeCompare(b.id);
      });

      const canonical = cluster[0];
      canonicalCount++;
      for (let i = 1; i < cluster.length; i++) {
        await client.query(
          `UPDATE songs SET canonical_id = $1 WHERE id = $2`,
          [canonical.id, cluster[i].id]
        );
        aliasCount++;
        isAlias.add(cluster[i].id);
        if (!aliasesOf.has(canonical.id)) aliasesOf.set(canonical.id, []);
        aliasesOf.get(canonical.id).push(cluster[i].id);
      }
    }
  }

  // ===== Pass 2: exact-stream-count auto-merge =====
  // The title pass above can only cluster copies whose titles normalize to the
  // same key. Real catalogs defeat that constantly — "… - Club Mix" vs
  // "… (Album Version)", an artist-name-prefixed title, oddly tagged remixes —
  // so linked copies of ONE recording end up in different groups and never get
  // compared. This is exactly the "same stream count" duplicates the admin had
  // to merge by hand. Here we auto-apply that signal: group every still-unmerged
  // representative by (bucket, exact play count) and merge the ones that also
  // share a significant title word. Guards: EXACT_MERGE_FLOOR (no coincidental
  // low-count collisions) and shareSignificantToken (no unrelated songs glued by
  // a coincidental count). FORCE_CANONICAL + manual rules below still override.
  const exactGroups = new Map(); // `${bucket}|${streams}` -> rows
  for (const r of rows) {
    if (isAlias.has(r.id) || NEVER_MERGE.has(r.id) || manualIds.has(r.id)) continue;
    const s = Number(r.max_streams) || 0;
    if (s < EXACT_MERGE_FLOOR) continue;
    const key = `${bucketOfWith(namedArtists, r.primary_artist)}|${s}`;
    if (!exactGroups.has(key)) exactGroups.set(key, []);
    exactGroups.get(key).push(r);
  }
  let exactCount = 0;
  const variantRe = /\b(?:remix|instrumental|a\s*cappella|acappella|mix|version|remaster(?:ed)?|edit|live|acoustic|karaoke)\b/i;
  for (const group of exactGroups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => {
      const sa = scoreCanonical(a), sb = scoreCanonical(b);
      if (sa !== sb) return sb - sa;
      // Tiebreak: keep the "plain" title (no remix/instrumental/… tag) as the
      // canonical so the dashboard shows the main version, not a variant.
      const va = variantRe.test(a.title) ? 1 : 0, vb = variantRe.test(b.title) ? 1 : 0;
      if (va !== vb) return va - vb;
      return a.id.localeCompare(b.id);
    });
    const canonical = group[0];
    for (let i = 1; i < group.length; i++) {
      const m = group[i];
      if (!shareSignificantToken(canonical.title, m.title)) continue;
      // Re-point m AND anything already merged under m, so no 2-level chains form.
      for (const id of [m.id, ...(aliasesOf.get(m.id) || [])]) {
        await client.query(`UPDATE songs SET canonical_id = $1 WHERE id = $2`, [canonical.id, id]);
        isAlias.add(id);
        exactCount++;
      }
    }
  }
  aliasCount += exactCount;

  // Apply forced canonical overrides
  for (const [trackId, canonId] of Object.entries(FORCE_CANONICAL)) {
    await client.query(
      `UPDATE songs SET canonical_id = $1 WHERE id = $2 AND canonical_id IS DISTINCT FROM $1`,
      [canonId, trackId]
    );
  }
  // Apply admin manual merge rules last (override the deduper + FORCE_CANONICAL).
  let manualCount = 0;
  for (const [trackId, canonId] of Object.entries(manualMerge)) {
    if (trackId === canonId) continue;
    const r = await client.query(
      `UPDATE songs SET canonical_id = $1 WHERE id = $2 AND canonical_id IS DISTINCT FROM $1`,
      [canonId, trackId]
    );
    manualCount += r.rowCount;
  }

  // Flatten canonical chains so every alias points STRAIGHT at a root, AND break
  // any canonical_id cycle (A→B→…→A). A manual rule or FORCE_CANONICAL can re-root
  // a canonical the title pass already merged into (X→Y, then Y→Z), leaving X→Y→Z;
  // the view resolves only one level, so the intermediate Y becomes a phantom
  // canonical — counted in the stat total but absent from the representative list.
  //
  // A pure 2-cycle (A→B, B→A) is worse: neither member is a NULL root, so the old
  // walk returned the cycle itself (root === canon) and left both pointing at each
  // other. Both then count in the stat total → the recording is double-counted.
  // This is exactly what tripled Christina's "Moves Like Jagger" (Radio Edit head
  // + a 0Hqe↔1YsMJ Studio cycle, all the same 2.19B linked count) and inflated her
  // bucket by ~4.4B. Now: when a walk re-enters a node, pick a deterministic head
  // for that cycle, detach it (canonical_id → NULL) and collapse every member and
  // any downstream alias onto it.
  let flattened = 0, cyclesBroken = 0;
  try {
    const all = await client.query(`SELECT id, canonical_id FROM songs WHERE canonical_id IS NOT NULL`);
    const canonOf = new Map(all.rows.map(r => [r.id, r.canonical_id]));
    const cycleHeadOf = new Map(); // any node sitting in a cycle -> chosen head id
    const resolve = (start) => {
      let cur = start; const path = []; const idx = new Map();
      while (canonOf.has(cur)) {
        if (cycleHeadOf.has(cur)) return cycleHeadOf.get(cur);
        if (idx.has(cur)) {                       // chain looped back → cycle
          const members = path.slice(idx.get(cur));
          const head = members.slice().sort()[0]; // deterministic representative
          for (const m of members) cycleHeadOf.set(m, head);
          return head;
        }
        idx.set(cur, path.length);
        path.push(cur);
        cur = canonOf.get(cur);
      }
      return cur;                                 // canonical_id IS NULL → real root
    };
    for (const [id, canon] of canonOf) {
      const root = resolve(id);
      if (root === id) {                          // chosen cycle head → become a root
        await client.query(`UPDATE songs SET canonical_id = NULL WHERE id = $1`, [id]);
        cyclesBroken++;
      } else if (root !== canon) {                // chain/cycle member → straight to root
        await client.query(`UPDATE songs SET canonical_id = $1 WHERE id = $2`, [root, id]);
        flattened++;
      }
    }
  } catch (e) {
    console.warn('[dedup] chain-flatten step failed:', e.code || e.message);
  }

  // Post-condition guard (cheap, read-only): after flatten EVERY alias must point
  // straight at a head whose own canonical_id is NULL. Any survivor means a chain
  // or cycle slipped through, and the stat total will silently double-count a
  // recording — the Christina 15.5B class of bug. Scream it into the run log so it
  // can never hide again instead of being noticed weeks later.
  try {
    const bad = await client.query(`
      SELECT a.id, a.canonical_id
      FROM songs a
      JOIN songs c ON c.id = a.canonical_id
      WHERE a.canonical_id IS NOT NULL AND c.canonical_id IS NOT NULL
      LIMIT 50`);
    if (bad.rows.length) {
      console.error(`[dedup] ⚠️ INTEGRITY FAIL: ${bad.rows.length}+ alias still point at a non-head (residual chain/cycle) — totals may double-count! e.g. ${bad.rows.slice(0, 5).map(r => `${r.id}→${r.canonical_id}`).join(', ')}`);
    } else {
      console.log('[dedup] integrity OK: every alias resolves to a NULL-canonical head (0 chains/cycles).');
    }
  } catch (e) {
    console.warn('[dedup] integrity check skipped:', e.code || e.message);
  }

  console.log(`[dedup] ${canonicalCount} canonical, ${aliasCount} alias bağlandı (${exactCount} exact-count auto-merge dahil; önceki ${resetCount} sıfırlandı). ${Object.keys(FORCE_CANONICAL).length} forced, ${manualCount} manual merge, ${manualSplit.size} manual split, ${flattened} chain flattened, ${cyclesBroken} cycle broken.`);
  return { canonicalCount, aliasCount };
}

module.exports = { dedupCanonical, normalizeTitle };

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
  
  t = t.replace(/\s*[\(\[][^\)\]]*(?:feat|featuring|with|ft\.?)\.?[^\)\]]*[\)\]]/gi, '');
  t = t.replace(/\s*[\(\[][^\)\]]*(?:remaster|remix|mix|version|edition|edit|anniversary|deluxe|bonus|instrumental|clean|explicit|live|acoustic|radio|extended|interlude|new\s+version|original|from)[^\)\]]*[\)\]]/gi, '');
  t = t.replace(/\s*-\s*(?:remaster|remix|version|edition|edit|anniversary|deluxe|bonus|instrumental|clean|explicit|live|acoustic|radio|extended|new\s+version|original|album\s+version|from).*$/gi, '');
  t = t.replace(/\b(?:interlude|explicit|clean|deluxe|remastered|remaster|album version)\b/gi, '');
  t = t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  return t;
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
      }
    }
  }

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
  console.log(`[dedup] ${canonicalCount} canonical, ${aliasCount} alias bağlandı (önceki ${resetCount} sıfırlandı). ${Object.keys(FORCE_CANONICAL).length} forced, ${manualCount} manual merge, ${manualSplit.size} manual split.`);
  return { canonicalCount, aliasCount };
}

module.exports = { dedupCanonical, normalizeTitle };

/**
 * Canonical song deduplication.
 *
 * Aynı şarkının farklı release'lerini gruplar:
 *   - Normalize edilmiş title eşleşirse
 *   - Duration ±2000ms toleransla aynıysa
 *
 * Canonical seçimi (öncelik sırası):
 *   1) Own (is_featured=false) > Featured
 *   2) Eski release_date > Yeni (orijinal albüm tercih)
 *   3) Track ID lexicographic (deterministic)
 */

const DURATION_TOLERANCE_MS = 4000;

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
  t = t.replace(/\s*-\s*(?:remaster|remix|version|edition|edit|anniversary|deluxe|bonus|instrumental|clean|explicit|live|acoustic|radio|extended|new\s+version|original|album\s+version).*$/gi, '');
  t = t.replace(/\b(?:interlude|explicit|clean|deluxe|remastered|remaster|album version)\b/gi, '');
  t = t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
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

  const { rows } = await client.query(`
    SELECT s.id, s.title, s.duration_ms, s.is_featured, s.album_id, s.primary_artist,
           a.release_date,
           (SELECT MAX(stream_count) FROM stream_stats WHERE song_id = s.id) as max_streams
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
      if (NEVER_MERGE.has(item.id)) continue;
      let placed = false;
      for (const cluster of clusters) {
        const ref = cluster[0];
        
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

        if (Math.abs(item.duration_ms - ref.duration_ms) <= DURATION_TOLERANCE_MS) {
          // Only merge if they share playcounts (max_streams is exactly equal), or if either has no streams yet
          const itemStreams = item.max_streams ? parseInt(item.max_streams, 10) : 0;
          const refStreams = ref.max_streams ? parseInt(ref.max_streams, 10) : 0;
          if (itemStreams > 0 && refStreams > 0) {
            if (itemStreams === refStreams) {
              cluster.push(item);
              placed = true;
              break;
            }
          } else {
            // Fallback: if either is new and has no streams yet, merge them
            cluster.push(item);
            placed = true;
            break;
          }
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
  console.log(`[dedup] ${canonicalCount} canonical, ${aliasCount} alias bağlandı (önceki ${resetCount} sıfırlandı). ${Object.keys(FORCE_CANONICAL).length} forced.`);
  return { canonicalCount, aliasCount };
}

module.exports = { dedupCanonical, normalizeTitle };

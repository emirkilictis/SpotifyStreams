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
  t = t.replace(/\s*[\(\[][^)\]]*(?:feat|featuring|with|ft\.?)\.?[^)\]]*[\)\]]/gi, '');
  t = t.replace(/\s*[\(\[][^)\]]*(?:remaster|remix|mix|version|edition|edit|anniversary|deluxe|bonus|instrumental|clean|explicit|live|acoustic|radio|extended|interlude|new\s+version|original|from)[^)\]]*[\)\]]/gi, '');
  t = t.replace(/\s*-\s*(?:remaster|remix|version|edition|edit|anniversary|deluxe|bonus|instrumental|clean|explicit|live|acoustic|radio|extended|new\s+version|original).*$/gi, '');
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
  // Track ID lexicographic (ters çevir = küçük lex önce kazansın)
  return score;
}

async function dedupCanonical(client) {
  console.log('[dedup] Canonical eşleştirme başlıyor...');

  const { rows } = await client.query(`
    SELECT s.id, s.title, s.duration_ms, s.is_featured, s.album_id,
           a.release_date
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

  for (const [key, items] of groups) {
    if (items.length < 2) continue;

    // Duration cluster'ları içinde grupla
    const clusters = [];
    for (const item of items) {
      let placed = false;
      for (const cluster of clusters) {
        const ref = cluster[0];
        if (Math.abs(item.duration_ms - ref.duration_ms) <= DURATION_TOLERANCE_MS) {
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

  console.log(`[dedup] ${canonicalCount} canonical, ${aliasCount} alias bağlandı (önceki ${resetCount} sıfırlandı).`);
  return { canonicalCount, aliasCount };
}

module.exports = { dedupCanonical, normalizeTitle };

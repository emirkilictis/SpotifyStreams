/**
 * diagnose-discovery.js — Spotify bu sanatci icin KAC yayin veriyor, bizde
 * kaci var?
 *
 * Katalog raporu "kesfedilmis her sey okunmus" dedi, yani eksik tarama degil
 * kesif. Kesif iki kaynaktan besleniyor: sanatcinin kendi diskografisi ve
 * "Appears On" rafi. Bu betik ikisini de CANLI cekip bizdekiyle karsilastirir
 * ve eksik olan yayinlari tek tek yazar.
 *
 * Ayrica bizim SARKI sayimiz ile BAS sayimizi ayri basar: Kworb her track
 * id'sini ayri satir sayar, biz ayni kaydin surumlerini birlestirip tek
 * sayiyoruz. Aradaki farkin ne kadari bu, ne kadari gercek eksik — ancak
 * ikisi ayri basilirsa gorulur.
 *
 *   DATABASE_URL=... SP_DC=... node diagnose-discovery.js <artistId> [...]
 */
const { launchBrowser, fetchArtistAlbums, fetchArtistAppearsOn } = require('./spotify');
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const fmt = n => Number(n || 0).toLocaleString('en-US');

async function main() {
  const ids = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!ids.length) { console.error('Kullanim: node diagnose-discovery.js <artistId> ...'); process.exit(1); }
  const client = await getPool().connect();
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  try {
    for (const id of ids) {
      const uri = `spotify:artist:${id}`;
      const nm = await client.query(`SELECT name FROM tracked_artists WHERE artist_id = $1`, [id]);
      console.log(`\n=== ${nm.rows[0]?.name || id}  (${id})`);

      let own = [], feat = [];
      try { own = await fetchArtistAlbums(page, id); }
      catch (e) { console.log(`  [!] kendi diskografisi okunamadi: ${e.message}`); }
      try { feat = await fetchArtistAppearsOn(page, id); }
      catch (e) { console.log(`  [!] Appears On okunamadi: ${e.message}`); }

      const canli = new Map();
      for (const a of own)  canli.set(a.id, { title: a.title, kaynak: 'kendi' });
      for (const a of feat) if (!canli.has(a.id)) canli.set(a.id, { title: a.title, kaynak: 'feature' });
      console.log(`  Spotify'in verdigi yayin : ${fmt(canli.size)}   (kendi ${fmt(own.length)} · appears-on ${fmt(feat.length)})`);

      const bizde = await client.query(
        `SELECT DISTINCT al.id FROM albums al JOIN songs s ON s.album_id = al.id
          WHERE s.primary_artist = $1 OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $2)`,
        [uri, id]);
      const bizdeSet = new Set(bizde.rows.map(r => r.id));
      console.log(`  bizdeki yayin            : ${fmt(bizdeSet.size)}`);

      const eksik = [...canli.entries()].filter(([aid]) => !bizdeSet.has(aid));
      console.log(`  EKSIK yayin              : ${fmt(eksik.length)}`);
      const eksikFeat = eksik.filter(([, v]) => v.kaynak === 'feature').length;
      console.log(`     bunun ${fmt(eksikFeat)} tanesi appears-on, ${fmt(eksik.length - eksikFeat)} tanesi kendi diskografisi`);
      for (const [aid, v] of eksik.slice(0, 25)) console.log(`       ${v.kaynak.padEnd(7)} ${v.title}  (${aid})`);
      if (eksik.length > 25) console.log(`       ... ve ${fmt(eksik.length - 25)} tane daha`);

      const say = await client.query(`
        SELECT COUNT(*)::int AS sarki,
               COUNT(DISTINCT COALESCE(s.canonical_id, s.id))::int AS bas
          FROM songs s
         WHERE s.primary_artist = $1 OR s.id IN (SELECT song_id FROM extra_artist_songs WHERE artist_id = $2)`,
        [uri, id]);
      const { sarki, bas } = say.rows[0];
      console.log(`  bizdeki sarki ${fmt(sarki)} → ${fmt(bas)} bas  (${fmt(sarki - bas)} surum birlestirildi)`);
      console.log(`  NOT: Kworb her track id'sini ayri sayar; sayfa bas sayar. Bu fark tasarim geregi.`);
    }
  } finally {
    client.release();
    await browser.close();
    await closePool();
  }
}

main().catch(e => { console.error('[kesif] HATA:', e.message); process.exit(1); });

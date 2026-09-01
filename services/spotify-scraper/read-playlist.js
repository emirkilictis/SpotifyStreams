/**
 * read-playlist.js — bir Spotify playlist'indeki track id'lerini basar.
 *
 * NEDEN VAR. Fanlar eksik şarkıları playlist yapıp gönderiyor (Anitta iki kez,
 * Ariana bir kez). Her seferinde linkleri elle açıp id toplamak yerine bu araç
 * playlist'i okuyup id'leri veriyor; çıktısı doğrudan pin-tracks.js'e giriyor:
 *
 *   node read-playlist.js <playlistUrl>                     # id + baslik listesi
 *   node read-playlist.js --ids <playlistUrl>                # sadece id'ler
 *   node read-playlist.js --ids <url> | xargs node pin-tracks.js --artist=<id>
 *
 * NASIL OKUR. Playlist sayfası sanallaştırılmış — DOM'da aynı anda yalnızca
 * görünen satırlar var, yani tek bir okuma listenin tamamını vermiyor. O yüzden
 * sayfanın kendi GraphQL (pathfinder) cevapları dinleniyor ve gelen JSON'da
 * spotify:track:<id> taşıyan her düğüm toplanıyor. Sayfa sonuna kadar
 * kaydırılıyor; iki turda yeni track gelmezse duruluyor.
 *
 * KAPSAM ONEMLI. Playlist sayfasinin altinda Spotify'in "Recommended" bolumu
 * var ve o oneriler de ayni pathfinder cevaplarinda geliyor. Ilk surum tum
 * cevabi derin tarayinca Anitta playlist'ine JT/Timbaland/Rihanna sarkilari
 * karisti (76 "track"in yarisi oneriydi). O yuzden arama playlistV2 dugumunun
 * `content` alt agaciyla sinirli: playlist'in KENDI icerigi.
 *
 * Sabit bir alan yolu (items[].itemV2.data) izlenmiyor — o yollar Spotify'da sik
 * degisiyor ve degistiginde arac sessizce 0 track dondururdu. content altinda
 * derin taramak, hem kapsami dogru tutuyor hem sema degisikligine dayaniyor.
 */
const { launchBrowser } = require('./spotify');
require('dotenv').config({ path: __dirname + '/../../.env' });

const playlistId = (s) => {
  const m = String(s).match(/playlist[/:]([A-Za-z0-9]{22})/) || String(s).match(/^([A-Za-z0-9]{22})$/);
  return m ? m[1] : null;
};

// Gelen JSON'un icinde nerede olursa olsun track dugumlerini topla.
function tracklariTopla(node, out, derinlik = 0) {
  if (!node || typeof node !== 'object' || derinlik > 30) return;
  if (Array.isArray(node)) {
    for (const x of node) tracklariTopla(x, out, derinlik + 1);
    return;
  }
  const uri = typeof node.uri === 'string' ? node.uri : null;
  if (uri && uri.startsWith('spotify:track:')) {
    const id = uri.slice('spotify:track:'.length);
    if (/^[A-Za-z0-9]{22}$/.test(id) && !out.has(id)) {
      out.set(id, typeof node.name === 'string' ? node.name : '');
    }
  }
  for (const k of Object.keys(node)) tracklariTopla(node[k], out, derinlik + 1);
}

async function main() {
  const sadeceId = process.argv.includes('--ids');
  const hedef = process.argv.slice(2).find(a => !a.startsWith('--'));
  const pid = playlistId(hedef || '');
  if (!pid) {
    console.error('Kullanım: node read-playlist.js [--ids] <playlistUrl|playlistId>');
    process.exit(1);
  }

  const bulunan = new Map();
  let beklenen = null;   // playlist'in beyan ettigi track sayisi
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  try {
    // playlistV2 dugumunu bul, SADECE onun content'ini tara.
    const playlistContent = (node, derinlik = 0) => {
      if (!node || typeof node !== 'object' || derinlik > 12) return null;
      if (Array.isArray(node)) {
        for (const x of node) { const h = playlistContent(x, derinlik + 1); if (h) return h; }
        return null;
      }
      if (node.playlistV2 && typeof node.playlistV2 === 'object') {
        return node.playlistV2.content ?? node.playlistV2;
      }
      for (const k of Object.keys(node)) {
        const h = playlistContent(node[k], derinlik + 1);
        if (h) return h;
      }
      return null;
    };

    page.on('response', async (res) => {
      try {
        if (!res.url().includes('pathfinder')) return;
        const body = await res.json().catch(() => null);
        if (!body) return;
        const content = playlistContent(body);
        if (!content) return;
        if (content.totalCount != null) beklenen = Number(content.totalCount);
        tracklariTopla(content, bulunan);
      } catch {}
    });

    await page.goto(`https://open.spotify.com/playlist/${pid}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Sanallastirilmis liste: Spotify 25'erlik sayfalar halinde yukluyor, yani
    // kaydirmadan listenin tamami hic gelmiyor.
    //
    // DOGRU KABI SECMEK SART. Ilk surum "kaydirilabilir ilk oge"yi aliyordu ve o
    // SOL KENAR CUBUGU cikiyordu (scrollHeight 1100); playlist hic kaymiyor, arac
    // da ilk 25 track'i tam liste saniyordu. 54 parcalik Anitta listesi boyle
    // yarim okundu. Asil kap, data-overlayscrollbars-viewport tasiyanlar
    // arasinda scrollHeight'i EN BUYUK olan.
    const kaydir = () => page.evaluate(() => {
      const adaylar = Array.from(document.querySelectorAll('[data-overlayscrollbars-viewport]'))
        .concat(Array.from(document.querySelectorAll('.main-view-container__scroll-node')))
        .filter(e => e.scrollHeight > e.clientHeight + 100);
      const el = adaylar.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!el) return false;
      el.scrollTop += Math.max(el.clientHeight * 2, 800);
      el.dispatchEvent(new Event('scroll'));
      return true;
    }).catch(() => false);

    let durgun = 0;
    for (let tur = 0; tur < 120 && durgun < 4; tur++) {
      if (beklenen != null && bulunan.size >= beklenen) break;
      const once = bulunan.size;
      await kaydir();
      await new Promise(r => setTimeout(r, 1100));
      durgun = bulunan.size === once ? durgun + 1 : 0;
    }

    if (!bulunan.size) {
      console.error('[playlist] Hiç track okunamadı — playlist gizli olabilir ya da SP_DC süresi dolmuş olabilir.');
      process.exitCode = 1;
      return;
    }
    // Eksik okuma sessizce gecmemeli: yarim liste, "playlist'te bu kadar var"
    // gibi gorunup gercekten eksik sarkilarin gozden kacmasina yol acar.
    if (beklenen != null && bulunan.size < beklenen) {
      console.error(`[playlist] UYARI: playlist ${beklenen} track diyor, ${bulunan.size} okunabildi — liste EKSIK.`);
      process.exitCode = 1;
    }
    if (sadeceId) {
      console.log([...bulunan.keys()].join(' '));
    } else {
      console.error(`[playlist] ${pid}: ${bulunan.size}${beklenen != null ? '/' + beklenen : ''} track`);
      for (const [id, ad] of bulunan) console.log(`${id}  ${ad}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('[playlist] HATA:', e.message); process.exit(1); });

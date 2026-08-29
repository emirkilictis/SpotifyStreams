/**
 * audit-duplicate-heads.js — aynı kaydın iki kez sayıldığı yerleri bulur.
 *
 * 2026-08-21'de tek bir günde üç sanatçıda 4.8 MİLYAR sahte stream elle
 * yakalandı (Dua Lipa 1.25B, Cardi B 1.94B, George Michael 1.61B) ve bunların
 * bir kısmı aylardır oradaydı. Hiçbiri dedup'ın yakalayabileceği şekilde
 * durmuyordu; üçü de aşağıdaki üç desenden birine giriyordu. Bu araç o
 * desenleri her çalıştırmada tarar, ki bir dahakine kimse aylarca fark
 * etmeden durmasın.
 *
 *   node audit-duplicate-heads.js              # rapor (hiçbir şeye dokunmaz)
 *   node audit-duplicate-heads.js --apply      # SADECE A-kesin sınıfını birleştirir
 *   node audit-duplicate-heads.js --min=10000000
 *
 * DESENLER
 *
 * A — İkiz başlar (çifte sayım). İki ayrı canonical baş, aynı sanatçı, aynı
 *     kayıt. Kesin imza: aynı GÜNDE birebir aynı playcount, üç veya daha fazla
 *     kez. İki farklı kayıt haneye kadar aynı olamaz. Zayıf imza: başlıklardan
 *     biri diğerinin başlangıcı ("I Like It" ⊂ "I Like It (feat. Kontra K...)")
 *     ve son değerler %0.5 içinde — bu ikisi farklı günlerde tarandığında
 *     değerler birebir tutmadığı için gerekli (Careless Whisper böyleydi).
 *
 * B — Yanlış birleştirme (üye başından büyük). Bir üye, bağlandığı başın kendi
 *     değerinin katları kadar büyükse yanlış gruba iliştirilmiştir. Cardi'nin
 *     ana "I Like It"i (1.95B) Almanca remix grubuna (14M) bağlanmıştı: grubun
 *     MAX'i 1.95B'ye fırlayıp ana şarkıyla birlikte iki kez sayılıyordu.
 *
 * C — Donmuş yabancı değer. Bir grubun değeri bir günde katlanıp sonra hiç
 *     kıpırdamıyorsa, o okuma büyük ihtimalle BAŞKA bir şarkıya ait ve track
 *     ID'si ölmüştür. "Physical (feat. Troye Sivan)" 38M'den ana Physical'ın
 *     1.285B'sine sıçrayıp orada dondu; running MAX asla geri düşmediği için
 *     Dua Lipa'nın toplamı 1.25B şişik kaldı. Bunlar SİLİNİR, birleştirilmez —
 *     çaresi repair-stream-drops.js ya da bozuk satırın kaldırılması.
 *
 * A dışındaki sınıflarda --apply hiçbir şey yapmaz: B'nin doğru hedefi ve C'nin
 * gerçek değeri insan gözü ister. Rapor her ikisi için de hazır komutu basar.
 *
 * ⚠️ Birleştirme HER ZAMAN manual_merges tablosuna yazılır. songs.canonical_id'yi
 * doğrudan güncellemek kalıcı DEĞİL: dedup her turda kendi hesabını sıfırdan
 * kuruyor ve elle yapılanı eziyor. 2026-08-21'de iki düzeltme aynı gün içinde
 * böyle kayboldu, üstelik toplamlar sessizce eski şişik haline döndü.
 */
const { getPool, closePool } = require('./db');
require('dotenv').config({ path: __dirname + '/../../.env' });

const argNum = (name, fallback) => {
  const hit = process.argv.slice(2).find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const fmt = n => Number(n).toLocaleString('en-US');

// Son bilinen değer + baş başına o değerin tarihi.
const SON_DEGER_SQL = `
  son AS (
    SELECT DISTINCT ON (d.canonical_id) d.canonical_id AS head, d.cumulative AS val, d.recorded_date
    FROM daily_streams_canonical d
    ORDER BY d.canonical_id, d.recorded_date DESC
  )`;

// A — ikiz başlar. Aynı sanatçı kovası, iki ayrı baş, aynı kayıt.
const A_SQL = `
  WITH ${SON_DEGER_SQL},
  bas AS (
    SELECT s.id, s.title, COALESCE(s.primary_artist, 'JT-bucket') AS pa, son.val
    FROM songs s JOIN son ON son.head = s.id
    WHERE s.canonical_id IS NULL AND son.val >= $1
      AND s.id NOT IN (SELECT song_id FROM hidden_songs)
  ),
  -- Kesin imza: aynı günde birebir eşit playcount, en az 3 kez.
  ayni_gun AS (
    SELECT a.id AS a_id, b.id AS b_id, COUNT(*) AS gun
    FROM bas a
    JOIN bas b ON b.id > a.id AND b.pa = a.pa
    JOIN stream_stats sa ON sa.song_id = a.id
    JOIN stream_stats sb ON sb.song_id = b.id
       AND sb.recorded_date = sa.recorded_date
       AND sb.stream_count = sa.stream_count
    WHERE sa.recorded_date > CURRENT_DATE - 30
    GROUP BY 1, 2
    HAVING COUNT(*) >= 3
  ),
  -- Zayıf imza: başlık içerme + son değerler birbirine çok yakın.
  baslik AS (
    SELECT a.id AS a_id, b.id AS b_id, 0 AS gun
    FROM bas a
    JOIN bas b ON b.id <> a.id AND b.pa = a.pa
    WHERE length(b.title) > length(a.title)
      AND position(lower(a.title) IN lower(b.title)) = 1
      AND length(regexp_replace(a.title, '[^a-zA-Z0-9]', '', 'g')) >= 4
      AND abs(b.val - a.val) < a.val * 0.005
  ),
  cift AS (SELECT a_id, b_id, MAX(gun) AS gun FROM (
    SELECT * FROM ayni_gun UNION ALL SELECT * FROM baslik) u GROUP BY 1, 2)
  SELECT c.a_id, c.b_id, c.gun,
         sa.title AS a_title, sb.title AS b_title,
         va.val AS a_val, vb.val AS b_val,
         COALESCE(ta.name, 'JT-bucket') AS sanatci,
         LEAST(va.val, vb.val) AS sisme
  FROM cift c
  JOIN songs sa ON sa.id = c.a_id
  JOIN songs sb ON sb.id = c.b_id
  JOIN bas va ON va.id = c.a_id
  JOIN bas vb ON vb.id = c.b_id
  LEFT JOIN tracked_artists ta ON ta.artist_id = replace(sa.primary_artist, 'spotify:artist:', '')
  ORDER BY sisme DESC`;

// B — üye, bağlandığı başın kendi değerinin katları kadar büyük.
const B_SQL = `
  WITH ham AS (
    SELECT s.id, s.title, s.canonical_id, s.primary_artist,
           COALESCE(s.canonical_id, s.id) AS head,
           (SELECT MAX(x.stream_count) FROM stream_stats x WHERE x.song_id = s.id) AS val
    FROM songs s
  )
  SELECT u.id AS uye_id, u.title AS uye_title, u.val AS uye_val,
         h.id AS head_id, h.title AS head_title, h.val AS head_val,
         COALESCE(ta.name, 'JT-bucket') AS sanatci
  FROM ham u
  JOIN ham h ON h.id = u.head AND h.canonical_id IS NULL
  LEFT JOIN tracked_artists ta ON ta.artist_id = replace(h.primary_artist, 'spotify:artist:', '')
  WHERE u.canonical_id IS NOT NULL
    AND u.val >= $1 AND h.val IS NOT NULL AND u.val > h.val * 3
  ORDER BY u.val DESC`;

// C — bir günde katlanıp sonra donan gruplar.
const C_SQL = `
  WITH ${SON_DEGER_SQL},
  sicrama AS (
    SELECT d.canonical_id, d.recorded_date, d.daily_gain, d.cumulative,
           d.cumulative - d.daily_gain AS oncesi
    FROM daily_streams_canonical d
    WHERE d.recorded_date > CURRENT_DATE - 30
      -- İki gün geçmiş olsun: sıçrama EN SON snapshot'taysa "sonrasında hareket
      -- yok" kendiliğinden doğrudur ve gerçek bir büyük gün rapora düşer.
      AND d.recorded_date <= CURRENT_DATE - 2
      AND d.daily_gain > $1
      AND d.cumulative - d.daily_gain > 0
      -- Eşik %20. Eskiden "3 katına çıkmış olsun" (× 2) deniyordu ve o yalnızca
      -- değerin bambaşka, çok daha büyük bir şarkıdan geldiği hâli yakalıyordu.
      -- Çalınan okuma AYNI ŞARKININ başka bir sürümünden geldiğinde sıçrama o
      -- kadar büyük olmuyor ve desen sessizce kaçıyordu: Cardi B'nin "Never Lose
      -- Me"si 113,8M'den 190,7M'ye çıktı (%67,6), orada dondu, ve donmuş bir
      -- başın kazancı her gün yeniden sayıldığı için sanatçının günlüğü beş gün
      -- boyunca 5,5M yerine 82,5M göründü — audit hiçbir şey demeden.
      --
      -- Eşiği düşürmek gürültü yapmıyor, çünkü asıl imza oran değil DONMA:
      -- gerçekten viral olan bir şarkı ertesi gün de hareket eder. Aşağıdaki
      -- hareket = 0 şartı ayıklamayı zaten yapıyor.
      AND d.daily_gain > (d.cumulative - d.daily_gain) * 0.20
  ),
  sonrasi AS (
    SELECT s.canonical_id, COUNT(*) FILTER (WHERE d.daily_gain > 0) AS hareket
    FROM sicrama s
    JOIN daily_streams_canonical d ON d.canonical_id = s.canonical_id
      AND d.recorded_date > s.recorded_date
    GROUP BY 1
  )
  SELECT s.canonical_id, so.title, s.recorded_date, s.daily_gain, s.oncesi, s.cumulative,
         COALESCE(x.hareket, 0) AS sonraki_hareket,
         COALESCE(ta.name, 'JT-bucket') AS sanatci,
         -- Sıçrayan değer AYNI GÜN başka bir şarkıda da duruyorsa, okuma
         -- neredeyse kesin ondan gelmiştir. Kaynağı ismen basmak şart:
         -- 2026-08-21'de "Give It To Me" tam bu şekilde yakalanmış, ama kaynak
         -- gösterilmediği için kworb'daki BAŞKA bir track ile karşılaştırılıp
         -- "gerçek" diye temize çıkarılmış ve 513M hayalet bir gün daha durmuştu.
         (SELECT so2.title FROM stream_stats ss2
            JOIN songs so2 ON so2.id = ss2.song_id
           WHERE ss2.stream_count = s.cumulative
             AND ss2.recorded_date = s.recorded_date
             AND COALESCE(so2.canonical_id, so2.id) <> s.canonical_id
           LIMIT 1) AS kaynak_sarki
  FROM sicrama s
  JOIN songs so ON so.id = s.canonical_id
  LEFT JOIN sonrasi x ON x.canonical_id = s.canonical_id
  LEFT JOIN tracked_artists ta ON ta.artist_id = replace(so.primary_artist, 'spotify:artist:', '')
  WHERE COALESCE(x.hareket, 0) = 0
  ORDER BY s.daily_gain DESC`;


// D — AYNI KOVADA iki kez sayilan kayit. A kurali "ayni primary_artist" ve
// "biri digerinin uzun hali" arıyor; Bang Bang ikisine de takilmadi:
// basliklar BIREBIR aynıydi (uzunluk esit) ve iki bas farkli sanatcilarin
// primary_artist'indeydi. Ama Nicki'nin basi extra_artist_songs ile Ariana'nin
// sayfasina da bagli oldugu icin Ariana 1.748 MILYARI iki kez sayiyordu.
//
// Dogru soru "iki bas ayni sanatciya mi ait" degil: BIR SANATCININ kovasinda
// ayni deger iki kez gorunuyor mu. Ortak sarkinin iki sanatcinin ayri
// sayfalarinda birer kez sayilmasi dogrudur ve bu kural ona dokunmaz.
const D_SQL = `
  WITH son AS (
    SELECT DISTINCT ON (d.canonical_id) d.canonical_id AS head, d.cumulative AS val
    FROM daily_streams_canonical d ORDER BY d.canonical_id, d.recorded_date DESC
  ),
  -- Kova IKI UCUZ PARCANIN birlesimi. Bir sure tek bir JOIN icinde korele
  -- alt sorguyla kuruluyordu (her sanatci icin extra_artist_songs taramasi) ve
  -- dusuk esiklerde sorgu zaman asimina ugruyordu — yani "0 bulgu" cikti bir
  -- sonuc degil, sessiz bir hataydi.
  bas AS (
    SELECT s.id AS head, s.title, s.primary_artist, son.val
    FROM songs s JOIN son ON son.head = s.id
    WHERE s.canonical_id IS NULL AND son.val >= $1
      AND s.id NOT IN (SELECT song_id FROM hidden_songs)
  ),
  kova AS (
    SELECT ta.artist_id, ta.name AS sanatci, b.head, b.title, b.val
    FROM tracked_artists ta
    JOIN bas b ON b.primary_artist = 'spotify:artist:' || ta.artist_id
    WHERE ta.active
    UNION
    SELECT ta.artist_id, ta.name, b.head, b.title, b.val
    FROM tracked_artists ta
    JOIN extra_artist_songs e ON e.artist_id = ta.artist_id
    JOIN bas b ON b.head = e.song_id
    WHERE ta.active
  )
  SELECT a.sanatci, a.title AS a_title, a.head AS a_id,
         b.title AS b_title, b.head AS b_id, a.val
  FROM kova a JOIN kova b
    ON b.artist_id = a.artist_id AND b.head > a.head AND b.val = a.val
  ORDER BY a.val DESC`;

async function main() {
  const apply = process.argv.includes('--apply');
  const min = argNum('min', 5000000);
  const client = await getPool().connect();
  let bulgu = 0;

  try {
    // ---- A ----
    const a = (await client.query(A_SQL, [min])).rows;
    // Aynı baş birden çok eşleşmede görünebilir; en büyük şişmeyi bir kez say.
    const gorulen = new Set();
    const aTemiz = a.filter(r => {
      const k = [r.a_id, r.b_id].sort().join('|');
      if (gorulen.has(k)) return false;
      gorulen.add(k); return true;
    });
    console.log(`\n=== A — İKİZ BAŞLAR (çifte sayım): ${aTemiz.length}`);
    for (const r of aTemiz) {
      const kesin = r.gun >= 3;
      console.log(`  ${kesin ? '[KESİN]' : '[ŞÜPHE]'} ${r.sanatci} — ~${fmt(r.sisme)} fazla`);
      console.log(`      ${r.a_title}  = ${fmt(r.a_val)}  (${r.a_id})`);
      console.log(`      ${r.b_title}  = ${fmt(r.b_val)}  (${r.b_id})`);
      if (kesin) console.log(`      ${r.gun} ayrı günde birebir aynı playcount — farklı kayıt olamaz`);
      else console.log(`      başlık içeriyor + değerler %0.5 içinde — GÖZLE DOĞRULA`);
      bulgu++;
    }
    if (apply && aTemiz.some(r => r.gun >= 3)) {
      await client.query('BEGIN');
      let n = 0;
      for (const r of aTemiz.filter(x => x.gun >= 3)) {
        // Küçük değerli olan büyüğe bağlanır; iki baş da NULL olduğu için döngü riski yok.
        const [kucuk, buyuk] = Number(r.a_val) <= Number(r.b_val)
          ? [r.a_id, r.b_id] : [r.b_id, r.a_id];
        // manual_merges ŞART. songs.canonical_id'yi tek başına yazmak işe yaramaz:
        // dedup her turda kendi hesabını sıfırdan kurup üzerine yazıyor, ve elle
        // yapılan iki birleştirme 2026-08-21'de tam olarak böyle kayboldu — aynı
        // gün içinde, kimse fark etmeden. Kural tablosu dedup'ın EN SON uyguladığı
        // şey, yani kalıcı olan tek yol. songs.canonical_id'yi de yazıyoruz ki
        // etkisi bir sonraki scrape'i beklemeden görünsün.
        await client.query(
          `INSERT INTO manual_merges (alias_id, canonical_id, reason) VALUES ($1, $2, $3)
           ON CONFLICT (alias_id) DO UPDATE SET canonical_id = EXCLUDED.canonical_id, reason = EXCLUDED.reason`,
          [kucuk, buyuk, `audit-duplicate-heads: ${r.gun} gün birebir aynı playcount`]);
        await client.query(`UPDATE songs SET canonical_id = $1 WHERE id = $2 AND canonical_id IS NULL`, [buyuk, kucuk]);
        n++;
      }
      await client.query('COMMIT');
      console.log(`\n  → ${n} ikiz birleştirildi (manual_merges kuralı olarak, dedup'a dayanıklı).`);
    } else if (aTemiz.length) {
      console.log(`\n  Birleştirmek için: --apply  (yalnızca [KESİN] olanlara dokunur)`);
    }

    // ---- B ----
    const b = (await client.query(B_SQL, [min])).rows;
    console.log(`\n=== B — YANLIŞ BİRLEŞTİRME (üye başından büyük): ${b.length}`);
    for (const r of b) {
      console.log(`  ${r.sanatci}`);
      console.log(`      üye:  ${r.uye_title} = ${fmt(r.uye_val)}  (${r.uye_id})`);
      console.log(`      baş:  ${r.head_title} = ${fmt(r.head_val)}  (${r.head_id})`);
      console.log(`      üye başından ${(r.uye_val / r.head_val).toFixed(0)}x büyük — muhtemelen yanlış gruba bağlı.`);
      console.log(`      düzeltme: UPDATE songs SET canonical_id='<doğru baş>' WHERE id='${r.uye_id}';`);
      bulgu++;
    }

    // ---- C ----
    const c = (await client.query(C_SQL, [min])).rows;
    console.log(`\n=== C — DONMUŞ YABANCI DEĞER (silinmeli, birleştirilmemeli): ${c.length}`);
    for (const r of c) {
      console.log(`  ${r.sanatci} — ${r.title}`);
      console.log(`      ${r.recorded_date.toISOString().slice(0, 10)}: ${fmt(r.oncesi)} → ${fmt(r.cumulative)} (+${fmt(r.daily_gain)}), sonrasında hiç hareket yok`);
      if (r.kaynak_sarki) {
        console.log(`      >>> AYNI GÜN AYNI DEĞER: "${r.kaynak_sarki}" — okuma bu şarkıdan gelmiş, değer bu gruba AİT DEĞİL`);
      } else {
        console.log(`      bu okuma başka bir şarkıya ait olabilir; repair-stream-drops.js ile canlı değeri teyit et`);
      }
      bulgu++;
    }

    // ---- D ----
    const d = (await client.query(D_SQL, [min])).rows;
    console.log(`\n=== D — AYNI KOVADA ÇİFT SAYIM: ${d.length}`);
    for (const r of d) {
      console.log(`  ${r.sanatci} — ${fmt(r.val)} iki kez sayılıyor`);
      console.log(`      ${r.a_title}  (${r.a_id})`);
      console.log(`      ${r.b_title}  (${r.b_id})`);
      console.log(`      aynı sanatçının sayfasında iki ayrı baş, aynı değer — biri diğerine bağlanmalı`);
      bulgu++;
    }

    console.log(`\nToplam ${bulgu} bulgu. (eşik: ${fmt(min)})`);
    if (!bulgu) console.log('Temiz — bilinen çifte sayım deseni yok.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(err => { console.error('[audit] HATA:', err.message); process.exit(1); });

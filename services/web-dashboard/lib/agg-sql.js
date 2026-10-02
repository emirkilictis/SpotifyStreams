// ---------------------------------------------------------------------------
// The per-song figures every listing needs — latest snapshot, the day before
// it, the 7-day average and the raw change — as CTEs, computed in ONE pass.
//
// They used to come from daily_streams_canonical / canonical_streams, one scan
// each. Those are VIEWS over the whole stream_stats table: every read rebuilt
// the running max and the day-over-day gains for every artist we track, then
// threw away all but the rows for the artist actually being viewed. /api/songs
// did that four times, /api/albums three; each scan cost well over a second and
// grows with the table.
//
// So: resolve which canonical songs this endpoint is about FIRST, and derive
// everything from a single pass over just their rows. The arithmetic is copied
// from the view definitions on purpose — `cumulative` is the running max (a
// playcount can never fall), `daily_gain` divides by the day gap so an
// irregular snapshot cadence spreads across the days it covers, `real_change`
// reads the RAW counts so a genuine drop still reads negative.
//
// `songFilter` is SQL selecting this endpoint's songs; it may reference `s`
// (songs) and `a` (albums), which are joined here the same way.
// ---------------------------------------------------------------------------
// Debut baseline: the synthetic 0 reading that lets a new release's first
// snapshot count as a gain instead of a silent baseline.
//
// A head's first snapshot has nothing before it to diff against, so its gain
// was NULL and everything it earned before we first looked belonged to no day.
// Right for old catalogue (a song first read today at 900M did not earn 900M
// today); wrong for a new release, where it throws away the biggest day.
// LISA's "SaWaDiKa" read 3,913,030 on its first snapshot and the song page
// showed nothing for its debut, although kworb's chart puts a 2,787,349 debut
// on exactly that day (our playcount gains run ~1.35x the chart figure).
//
// Returns rows (idCol, recorded_date = first day - 1, stream_count = 0) for the
// heads in `src` that qualify; UNION ALL them into the per-day counts before
// the running max. Used by Time Machine. `src` is anything FROM-able with
// columns (idCol, recorded_date, stream_count). artistLatestAggCTE applies the
// same rule without inserting the row (see agg_flag there), which is faster.
//
// Qualifies only when: the album's release_date is within -1..DEBUT_WINDOW_DAYS
// of the first snapshot, the song is still growing, and the first reading is at
// most DEBUT_MAX_RATIO x the next per-day gain for each day since release. The
// ratio is the guard against a reissue whose new track id inherits a linked
// playcount of hundreds of millions; on the 2026-09-13 roster the largest real
// ratio was 2.79 and the only rejection was an AI track reading 1,009 then +2/day.
//
// Not spread back to release_date on purpose: Spotify's date can sit days
// before the real drop (SaWaDiKa: 09-02 vs a 09-04 chart debut).
//
// KEEP IN SYNC — the rule lives in three places: this function, agg_flag in
// artistLatestAggCTE, and migrations/023_debut_baseline.sql
// (daily_streams_canonical). If they disagree, the song page, the song list and
// Time Machine stop showing the same numbers for the same day.
const DEBUT_WINDOW_DAYS = 7;
const DEBUT_MAX_RATIO = 3;
// Nothing released before this can qualify: a first snapshot must be within
// DEBUT_WINDOW_DAYS of release and our earliest snapshot is 2024-06-29. Used
// only to skip work (it removes ~7.7K of ~9K heads before any sorting); lower it
// if older history is ever backfilled — a stale bound leaves those debuts blank.
const DEBUT_EARLIEST_RELEASE = '2024-06-22';

function debutBaselineSQL(src, idCol = 'canonical_id') {
  return `
        SELECT debut_f.${idCol}, (debut_f.d1 - 1) AS recorded_date, 0::bigint AS stream_count
        FROM (
          SELECT ${idCol},
                 MIN(recorded_date) FILTER (WHERE rn = 1) AS d1,
                 MAX(stream_count)  FILTER (WHERE rn = 1) AS c1,
                 MIN(recorded_date) FILTER (WHERE rn = 2) AS d2,
                 MAX(stream_count)  FILTER (WHERE rn = 2) AS c2
          FROM (
            SELECT ${idCol}, recorded_date, stream_count,
                   ROW_NUMBER() OVER (PARTITION BY ${idCol} ORDER BY recorded_date) AS rn
            FROM ${src}
          ) debut_o
          WHERE rn <= 2
          GROUP BY ${idCol}
        ) debut_f
        JOIN songs debut_s ON debut_s.id = debut_f.${idCol}
        JOIN albums debut_a ON debut_a.id = debut_s.album_id
        WHERE debut_a.release_date IS NOT NULL
          AND debut_f.d1 - debut_a.release_date BETWEEN -1 AND ${DEBUT_WINDOW_DAYS}
          AND (
            (debut_f.d2 IS NOT NULL
             AND debut_f.c2 > debut_f.c1
             AND debut_f.c1 <= ${DEBUT_MAX_RATIO} * ((debut_f.c2 - debut_f.c1)::numeric / (debut_f.d2 - debut_f.d1))
                               * (GREATEST(debut_f.d1 - debut_a.release_date, 0) + 1))
            OR (debut_f.d2 IS NULL AND debut_f.c1 > 0)
          )`;
}

function artistLatestAggCTE(songFilter) {
  return `
      agg_scope AS (
        SELECT COALESCE(s.canonical_id, s.id) AS canonical_id,
               BOOL_OR(COALESCE('ai' = ANY(ta.categories), false)) AS is_ai
        FROM songs s
        LEFT JOIN albums a ON s.album_id = a.id
        LEFT JOIN tracked_artists ta ON 'spotify:artist:' || ta.artist_id = s.primary_artist
        WHERE ${songFilter}
        GROUP BY COALESCE(s.canonical_id, s.id)
      ),
      -- Every song id (head and aliases) of the artist's heads, resolved
      -- BEFORE stream_stats is touched, then read through the
      -- (song_id, recorded_date) index one id at a time.
      --
      -- The old form joined stream_stats to songs and matched agg_scope on
      -- COALESCE(s2.canonical_id, s2.id). No index can serve that expression,
      -- so Postgres scanned all 1.06M rows of stream_stats, joined them to
      -- songs and SORTED the lot (~6.6 s) before discarding everything outside
      -- the artist. Every live-path request paid it whatever the artist's
      -- size: Milestones and Trending on every cold profile, the profile
      -- itself during a scrape. It was the largest single CPU consumer on
      -- the database. Same rows, same order, ~1-2K index probes instead.
      agg_ids AS MATERIALIZED (
        SELECT s2.id AS song_id, sc.canonical_id, sc.is_ai
        FROM agg_scope sc
        JOIN songs s2 ON COALESCE(s2.canonical_id, s2.id) = sc.canonical_id
      ),
      agg_cs AS (
        SELECT ai.canonical_id,
               ss.recorded_date,
               CASE
                 WHEN BOOL_OR(ai.is_ai) THEN
                   (ARRAY_AGG(ss.stream_count ORDER BY ss.recorded_at DESC, ai.song_id DESC))[1]
                 ELSE MAX(ss.stream_count)
               END AS stream_count
        FROM agg_ids ai
        CROSS JOIN LATERAL (
          SELECT x.recorded_date, x.stream_count, x.recorded_at
          FROM stream_stats x
          WHERE x.song_id = ai.song_id
          -- OFFSET 0 keeps the planner from flattening this back into a plain
          -- join, which it then serves with a full scan + hash join again.
          OFFSET 0
        ) ss
        GROUP BY 1, 2
      ),
      -- Release dates of the heads that could possibly be a debut (see
      -- debutBaselineSQL): only those released since the earliest date a debut
      -- is even possible, ~1.3K rows. Deliberately NOT joined to agg_scope —
      -- the EXISTS in agg_flag already matches on canonical_id, and a second
      -- reference to agg_scope makes Postgres materialise it.
      agg_debut_rel AS (
        SELECT dh.id AS canonical_id, da.release_date
        FROM songs dh
        JOIN albums da ON da.id = dh.album_id
        WHERE dh.canonical_id IS NULL
          AND da.release_date >= DATE '${DEBUT_EARLIEST_RELEASE}'
      ),
      agg_runmax AS (
        SELECT cs.canonical_id, cs.recorded_date, cs.stream_count,
               CASE
                 WHEN sc.is_ai THEN cs.stream_count
                 ELSE MAX(cs.stream_count) OVER (
                   PARTITION BY cs.canonical_id ORDER BY cs.recorded_date
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                 )
               END AS cumulative,
               sc.is_ai
        FROM agg_cs cs
        JOIN agg_scope sc ON sc.canonical_id = cs.canonical_id
      ),
      -- A jump belongs to every day it covers, not just the day we saw it.
      --
      -- daily_gain already divides by the date gap, so a song we did not read
      -- for three days spreads its growth over those three days. A song we DID
      -- read every day but whose value never moved gets no such treatment: the
      -- rows are there, the gap is one day, and the whole backlog lands on
      -- whatever day the value finally moves.
      --
      -- Holy Grail sat at 406,032,077 from 2026-08-17 to 08-23 and then read
      -- 406,822,082 on the 24th. That +790,005 is seven days of listening, not
      -- one day's, and it made the song look like it was suddenly enormous.
      --
      -- So measure a rise from the last day the value actually CHANGED, not
      -- from the previous row, and give every day in between its share. Same
      -- rule as the date-gap division, applied to the case where the dates are
      -- present but the number is standing still.
      --
      -- Bir sarkinin ILK satiri da yukselis sayilir. Kendisi bir yukselis
      -- degil (oncesi yok), ama SONRAKI yukselisin olculecegi taban o: 08-29 ve
      -- 08-30'u bir gun arayla biz okuduysak, aradaki fark gercek ve tam bir
      -- gunluk kazanctir. LAG NULL oldugu icin ilk satir is_step=0 kaliyordu ve
      -- geriye bakan pencere hicbir taban bulamiyordu, yani yeni bir sarki
      -- birinci gun (dogru olarak) VE ikinci gun (yanlis olarak) NULL uretip
      -- ancak ucuncu gun sayilmaya basliyordu.
      --
      -- Madonna'nin katalogu 08-29'da inince 949 head'in 934'u tam da bu
      -- yuzden gunluge hic katilmadi: site 8.1M yerine 555K gosterdi. Ayni sey
      -- her yeni sanatcida ve her yeni eklenen sarkida tekrarliyordu.
      --
      -- Ilk satirin kendi daily_gain'i NULL kalmaya devam ediyor (geriye bakan
      -- pencere bos), yani yeni katalog hala ilk gun ortalamayi sisirmiyor.
      -- Yerlesik sanatcilarda sonuc birebir ayni: JT 7,336,835 ve Taylor
      -- 42,248,513 degismedi; degisen yalnizca isinma penceresindeki sarkilar.
      agg_steps AS (
        SELECT canonical_id, recorded_date, cumulative, stream_count, is_ai,
               CASE WHEN cumulative > LAG(cumulative) OVER w
                      OR LAG(cumulative) OVER w IS NULL THEN 1 ELSE 0 END AS is_step,
               (stream_count - LAG(stream_count) OVER w)::bigint AS real_change,
               NULLIF(recorded_date - LAG(recorded_date) OVER w, 0)::numeric AS date_gap,
               -- Debut inputs: which row is the first, and the reading after
               -- it. Same window as the two LAGs above, so no extra sort.
               ROW_NUMBER() OVER w AS rn_asc,
               LEAD(recorded_date) OVER w AS next_date,
               LEAD(stream_count)  OVER w AS next_count
        FROM agg_runmax
        WINDOW w AS (PARTITION BY canonical_id ORDER BY recorded_date)
      ),
      -- A new release's first row: debutBaselineSQL's rule, evaluated in place.
      --
      -- The view (and Time Machine) insert a synthetic 0 reading the day before
      -- and let the ordinary diff produce the debut gain. Doing that HERE put
      -- a UNION in front of the running max, which made Postgres materialise
      -- agg_cs and sort it a second time: JT's aggregate went 1.6s -> 3.0s and
      -- Ariana's 0.58s -> 1.62s. Flagging the first row instead gives the same
      -- numbers — with a 0 before it the first row is a step of exactly its own
      -- count over one day, every later row is untouched — at no extra sort.
      -- The nested CASE guarantees the EXISTS only runs on first rows.
      agg_flag AS (
        SELECT agg_steps.*,
               CASE WHEN rn_asc = 1 THEN
                 CASE
                   WHEN next_count IS NOT NULL THEN
                     CASE WHEN next_count > stream_count AND EXISTS (
                       SELECT 1 FROM agg_debut_rel r
                       WHERE r.canonical_id = agg_steps.canonical_id
                         AND agg_steps.recorded_date - r.release_date BETWEEN -1 AND ${DEBUT_WINDOW_DAYS}
                         AND agg_steps.stream_count <= ${DEBUT_MAX_RATIO}
                             * ((agg_steps.next_count - agg_steps.stream_count)::numeric
                                / (agg_steps.next_date - agg_steps.recorded_date))
                             * (GREATEST(agg_steps.recorded_date - r.release_date, 0) + 1)
                     ) THEN true ELSE false END
                   ELSE
                     -- First snapshot of a brand-new release before a second snapshot exists:
                     -- debut gain is its initial stream count.
                     CASE WHEN stream_count > 0 AND EXISTS (
                       SELECT 1 FROM agg_debut_rel r
                       WHERE r.canonical_id = agg_steps.canonical_id
                         AND agg_steps.recorded_date - r.release_date BETWEEN -1 AND ${DEBUT_WINDOW_DAYS}
                     ) THEN true ELSE false END
                 END
               ELSE false END AS is_debut_first
        FROM agg_steps
      ),
      -- Her satir icin: kendisini KAPSAYAN yukselis (tarihi >= kendi tarihi olan
      -- ilk yukselis) ve ondan bir onceki yukselis. Ikisinin farki yukselisin
      -- boyu ve kapsadigi gun sayisi.
      --
      -- Dort pencerenin de PARTITION BY / ORDER BY'i ayni, yani Postgres hepsini
      -- TEK siralamayla besliyor. Ilk yazimda bunu uc CTE ve bir join ile
      -- yapmistim: yukselisleri filtreleyip yeniden pencerelemek ikinci bir
      -- siralama, join de ustune bir hash gerektiriyordu ve JT'nin sorgusu
      -- 304 ms'den 677 ms'ye cikmisti. Ayni sonuc, yarisindan az maliyetle.
      --
      -- cumulative azalmadigi icin gelecekteki yukselislerin MIN'i = ilk
      -- gelecek yukselis; gecmistekilerin MAX'i = son gecmis yukselis.
      -- Geriye bakan pencere CURRENT ROW'u disliyor (1 PRECEDING): bir yukselis
      -- satirinin "onceki yukselisi" kendisi olamaz.
      agg_gains AS (
        SELECT canonical_id, recorded_date, cumulative, real_change, is_debut_first, is_ai,
               CASE
                 WHEN is_debut_first THEN stream_count::numeric
                 WHEN is_ai THEN
                   CASE
                     WHEN date_gap IS NOT NULL THEN (real_change / date_gap)
                     ELSE NULL
                   END
                 ELSE (
                   MIN(CASE WHEN is_step = 1 THEN cumulative END) OVER ileri
                   - MAX(CASE WHEN is_step = 1 THEN cumulative END) OVER geri
                 ) / NULLIF(
                   MIN(CASE WHEN is_step = 1 THEN recorded_date END) OVER ileri
                   - MAX(CASE WHEN is_step = 1 THEN recorded_date END) OVER geri, 0
                 )
               END AS daily_gain,
               ROW_NUMBER() OVER (PARTITION BY canonical_id ORDER BY recorded_date DESC) AS rn
        FROM agg_flag
        WINDOW
          ileri AS (PARTITION BY canonical_id ORDER BY recorded_date
                    ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING),
          geri  AS (PARTITION BY canonical_id ORDER BY recorded_date
                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
      ),
      -- Which day the artist-level headline is about, and how much each head
      -- earned ON that day.
      --
      -- daily_gain below is a head's LATEST gain whenever it was recorded, so
      -- a head that stops updating keeps contributing its last gain to every
      -- future day. Cardi B read +82.5M for five days running off one song:
      -- "Never Lose Me" jumped 113.8M → 190.7M on 2026-08-18 and never moved
      -- again, so its 76.9M was re-added to every day after it while the real
      -- day totals sat at ~5.5M. Summing per-day instead makes a frozen head
      -- contribute nothing, which is what a head that earned nothing should do.
      --
      -- The newest date is not automatically the day: repair-stale-playcounts
      -- writes a handful of rows dated today before the day's real scrape
      -- lands, and pinning the headline to those would collapse it to a dozen
      -- songs. So take the newest date at least a quarter of the heads actually
      -- reported on.
      agg_days AS (
        SELECT recorded_date, COUNT(*) AS heads
        FROM agg_gains WHERE daily_gain IS NOT NULL
        GROUP BY recorded_date
      ),
      agg_day AS (
        SELECT recorded_date FROM agg_days
        WHERE heads >= GREATEST((SELECT MAX(heads) FROM agg_days) / 4, 1)
        ORDER BY recorded_date DESC LIMIT 1
      ),
      -- Okumasi BAYAT olan bir basin hareket alanlari yayinlanmaz.
      --
      -- daily_gain "bu basin EN SON kazanci, ne zaman kaydedilmisse" demek. Bir
      -- sarki taranmayi birakinca o son kazanc sonsuza kadar "bugunku gunluk"
      -- gibi gorunuyordu. Christina'nin "Do What U Want"i 2026-08-18'de
      -- 74,6M'den 194,5M'ye sicradi ve o gunden sonra hic okunmadi; site
      -- haftalardir onun icin +119,865,151 gunluk gosteriyordu. Ayni sey 30
      -- kayitta vardi (Stray Kids, Celine, Dua Lipa).
      --
      -- Sanatci toplaminda bu zaten cozulmustu (agg_day + day_gain), ama sarki
      -- listesi, album kartlari ve milestone ETA'lari hala ham daily_gain'i
      -- okuyordu.
      --
      -- Esik 7 gun: soguk kadanslı sarkilar COLD_STALE_DAYS (varsayilan 3) ile
      -- taraniyor, yani normal bir katalog sarkisi asla bayat sayilmiyor; 7
      -- gundur hic okunmamis bir sarkinin ise guncel bir gunlugu YOK, ve
      -- eskisini basmak uydurma. cumulative BIRAKILIYOR — o hala bilinen son
      -- gercek toplam.
      agg AS (
        SELECT canonical_id,
               MAX(recorded_date) FILTER (WHERE rn = 1) AS recorded_date,
               CASE
                 WHEN BOOL_OR(is_ai) AND (MAX(cumulative) FILTER (WHERE rn = 1)) < 1000
                 THEN NULL
                 ELSE MAX(cumulative) FILTER (WHERE rn = 1)
               END AS cumulative,
               CASE WHEN MAX(recorded_date) FILTER (WHERE rn = 1)
                         < (SELECT recorded_date FROM agg_day) - 7
                    THEN NULL ELSE MAX(daily_gain) FILTER (WHERE rn = 1) END AS daily_gain,
               CASE WHEN MAX(recorded_date) FILTER (WHERE rn = 1)
                         < (SELECT recorded_date FROM agg_day) - 7
                    THEN NULL ELSE MAX(daily_gain) FILTER (WHERE rn = 2) END AS prev_daily_gain,
               CASE WHEN MAX(recorded_date) FILTER (WHERE rn = 1)
                         < (SELECT recorded_date FROM agg_day) - 7
                    THEN NULL ELSE ROUND(AVG(daily_gain) FILTER (WHERE rn <= 7))::bigint END AS daily_avg_7d,
               CASE WHEN MAX(recorded_date) FILTER (WHERE rn = 1)
                         < (SELECT recorded_date FROM agg_day) - 7
                    THEN NULL ELSE MAX(real_change) FILTER (WHERE rn = 1) END AS real_change,
               -- What this head earned ON the headline day.
               --
               -- A head with no row that day is NOT automatically a zero. Two
               -- different things produce a missing row and only one of them
               -- means "earned nothing":
               --
               --   * The song stopped updating weeks ago (Cardi's frozen head).
               --     It earns nothing and must contribute nothing.
               --   * We simply did not read it that day — a cold-cadence skip,
               --     or the headline day is TODAY and the run is still going.
               --     The song is growing exactly as before; we just have not
               --     looked yet.
               --
               -- Treating both as zero made the artist headline read low every
               -- day some songs slipped, and read like a fraction of itself
               -- while a scrape was in flight. JT on 2026-09-07: the song list
               -- summed to 8,748,469 (kworb said 8,724,593) while the headline
               -- said 8,162,410 — short by exactly the 586,059 belonging to
               -- five songs that were not read that day.
               --
               -- So fall back to the head's most recent per-day gain, but only
               -- from the two days before the headline. daily_gain is already a
               -- PER-DAY share (agg_gains divides a rise by the days it covers),
               -- so this adds one day's worth, and when the song is finally read
               -- the same rise is still divided across the days it spanned —
               -- the estimate is replaced, never added on top. Beyond two days
               -- there is no recent rate worth carrying and a stalled head
               -- correctly falls back to nothing.
               -- CASE, not COALESCE: the fallback is for heads with NO row that
               -- day. A head that WAS read and still reports NULL (its value has
               -- not moved since its last step, so the rise it is accumulating
               -- has nowhere to land yet) keeps its NULL. Estimating for it too
               -- pushed the artist headline ABOVE the sum of its own song list —
               -- Celine read 2,968,666 against a list of 2,940,963 — and the two
               -- numbers disagreeing is the very thing being fixed here.
               CASE WHEN COUNT(*) FILTER (
                      WHERE recorded_date = (SELECT recorded_date FROM agg_day)
                    ) > 0
                    THEN MAX(daily_gain) FILTER (
                      WHERE recorded_date = (SELECT recorded_date FROM agg_day)
                    )
                    ELSE (ARRAY_AGG(daily_gain ORDER BY recorded_date DESC) FILTER (
                      WHERE daily_gain IS NOT NULL
                        AND recorded_date <  (SELECT recorded_date FROM agg_day)
                        AND recorded_date >= (SELECT recorded_date FROM agg_day) - 2
                    ))[1]
               END AS day_gain
        FROM agg_gains
        GROUP BY canonical_id
      )`;
}

// Fast profile-page aggregate built from chart_daily_streams, the coherent
// materialized copy refreshed after every scraper run. The live aggregate above
// has to reconstruct canonical playcounts from the entire raw history; doing
// that independently for /stats, /songs and /albums made a cold Taylor profile
// take tens of seconds on the small database instance. The materialized source
// has already done that work. Profiles only need the newest few observations per
// head, so indexed lateral reads keep the amount of data proportional to the
// artist's catalogue rather than its catalogue x full history.
//
// The server only selects this CTE when the materialized view is at least as
// new as the artist's completion stamp. If an artist finishes in the middle of
// a roster scrape, the server keeps using artistLatestAggCTE until the final
// materialized-view refresh lands; the artist therefore still updates before
// the rest of the roster without ever showing a partial total.
function artistCachedAggCTE(songFilter, recentRows = 10) {
  const rowLimit = Math.max(8, Math.min(Number(recentRows) || 10, 31));
  return `
      agg_scope AS MATERIALIZED (
        SELECT COALESCE(s.canonical_id, s.id) AS canonical_id
        FROM songs s
        LEFT JOIN albums a ON s.album_id = a.id
        LEFT JOIN tracked_artists ta ON 'spotify:artist:' || ta.artist_id = s.primary_artist
        WHERE ${songFilter}
        GROUP BY COALESCE(s.canonical_id, s.id)
      ),
      agg_gains AS MATERIALIZED (
        SELECT sc.canonical_id,
               cached.recorded_date,
               cached.cumulative,
               cached.daily_gain,
               0::bigint AS real_change,
               false AS is_debut_first,
               false AS is_ai,
               ROW_NUMBER() OVER (
                 PARTITION BY sc.canonical_id ORDER BY cached.recorded_date DESC
               ) AS rn
        FROM agg_scope sc
        CROSS JOIN LATERAL (
          SELECT c.recorded_date, c.cumulative, c.daily_gain
          FROM chart_daily_streams c
          WHERE c.canonical_id = sc.canonical_id
          ORDER BY c.recorded_date DESC
          LIMIT ${rowLimit}
        ) cached
      ),
      agg_days AS (
        SELECT recorded_date, COUNT(*) AS heads
        FROM agg_gains WHERE daily_gain IS NOT NULL
        GROUP BY recorded_date
      ),
      agg_day AS MATERIALIZED (
        SELECT recorded_date FROM agg_days
        WHERE heads >= GREATEST((SELECT MAX(heads) FROM agg_days) / 4, 1)
        ORDER BY recorded_date DESC LIMIT 1
      ),
      agg AS MATERIALIZED (
        SELECT canonical_id,
               MAX(recorded_date) FILTER (WHERE rn = 1) AS recorded_date,
               MAX(cumulative) FILTER (WHERE rn = 1) AS cumulative,
               CASE WHEN MAX(recorded_date) FILTER (WHERE rn = 1)
                         < (SELECT recorded_date FROM agg_day) - 7
                    THEN NULL ELSE MAX(daily_gain) FILTER (WHERE rn = 1) END AS daily_gain,
               CASE WHEN MAX(recorded_date) FILTER (WHERE rn = 1)
                         < (SELECT recorded_date FROM agg_day) - 7
                    THEN NULL ELSE MAX(daily_gain) FILTER (WHERE rn = 2) END AS prev_daily_gain,
               CASE WHEN MAX(recorded_date) FILTER (WHERE rn = 1)
                         < (SELECT recorded_date FROM agg_day) - 7
                    THEN NULL ELSE ROUND(AVG(daily_gain) FILTER (WHERE rn <= 7))::bigint END AS daily_avg_7d,
               0::bigint AS real_change,
               CASE WHEN COUNT(*) FILTER (
                      WHERE recorded_date = (SELECT recorded_date FROM agg_day)
                    ) > 0
                    THEN MAX(daily_gain) FILTER (
                      WHERE recorded_date = (SELECT recorded_date FROM agg_day)
                    )
                    ELSE (ARRAY_AGG(daily_gain ORDER BY recorded_date DESC) FILTER (
                      WHERE daily_gain IS NOT NULL
                        AND recorded_date <  (SELECT recorded_date FROM agg_day)
                        AND recorded_date >= (SELECT recorded_date FROM agg_day) - 2
                    ))[1]
               END AS day_gain
        FROM agg_gains
        GROUP BY canonical_id
      )`;
}

// Category charts need the whole selected roster at once (Female currently has
// 8K+ canonical heads). Rebuilding canonical streams and window gains for that
// catalogue on every request takes tens of seconds, so the scraper refreshes a
// materialized copy of daily_streams_canonical after each completed run. This
// CTE only scopes and ranks that already-correct data. The cache therefore keeps
// the normal running-max rule, the AI raw/latest-observation rule, the AI <1K
// hiding rule and debut baselines exactly in sync with every artist page.
function chartLatestAggCTE(filterOrMinDate = null, maybeMinDate = null) {
  const minRecordedDate = maybeMinDate || (typeof filterOrMinDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(filterOrMinDate) ? filterOrMinDate : null);
  const chartDateFilter = minRecordedDate
    ? `\n        WHERE cached.recorded_date >= DATE '${minRecordedDate}' - 7`
    : '';
  return `
      agg_raw AS MATERIALIZED (
        SELECT cached.canonical_id, cached.recorded_date, cached.cumulative, cached.daily_gain
        FROM chart_daily_streams cached
        JOIN chart_song_ids sc ON sc.canonical_id = cached.canonical_id
        ${chartDateFilter}
      ),
      agg_runmax AS MATERIALIZED (
        SELECT canonical_id, recorded_date, cumulative
        FROM agg_raw
      ),
      agg_gains AS MATERIALIZED (
        SELECT canonical_id, recorded_date, cumulative, daily_gain, false AS is_debut_first
        FROM agg_raw
      ),
      agg_days AS (
        SELECT recorded_date, COUNT(*) AS heads
        FROM agg_raw WHERE daily_gain IS NOT NULL
        GROUP BY recorded_date
      ),
      agg_day AS MATERIALIZED (
        SELECT recorded_date FROM agg_days
        WHERE heads >= GREATEST((SELECT MAX(heads) FROM agg_days) / 4, 1)
        ORDER BY recorded_date DESC LIMIT 1
      ),
      agg AS MATERIALIZED (
        SELECT canonical_id,
               MAX(daily_gain) FILTER (
                 WHERE recorded_date = (SELECT recorded_date FROM agg_day)
               ) AS day_gain
        FROM agg_raw
        GROUP BY canonical_id
      )`;
}


// agg_gains with each debut's 0 reading the day before it added back, for the
// queries that sum PER DATE (album history). agg_gains itself leaves the row
// out — see agg_flag — and nothing else needs it: a 0 cumulative with a NULL
// gain changes no latest/previous/7-day pick and no per-day gain count.
const AGG_GAINS_WITH_DEBUT_BASE = `(
        SELECT canonical_id, recorded_date, cumulative, daily_gain FROM agg_gains
        UNION ALL
        SELECT canonical_id, recorded_date - 1, 0::bigint, NULL::numeric
        FROM agg_gains WHERE is_debut_first
      )`;

// One song's rows of daily_streams_canonical ($1 = the head id), computed from
// that song's own family instead of the whole view.
//
// Every window in the view is PARTITION BY song, so no other song can change
// this one's rows; the view just cannot push `canonical_id = $1` through its
// CTEs, so asking it for one song rebuilt all of them (5-15 s, gigabytes of
// temp files). Here the family is resolved first and stream_stats is read
// through its (song_id, recorded_date) index: same rows, tens of ms, and
// always current, with no materialised copy to wait for after a scrape.
//
// KEEP IN SYNC with the view (migrations/028_ai_latest_observation.sql, debut
// rule from 026 via debutBaselineSQL): AI songs read the day's LAST
// observation raw (no running max, under 1,000 shown as NULL), every other
// song the family's daily MAX under a running max.
const SONG_HISTORY_SQL = `
      WITH fam AS MATERIALIZED (
        SELECT id, primary_artist FROM songs WHERE COALESCE(canonical_id, id) = $1::text
      ),
      own AS (
        SELECT COALESCE(bool_or(COALESCE('ai' = ANY(ta.categories), false)), false) AS is_ai
        FROM fam
        LEFT JOIN tracked_artists ta ON 'spotify:artist:' || ta.artist_id = fam.primary_artist
      ),
      src AS (
        SELECT $1::text AS canonical_id, ss.recorded_date, MAX(ss.stream_count) AS stream_count
        FROM fam JOIN stream_stats ss ON ss.song_id = fam.id
        WHERE NOT (SELECT is_ai FROM own)
        GROUP BY ss.recorded_date
        UNION ALL
        (SELECT DISTINCT ON (ss.recorded_date) $1::text, ss.recorded_date, ss.stream_count
         FROM fam JOIN stream_stats ss ON ss.song_id = fam.id
         WHERE (SELECT is_ai FROM own)
         ORDER BY ss.recorded_date, ss.recorded_at DESC, fam.id DESC)
      ),
      with_debut AS (
        SELECT canonical_id, recorded_date, stream_count FROM src
        UNION ALL
        ${debutBaselineSQL('src')}
      ),
      running AS (
        SELECT recorded_date,
               CASE WHEN (SELECT is_ai FROM own) THEN stream_count
                    ELSE MAX(stream_count) OVER (ORDER BY recorded_date
                         ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
               END AS cumulative
        FROM with_debut
      )
      SELECT recorded_date::text AS recorded_date,
             CASE WHEN (SELECT is_ai FROM own) AND cumulative < 1000 THEN NULL ELSE cumulative END AS cumulative,
             (cumulative - LAG(cumulative) OVER (ORDER BY recorded_date))
               / NULLIF(recorded_date - LAG(recorded_date) OVER (ORDER BY recorded_date), 0) AS daily_gain
      FROM running
      ORDER BY recorded_date ASC`;

module.exports = { artistLatestAggCTE, artistCachedAggCTE, chartLatestAggCTE, debutBaselineSQL, AGG_GAINS_WITH_DEBUT_BASE, DEBUT_EARLIEST_RELEASE, SONG_HISTORY_SQL };

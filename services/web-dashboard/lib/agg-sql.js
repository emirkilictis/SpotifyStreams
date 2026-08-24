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
function artistLatestAggCTE(songFilter) {
  return `
      agg_scope AS (
        SELECT DISTINCT COALESCE(s.canonical_id, s.id) AS canonical_id
        FROM songs s
        LEFT JOIN albums a ON s.album_id = a.id
        WHERE ${songFilter}
      ),
      agg_cs AS (
        SELECT COALESCE(s2.canonical_id, s2.id) AS canonical_id,
               ss.recorded_date,
               MAX(ss.stream_count) AS stream_count
        FROM stream_stats ss
        JOIN songs s2 ON s2.id = ss.song_id
        WHERE COALESCE(s2.canonical_id, s2.id) IN (SELECT canonical_id FROM agg_scope)
        GROUP BY 1, 2
      ),
      agg_runmax AS (
        SELECT canonical_id, recorded_date, stream_count,
               MAX(stream_count) OVER (
                 PARTITION BY canonical_id ORDER BY recorded_date
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
               ) AS cumulative
        FROM agg_cs
      ),
      -- Ground a correction took away, so re-crossing it is not a gain.
      --
      -- When a playcount is corrected downwards the day loses its gain (the
      -- running max cannot fall, so it reads 0) and the removal is reported on
      -- its own line, deliberately outside daily_gain. The climb back up has to
      -- be treated the same way, or the same streams are counted as earned a
      -- second time on whatever day the value recovers.
      --
      -- It showed up as Give It To Me reading +1,189,826 and Holy Grail
      -- +790,005 on 2026-08-24 — neither earned anything like that; both were
      -- climbing back to where they had been before a correction the day
      -- before. old_count is the peak the head held before the correction.
      agg_corr AS (
        SELECT head_id, MAX(old_count) AS old_count
        FROM stream_drop_corrections
        WHERE applied_on > CURRENT_DATE - 14
        GROUP BY head_id
      ),
      agg_gains AS (
        SELECT r.canonical_id, r.recorded_date, r.cumulative,
               -- The part of the day's rise that is still below the pre-correction
               -- peak is recovered ground, not earnings. Once the head climbs past
               -- that peak the term goes to zero on its own, so genuine growth
               -- above it still counts.
               (
                 (r.cumulative - LAG(r.cumulative) OVER w)
                 - GREATEST(
                     0,
                     LEAST(r.cumulative, COALESCE(c.old_count, 0))
                       - LAG(r.cumulative) OVER w
                   )
               ) / NULLIF(r.recorded_date - LAG(r.recorded_date) OVER w, 0) AS daily_gain,
               (r.stream_count - LAG(r.stream_count) OVER w)::bigint AS real_change,
               ROW_NUMBER() OVER (PARTITION BY r.canonical_id ORDER BY r.recorded_date DESC) AS rn
        FROM agg_runmax r
        LEFT JOIN agg_corr c ON c.head_id = r.canonical_id
        WINDOW w AS (PARTITION BY r.canonical_id ORDER BY r.recorded_date)
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
      agg AS (
        SELECT canonical_id,
               MAX(recorded_date) FILTER (WHERE rn = 1) AS recorded_date,
               MAX(cumulative)    FILTER (WHERE rn = 1) AS cumulative,
               MAX(daily_gain)    FILTER (WHERE rn = 1) AS daily_gain,
               MAX(daily_gain)    FILTER (WHERE rn = 2) AS prev_daily_gain,
               ROUND(AVG(daily_gain) FILTER (WHERE rn <= 7))::bigint AS daily_avg_7d,
               MAX(real_change)   FILTER (WHERE rn = 1) AS real_change,
               -- NULL when this head has no row on the headline day.
               MAX(daily_gain) FILTER (
                 WHERE recorded_date = (SELECT recorded_date FROM agg_day)
               ) AS day_gain
        FROM agg_gains
        GROUP BY canonical_id
      )`;
}


module.exports = { artistLatestAggCTE };

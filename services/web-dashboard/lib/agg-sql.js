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
      agg_steps AS (
        SELECT canonical_id, recorded_date, cumulative, stream_count,
               CASE WHEN cumulative > LAG(cumulative) OVER w THEN 1 ELSE 0 END AS is_step,
               (stream_count - LAG(stream_count) OVER w)::bigint AS real_change
        FROM agg_runmax
        WINDOW w AS (PARTITION BY canonical_id ORDER BY recorded_date)
      ),
      -- The first day at or after this one on which the value moves. Every day
      -- sharing that date is covered by the same rise.
      agg_cover AS (
        SELECT canonical_id, recorded_date, cumulative, real_change, is_step,
               MIN(CASE WHEN is_step = 1 THEN recorded_date END) OVER (
                 PARTITION BY canonical_id ORDER BY recorded_date
                 ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
               ) AS cover_step_date
        FROM agg_steps
      ),
      -- Each rise, with the span it covers: from the previous rise to this one.
      agg_step_rows AS (
        SELECT canonical_id,
               recorded_date AS step_date,
               (cumulative - LAG(cumulative) OVER w) AS step_size,
               (recorded_date - LAG(recorded_date) OVER w) AS step_days
        FROM agg_cover
        WHERE is_step = 1
        WINDOW w AS (PARTITION BY canonical_id ORDER BY recorded_date)
      ),
      agg_gains AS (
        SELECT c.canonical_id, c.recorded_date, c.cumulative,
               -- NULL past the last rise we have seen: the growth covering
               -- those days has not been observed yet, so claiming a number
               -- for them would be inventing one.
               (sr.step_size / NULLIF(sr.step_days, 0)) AS daily_gain,
               c.real_change,
               ROW_NUMBER() OVER (PARTITION BY c.canonical_id ORDER BY c.recorded_date DESC) AS rn
        FROM agg_cover c
        LEFT JOIN agg_step_rows sr
          ON sr.canonical_id = c.canonical_id
         AND sr.step_date = c.cover_step_date
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

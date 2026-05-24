-- Migration 004: Günlük stream delta view
-- Her gün için: o gün kazanılan stream = bugünkü kümülatif - dünkünkü kümülatif

CREATE OR REPLACE VIEW daily_streams AS
SELECT
  ss.song_id,
  s.title,
  s.is_featured,
  COALESCE(s.canonical_id, s.id) AS canonical_id,
  ss.recorded_date,
  ss.stream_count                                                                AS cumulative,
  ss.stream_count - LAG(ss.stream_count) OVER (
    PARTITION BY ss.song_id ORDER BY ss.recorded_date
  )                                                                              AS daily_gain
FROM stream_stats ss
JOIN songs s ON s.id = ss.song_id;

-- Canonical-bazlı toplam günlük
CREATE OR REPLACE VIEW daily_streams_canonical AS
SELECT
  canonical_id,
  recorded_date,
  SUM(cumulative)::bigint  AS cumulative,
  SUM(daily_gain)::bigint  AS daily_gain
FROM daily_streams
GROUP BY canonical_id, recorded_date;

-- Frozen chart frames (server.js chartFramesFor): each settled daily/weekly
-- Top 20 is computed once and kept, so the chart's LW / peak / weeks-on-chart
-- no longer rebuild the whole history since CHART_HISTORY_START on every
-- cache miss. Only the web server reads and writes these; dropping both
-- tables just makes it recompute the frames once.

CREATE TABLE IF NOT EXISTS chart_frames (
  category   TEXT NOT NULL,          -- ai | male | female | kpop | y2k
  scope      TEXT NOT NULL,          -- public|unlocked + ':v' + CHART_FRAMES_VERSION
  period     TEXT NOT NULL,          -- daily | weekly
  chart_date DATE NOT NULL,
  kind       TEXT NOT NULL,          -- songs | artists | albums
  id         TEXT NOT NULL,
  rank       INT  NOT NULL,
  PRIMARY KEY (category, scope, period, chart_date, kind, id)
);

-- One row per computed frame, so a frame with no entries is not recomputed.
CREATE TABLE IF NOT EXISTS chart_frame_days (
  category    TEXT NOT NULL,
  scope       TEXT NOT NULL,
  period      TEXT NOT NULL,
  chart_date  DATE NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (category, scope, period, chart_date)
);

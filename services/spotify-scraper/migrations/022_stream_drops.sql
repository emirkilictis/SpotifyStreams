-- Migration 022: playcount DÜŞÜŞLERİNİ görünür kıl.
--
-- upsertStreamStat(sBatch) yeni sayım kayıtlıdan büyük değilse satır yazmaz
-- ("stale-skip"), view'lar da running MAX uygular. İkisi birlikte geçici bir
-- dip veya bozuk snapshot'ın toplamı düşürüp ertesi gün sahte spike yapmasını
-- engelliyor — ama Spotify GERÇEKTEN stream sildiğinde (Britney "Gimme More",
-- 2026-08-18, -3.13M) o düşüş de hiçbir yere yazılmıyordu: şarkı donuyor,
-- toplam şişik kalıyor ve elde tek bir kanıt olmuyor.
--
-- Bu tablo sadece DÜŞÜK gelen okumaları saklar (eşit olanları değil — o sadece
-- durgun bir gün). Kayıt tutmak düzeltmek değil: düşüşün gerçek olduğuna ancak
-- birden fazla taramada tekrarlarsa karar veriliyor (bkz. reconcileStreamDrops).
CREATE TABLE IF NOT EXISTS stream_observations (
  song_id       TEXT   NOT NULL,
  observed_date DATE   NOT NULL,
  stream_count  BIGINT NOT NULL,   -- Spotify o gün ne dedi
  stored_count  BIGINT NOT NULL,   -- bizde o an ne yazıyordu
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (song_id, observed_date)
);

CREATE INDEX IF NOT EXISTS idx_stream_observations_date
  ON stream_observations (observed_date DESC);

-- Uygulanan düzeltmelerin kaydı: hangi kayıt, hangi değere çekildi, kaç satır
-- tıraşlandı. Bir toplam "neden düştü" sorusunun cevabı burada duruyor.
CREATE TABLE IF NOT EXISTS stream_drop_corrections (
  id            BIGSERIAL PRIMARY KEY,
  head_id       TEXT   NOT NULL,
  applied_on    DATE   NOT NULL,
  old_count     BIGINT NOT NULL,
  new_count     BIGINT NOT NULL,
  songs_touched INT    NOT NULL,
  rows_clamped  INT    NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

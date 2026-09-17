-- 025_artist_scan_stamp.sql
--
-- "Bu sanatçı bugün tarandı" damgası.
--
-- Bir sanatçının günlük taraması bugüne kadar YAZILAN SATIR SAYISIYLA ölçülüyordu
-- (artistsWithTodaysData: bugünkü satır sayısı >= önceki günün satır sayısı).
-- Yazıcı stale-skip uyguladığı için (yeni sayım <= kayıtlıysa satır yazılmaz) bu
-- ölçü yalnızca ŞARKILARI HER GÜN BÜYÜYEN sanatçılarda doğru. AI kadrosunda
-- katalogun büyük kısmı ya donmuş ya da Spotify sahte dinlemeleri sildiği için
-- DÜŞÜYOR: satır yazılmıyor, sanatçı "bugün çekilmedi" sayılıyor ve saatlik her
-- koşuda baştan taranıyor. Vaelis 7 günün 3'ünde tam bu döngüye girdi
-- (09-11: 25 satır < 32, 09-14: 52 < 58, 09-15: 21 < 52).
--
-- Damga tarama başarısının kendi kaydı: sanatçının bütün albümleri hatasız
-- işlendiğinde yazılır, tek bir satır bile değişmemiş olsa da.
ALTER TABLE tracked_artists
  ADD COLUMN IF NOT EXISTS last_scanned_date date,
  ADD COLUMN IF NOT EXISTS last_scanned_at   timestamptz;

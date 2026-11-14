'use strict';
// chartCacheDriftSQL decides whether a profile may read chart_daily_streams.
// Run against a real Postgres with CHART_CACHE_DB_TEST=1. Every table it reads
// is a TEMP table that shadows the real one inside a transaction that is rolled
// back, so it is safe against any database.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chartCacheDrift } = require('../lib/chart-cache');

const HEADS = `SELECT id FROM songs WHERE canonical_id IS NULL`;

async function withFixture(fn) {
  const path = require('node:path');
  require('dotenv').config({ path: path.join(__dirname, '../../../.env') });
  const { Pool } = require('pg');
  const { databaseConfig } = require('../lib/database');
  const pool = new Pool({ ...databaseConfig(), max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      CREATE TEMP TABLE songs (id text PRIMARY KEY, canonical_id text, primary_artist text) ON COMMIT DROP;
      CREATE TEMP TABLE tracked_artists (artist_id text PRIMARY KEY, categories text[]) ON COMMIT DROP;
      CREATE TEMP TABLE stream_stats (song_id text, recorded_date date, stream_count bigint,
        recorded_at timestamptz DEFAULT now()) ON COMMIT DROP;
      CREATE TEMP TABLE chart_daily_streams (canonical_id text, recorded_date date, cumulative bigint) ON COMMIT DROP;
      INSERT INTO tracked_artists VALUES ('real', '{pop}'), ('robot', '{ai}');
      -- head + alias reading the same count; a second, lagging copy; an AI head.
      INSERT INTO songs VALUES
        ('head', NULL, 'spotify:artist:real'), ('alias', 'head', 'spotify:artist:real'),
        ('solo', NULL, 'spotify:artist:real'), ('bot', NULL, 'spotify:artist:robot');
      INSERT INTO stream_stats (song_id, recorded_date, stream_count, recorded_at) VALUES
        ('head',  '2026-11-13', 100, '2026-11-13 10:00+00'), ('head',  '2026-11-14', 110, '2026-11-14 10:00+00'),
        ('alias', '2026-11-13',  90, '2026-11-13 10:00+00'),
        ('solo',  '2026-11-14',  50, '2026-11-14 10:00+00'),
        ('bot',   '2026-11-14', 5000, '2026-11-14 10:00+00');
      INSERT INTO chart_daily_streams VALUES
        ('head', '2026-11-13', 100), ('head', '2026-11-14', 110),
        ('solo', '2026-11-14', 50), ('bot', '2026-11-14', 5000);
    `);
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    await pool.end();
  }
}

const dbTest = (name, fn) => test(name, { skip: process.env.CHART_CACHE_DB_TEST !== '1' }, () => withFixture(fn));

dbTest('a copy that matches the live catalogue has no drift', async (client) => {
  assert.deepEqual(await chartCacheDrift(client, HEADS), { headsBehind: 0, aliasKeys: 0 });
});

dbTest('a head move leaves the new head without rows and the old one as an alias key', async (client) => {
  // What dedup did to "4 Minutes" on 2026-11-14: the other copy became the head.
  await client.query(`UPDATE songs SET canonical_id = 'alias' WHERE id = 'head'`);
  await client.query(`UPDATE songs SET canonical_id = NULL WHERE id = 'alias'`);
  assert.deepEqual(await chartCacheDrift(client, HEADS), { headsBehind: 1, aliasKeys: 1 });
});

dbTest('a reading the refresh never saw counts as behind', async (client) => {
  await client.query(`INSERT INTO stream_stats (song_id, recorded_date, stream_count) VALUES ('alias', '2026-11-15', 120)`);
  assert.deepEqual(await chartCacheDrift(client, HEADS), { headsBehind: 1, aliasKeys: 0 });
});

dbTest('a later scan of the same day with a higher count counts as behind', async (client) => {
  await client.query(`UPDATE stream_stats SET stream_count = 60 WHERE song_id = 'solo'`);
  assert.deepEqual(await chartCacheDrift(client, HEADS), { headsBehind: 1, aliasKeys: 0 });
});

dbTest('a re-dated scan leaves the copy holding a day that no longer exists', async (client) => {
  await client.query(`UPDATE stream_stats SET recorded_date = '2026-11-13' WHERE song_id = 'solo'`);
  assert.deepEqual(await chartCacheDrift(client, HEADS), { headsBehind: 1, aliasKeys: 0 });
});

dbTest('streams Spotify removed do not make a normal head look stale', async (client) => {
  // The copy keeps the running maximum, so it legitimately sits above the
  // newest reading after a removal.
  await client.query(`UPDATE stream_stats SET stream_count = 105 WHERE song_id = 'head' AND recorded_date = '2026-11-14'`);
  assert.deepEqual(await chartCacheDrift(client, HEADS), { headsBehind: 0, aliasKeys: 0 });
});

dbTest('an AI head must match its last reading exactly, and hides totals under 1,000', async (client) => {
  await client.query(`UPDATE stream_stats SET stream_count = 4000 WHERE song_id = 'bot'`);
  assert.deepEqual(await chartCacheDrift(client, HEADS), { headsBehind: 1, aliasKeys: 0 }, 'a drop is real for AI');
  await client.query(`UPDATE stream_stats SET stream_count = 900 WHERE song_id = 'bot'`);
  await client.query(`UPDATE chart_daily_streams SET cumulative = NULL WHERE canonical_id = 'bot'`);
  assert.deepEqual(await chartCacheDrift(client, HEADS), { headsBehind: 0, aliasKeys: 0 }, 'under 1,000 is stored as NULL');
});

dbTest('only the heads in scope are checked', async (client) => {
  await client.query(`UPDATE stream_stats SET stream_count = 60 WHERE song_id = 'solo'`);
  assert.deepEqual(await chartCacheDrift(client, `SELECT 'head'::text AS id`), { headsBehind: 0, aliasKeys: 0 });
});

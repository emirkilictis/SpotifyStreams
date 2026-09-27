'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { upsertStreamStatsBatch } = require('../../spotify-scraper/db');

test('AI batch keeps the last observation and bypasses legacy drop reconciliation', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes("AS today")) return { rows: [{ today: '2026-09-26' }] };
      if (sql.includes('SELECT DISTINCT ON (song_id)')) {
        return { rows: [{ song_id: 'ai-song', stream_count: '1800', recorded_date: '2026-09-25' }] };
      }
      if (sql.includes('SELECT s.id AS song_id')) return { rows: [{ song_id: 'ai-song' }] };
      if (sql.includes('INSERT INTO stream_stats')) return { rowCount: 1, rows: [] };
      if (sql.includes('stream_observations')) throw new Error('AI drop must not reach legacy observations');
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };

  const written = await upsertStreamStatsBatch(client, [
    { songId: 'ai-song', streamCount: 2000 },
    { songId: 'ai-song', streamCount: 1500 },
  ]);
  assert.equal(written, 1);
  const insert = calls.find(c => c.sql.includes('INSERT INTO stream_stats'));
  assert.ok(insert, 'stream row was inserted');
  assert.equal(insert.params[1], 1500, 'last AI reading wins even when it is lower');
  assert.ok(!calls.some(c => c.sql.includes('stream_observations')), 'no legacy drop observation was written');
});

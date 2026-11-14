/**
 * refresh-chart-cache.js — keep chart_daily_streams in step with the catalogue.
 *
 *   node refresh-chart-cache.js           refresh only if the copy is wrong
 *   node refresh-chart-cache.js --force   refresh regardless
 *   node refresh-chart-cache.js --check   report only, never refresh
 *
 * The scraper refreshes the copy at the end of a scrape, but that is not the
 * only moment the copy can go wrong: the standalone dedup and the duplicate
 * audit run after it and move heads, an admin can merge two songs at noon, a
 * repair script can rewrite a reading, and the refresh itself can fail. Each of
 * those used to leave the copy wrong until the next day's scrape.
 *
 * So the workflow runs this at the end of EVERY hourly run. When the copy
 * agrees with the live catalogue it costs one indexed check; when it does not,
 * it is rebuilt within the hour, whoever broke it.
 *
 * Never exits non-zero: the scrape's data is already written and the dashboard
 * falls back to the live aggregates for any artist whose copy is stale, so a
 * bad refresh costs speed, not correctness.
 */
require('dotenv').config({ path: __dirname + '/../../.env' });
const { getPool, closePool } = require('./db');
const { chartCacheDrift, refreshChartCache, ensureChartCacheFresh } = require('./chart-cache');

async function main() {
  const force = process.argv.includes('--force');
  const checkOnly = process.argv.includes('--check');
  const client = await getPool().connect();
  try {
    if (checkOnly) {
      const drift = await chartCacheDrift(client);
      console.log(`[chart-cache] ${drift.headsBehind} head(s) behind, ${drift.aliasKeys} alias key(s).`);
    } else if (force) {
      const ms = await refreshChartCache(client);
      const drift = await chartCacheDrift(client);
      console.log(`[chart-cache] forced refresh in ${(ms / 1000).toFixed(1)}s; now ${drift.headsBehind} head(s) behind, ${drift.aliasKeys} alias key(s).`);
    } else {
      await ensureChartCacheFresh(client);
    }
  } catch (err) {
    console.error('[chart-cache] FAILED — the copy may be stale until the next run:', err.message);
  } finally {
    client.release();
    await closePool();
  }
}

main().catch(err => console.error('[chart-cache] ERROR (ignored):', err.message));

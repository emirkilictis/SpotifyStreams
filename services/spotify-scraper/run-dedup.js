require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { getPool, closePool } = require('./db');
const { dedupCanonical } = require('./dedup');

async function main() {
  console.log('[run-dedup] Connecting to database...');
  const pool = getPool();
  const client = await pool.connect();
  try {
    const res = await dedupCanonical(client);
    console.log('[run-dedup] Dedup completed successfully:', res);
  } catch (err) {
    console.error('[run-dedup] Error during dedup:', err);
  } finally {
    client.release();
    await closePool();
    console.log('[run-dedup] Connection pool closed.');
  }
}

main();

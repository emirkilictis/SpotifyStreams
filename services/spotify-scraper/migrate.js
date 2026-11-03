const { databaseConfig } = require('../web-dashboard/lib/database');
require('dotenv').config({ path: '../../.env' });
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ ...databaseConfig() });

async function migrate() {
  const dir   = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    // Serialize deploys so two runners cannot apply the same migration together.
    await client.query('SELECT pg_advisory_lock(8472319)');

    // Keep migration state in the database so a second deploy does not replay
    // ALTER TABLE statements against an already-provisioned Supabase database.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    for (const f of files) {
      const applied = await client.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1',
        [f]
      );
      if (applied.rowCount > 0) {
        console.log(`[migrate] Skipping ${f} (already applied).`);
        continue;
      }

      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      console.log(`[migrate] Applying ${f}...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1)',
          [f]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    console.log('[migrate] All migrations applied.');
  } finally {
    await client.query('SELECT pg_advisory_unlock(8472319)').catch(() => {});
    client.release();
    await pool.end();
  }
}

migrate().catch(err => { console.error('[migrate] FAILED:', err.message); process.exit(1); });

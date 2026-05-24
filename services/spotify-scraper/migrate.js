require('dotenv').config({ path: '../../.env' });
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const dir   = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    for (const f of files) {
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      console.log(`[migrate] Applying ${f}...`);
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    }
    console.log('[migrate] All migrations applied.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => { console.error('[migrate] FAILED:', err.message); process.exit(1); });

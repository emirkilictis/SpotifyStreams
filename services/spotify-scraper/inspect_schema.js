const { Pool } = require('pg');
require('dotenv').config({ path: '../../.env' }); // load .env from root

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    const ddl = await pool.query(`
      SELECT 
        conname,
        pg_get_constraintdef(c.oid)
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = 'public';
    `);
    console.table(ddl.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();

const { Pool } = require('pg');
require('dotenv').config({ path: '../../.env' }); // load .env from root

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    console.log("--- Checking albums whose title does NOT match own JT albums ---");
    const nonJtAlbums = await pool.query(`
      SELECT id, title
      FROM albums
      WHERE title NOT ILIKE 'Justified%'
        AND title NOT ILIKE 'FutureSex/LoveSounds%'
        AND title NOT ILIKE 'The 20/20 Experience%'
        AND title NOT ILIKE 'Man of the Woods%'
        AND title NOT ILIKE 'Everything I Thought It Was%'
      ORDER BY title ASC;
    `);
    console.table(nonJtAlbums.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();

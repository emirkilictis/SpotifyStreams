const { databaseConfig } = require('../web-dashboard/lib/database');
const { Pool } = require('pg');
require('dotenv').config({ path: '../../.env' }); // load .env from root

const pool = new Pool({
  ...databaseConfig(),
});

async function main() {
  try {
    console.log("--- Checking albums list counts and names ---");
    const albums = await pool.query(`
      SELECT id, title
      FROM albums
      WHERE title ILIKE 'Justified%'
         OR title ILIKE 'FutureSex/LoveSounds%'
         OR title ILIKE 'The 20/20 Experience%'
         OR title ILIKE 'Man of the Woods%'
         OR title ILIKE 'Everything I Thought It Was%';
    `);
    console.table(albums.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();

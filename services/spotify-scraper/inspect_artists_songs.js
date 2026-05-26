const { Pool } = require('pg');
require('dotenv').config({ path: '../../.env' }); // load .env from root

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    console.log("Checking songs with non-null primary_artist that aren't JT...");
    const songs = await pool.query(`
      SELECT s.id, s.title, s.primary_artist, a.title as album_title
      FROM songs s
      LEFT JOIN albums a ON s.album_id = a.id
      WHERE s.primary_artist IS NOT NULL AND s.primary_artist <> 'spotify:artist:31TPClRtHm23RisEBtV3X7'
      LIMIT 30;
    `);
    console.table(songs.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();

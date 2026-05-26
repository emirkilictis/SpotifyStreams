const { Pool } = require('pg');
require('dotenv').config({ path: '../../.env' }); // load .env from root

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    console.log("Let's query some non-JT albums in the albums table:");
    const nonJtAlbums = await pool.query(`
      SELECT id, title
      FROM albums
      WHERE title IN ('Coronation Street Party', 'Hits Internacionais Virais', 'Cardio Pop', 'Throwback Bangers 100 Hits from the 00''s', 'Ladies Night Out')
      LIMIT 10;
    `);
    console.table(nonJtAlbums.rows);

    console.log("Let's query some tracks in these albums:");
    const albumIds = nonJtAlbums.rows.map(r => r.id);
    if (albumIds.length > 0) {
      const tracks = await pool.query(`
        SELECT id, title, album_id, is_featured, primary_artist
        FROM songs
        WHERE album_id = ANY($1)
        LIMIT 20;
      `, [albumIds]);
      console.table(tracks.rows);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();

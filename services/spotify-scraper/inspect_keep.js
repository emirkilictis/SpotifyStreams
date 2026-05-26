const { Pool } = require('pg');
require('dotenv').config({ path: '../../.env' }); // load .env from root

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    console.log("Querying number of songs by album group that are JT's own or feature:");
    const query = `
      SELECT a.title as album_title, COUNT(s.id)::int as count
      FROM songs s
      LEFT JOIN albums a ON s.album_id = a.id
      WHERE 
        a.title ILIKE 'Justified%'
        OR a.title ILIKE 'FutureSex/LoveSounds%'
        OR a.title ILIKE 'The 20/20 Experience%'
        OR a.title ILIKE 'Man of the Woods%'
        OR a.title ILIKE 'Everything I Thought It Was%'
        OR a.title ILIKE '%Trolls%'
        OR a.title ILIKE '%Book of Love%'
        OR s.primary_artist = 'spotify:artist:31TPClRtHm23RisEBtV3X7'
      GROUP BY a.title
      ORDER BY count DESC;
    `;
    const result = await pool.query(query);
    console.table(result.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();

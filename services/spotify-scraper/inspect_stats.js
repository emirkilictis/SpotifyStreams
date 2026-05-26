const { Pool } = require('pg');
require('dotenv').config({ path: '../../.env' }); // load .env from root

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    console.log("--- Let's see what /api/stats query actually returns ---");
    const statsQuery = `
      SELECT 
        COALESCE(SUM(dsc.cumulative), 0)::bigint AS total_streams,
        COALESCE(SUM(dsc.cumulative) FILTER (WHERE NOT s.is_featured), 0)::bigint AS lead_streams,
        COALESCE(SUM(dsc.cumulative) FILTER (WHERE s.is_featured), 0)::bigint AS feat_streams,
        COALESCE(SUM(dsc.daily_gain), 0)::bigint AS daily_gain,
        COUNT(*)::int AS total_songs,
        MAX(dsc.recorded_date) AS last_update
      FROM (
        SELECT DISTINCT ON (canonical_id)
          canonical_id,
          cumulative,
          daily_gain,
          recorded_date
        FROM daily_streams_canonical
        ORDER BY canonical_id, recorded_date DESC
      ) dsc
      JOIN songs s ON s.id = dsc.canonical_id;
    `;
    const stats = await pool.query(statsQuery);
    console.table(stats.rows);

    console.log("--- Let's look at the top 10 songs in daily_streams_canonical causing high streams ---");
    const topDsc = await pool.query(`
      SELECT dsc.canonical_id, s.title, dsc.cumulative, dsc.recorded_date
      FROM (
        SELECT DISTINCT ON (canonical_id)
          canonical_id,
          cumulative,
          recorded_date
        FROM daily_streams_canonical
        ORDER BY canonical_id, recorded_date DESC
      ) dsc
      JOIN songs s ON s.id = dsc.canonical_id
      ORDER BY dsc.cumulative DESC
      LIMIT 20;
    `);
    console.table(topDsc.rows);

    console.log("--- Let's count how many rows are in daily_streams_canonical and canonical_streams ---");
    const counts = await pool.query(`
      SELECT 
        (SELECT COUNT(*) FROM daily_streams_canonical) as dsc_count,
        (SELECT COUNT(*) FROM canonical_streams) as cs_count,
        (SELECT COUNT(*) FROM stream_stats) as ss_count,
        (SELECT COUNT(*) FROM songs) as songs_count;
    `);
    console.table(counts.rows);

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();

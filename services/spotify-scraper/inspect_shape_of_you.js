const { Pool } = require('pg');
require('dotenv').config({ path: '../../.env' }); // load .env from root

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function main() {
  try {
    console.log("Let's query album details for Shape of You:");
    const album = await pool.query("SELECT * FROM albums WHERE id = '3hJgNUO92emkgDSpiJeVHh';");
    console.table(album.rows);
  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}

main();

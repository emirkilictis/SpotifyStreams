const { launchBrowser, fetchAlbumTracks } = require('./spotify');
require('dotenv').config({ path: '../../.env' });

async function main() {
  console.log("Launching browser...");
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  
  try {
    const albumId = '3lo9YzrubM3XXIKjBL1cgf';
    console.log(`Fetching tracks for album ${albumId}...`);
    const tracks = await fetchAlbumTracks(page, albumId);
    console.table(tracks);
  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await browser.close();
  }
}

main();

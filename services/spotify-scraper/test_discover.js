const { launchBrowser } = require('./spotify');
const { discoverAllAlbumsPuppeteer } = require('./discover');
require('dotenv').config({ path: '../../.env' });

async function main() {
  const spDc = process.env.SP_DC;
  console.log('SP_DC length:', spDc ? spDc.length : 0);
  const { browser, page } = await launchBrowser(spDc);
  try {
    const { albums, own_count, feat_count } = await discoverAllAlbumsPuppeteer(page, '31TPClRtHm23RisEBtV3X7');
    console.log(`Discovered ${albums.length} albums (Own: ${own_count}, Feat: ${feat_count})`);
    const trolls1 = albums.find(a => a.id === '65ayND23IInUPHJKsaAqe7');
    console.log('Is Trolls 1 album discovered?', !!trolls1, trolls1);
  } catch (err) {
    console.error(err);
  } finally {
    await browser.close();
  }
}

main();

const { launchBrowser } = require('./spotify');
const { fetchArtistAppearsOn } = require('./spotify');
require('dotenv').config({ path: '../../.env' });

async function main() {
  const spDc = process.env.SP_DC;
  const { browser, page } = await launchBrowser(spDc);
  try {
    const feat = await fetchArtistAppearsOn(page, '31TPClRtHm23RisEBtV3X7');
    console.log('Total appearsOn albums fetched:', feat.length);
    
    // Find all titles containing 'trolls'
    const trollsAlbums = feat.filter(a => a.title && a.title.toLowerCase().includes('trolls'));
    console.log('Trolls albums in appearsOn list:');
    trollsAlbums.forEach(a => console.log(`- [${a.id}] "${a.title}"`));
    
    // Find if 65ayND23IInUPHJKsaAqe7 is in the raw appearsOn list
    const found = feat.find(a => a.id === '65ayND23IInUPHJKsaAqe7');
    console.log('Is 65ayND23IInUPHJKsaAqe7 in raw appearsOn?', !!found, found);
  } catch (err) {
    console.error(err);
  } finally {
    await browser.close();
  }
}

main();

const { launchBrowser, fetchArtistAlbums, fetchArtistAppearsOn } = require('./spotify');
require('dotenv').config({ path: '../../.env' });

async function main() {
  const spDc = process.env.SP_DC;
  const { browser, page } = await launchBrowser(spDc);
  try {
    console.log('Fetching own albums first to capture token...');
    await fetchArtistAlbums(page, '31TPClRtHm23RisEBtV3X7');
    console.log('Token captured:', !!page.capturedToken);
    
    console.log('Fetching all appearsOn albums...');
    const feat = await fetchArtistAppearsOn(page, '31TPClRtHm23RisEBtV3X7');
    console.log('Total appearsOn albums fetched:', feat.length);
    
    const trollsAlbums = feat.filter(a => a.title && a.title.toLowerCase().includes('trolls'));
    console.log('Trolls albums in appearsOn list:');
    trollsAlbums.forEach(a => console.log(`- [${a.id}] "${a.title}"`));
    
    const found = feat.find(a => a.id === '65ayND23IInUPHJKsaAqe7');
    console.log('Is 65ayND23IInUPHJKsaAqe7 in raw appearsOn?', !!found, found);
  } catch (err) {
    console.error(err);
  } finally {
    await browser.close();
  }
}

main();

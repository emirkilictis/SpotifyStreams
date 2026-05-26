require('dotenv').config({ path: '../../.env' });
const { launchBrowser } = require('./spotify');

const ARTIST_ID = '31TPClRtHm23RisEBtV3X7';

async function test() {
  console.log('Launching browser...');
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  
  let token = null;

  page.on('request', req => {
    const headers = req.headers();
    const auth = headers['authorization'];
    if (auth && auth.startsWith('Bearer ') && !token) {
      token = auth.slice(7);
    }
  });

  try {
    console.log('Navigating...');
    await page.goto('https://open.spotify.com/album/0O82niJ0NpcptYRxogeEZu', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    for (let i = 0; i < 10; i++) {
      if (token) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (!token) throw new Error('Token not found');

    const fetchPage = async (offset) => {
      return page.evaluate(async (token, artistId, offset) => {
        const res = await fetch('https://api-partner.spotify.com/pathfinder/v2/query', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            variables: { uri: `spotify:artist:${artistId}`, offset, limit: 5 },
            operationName: "queryArtistAppearsOn",
            extensions: {
              persistedQuery: {
                version: 1,
                sha256Hash: "9a4bb7a20d6720fe52d7b47bc001cfa91940ddf5e7113761460b4a288d18a4c1"
              }
            }
          })
        });
        return res.json();
      }, token, ARTIST_ID, offset);
    };

    console.log('Fetching page 1 (offset: 0)...');
    const p1 = await fetchPage(0);
    const p1_names = p1.data?.artistUnion?.relatedContent?.appearsOn?.items?.map(item => item.releases?.items?.[0]?.name) ?? [];
    
    console.log('Fetching page 2 (offset: 5)...');
    const p2 = await fetchPage(5);
    const p2_names = p2.data?.artistUnion?.relatedContent?.appearsOn?.items?.map(item => item.releases?.items?.[0]?.name) ?? [];

    console.log('Page 1 items:', p1_names);
    console.log('Page 2 items:', p2_names);

  } catch (err) {
    console.error(err);
  } finally {
    await browser.close();
  }
}

test();

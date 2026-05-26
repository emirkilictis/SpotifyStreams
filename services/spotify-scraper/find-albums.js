require('dotenv').config({ path: '../../.env' });
const { launchBrowser } = require('./spotify');
const axios = require('axios');

const queries = [
  'track:Until the end of time artist:"Justin Timberlake"',
  'track:Gone artist:"NSYNC"',
  'track:"Give It To Me" artist:Timbaland',
  'track:Bounce artist:Timbaland',
  'track:"Love Sex Magic" artist:Ciara',
  'track:Señorita artist:"Justin Timberlake"',
  'track:"What Goes Around" artist:"Justin Timberlake"',
  'track:"My Love" artist:"Justin Timberlake"',
  'track:Release artist:Timbaland'
];

async function test() {
  console.log('Launching browser to capture token...');
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  
  let capturedToken = null;

  page.on('request', req => {
    const headers = req.headers();
    const auth = headers['authorization'];
    if (auth && auth.startsWith('Bearer ') && !capturedToken) {
      capturedToken = auth.slice(7);
    }
  });

  try {
    console.log('Navigating to open.spotify.com...');
    await page.goto('https://open.spotify.com/album/0O82niJ0NpcptYRxogeEZu', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    for (let i = 0; i < 10; i++) {
      if (capturedToken) break;
      await new Promise(r => setTimeout(r, 500));
    }

    if (!capturedToken) throw new Error('Failed to capture token.');

    console.log('Searching for missing tracks...');
    for (const q of queries) {
      try {
        const res = await axios.get('https://api.spotify.com/v1/search', {
          params: { q, type: 'track', limit: 8 },
          headers: { 'Authorization': 'Bearer ' + capturedToken },
          timeout: 10000
        });
        
        console.log(`\nResults for query: "${q}"`);
        const tracks = res.data?.tracks?.items ?? [];
        for (const t of tracks) {
          console.log(`  - Track: "${t.name}" [ID: ${t.id}] (${(t.duration_ms/60000).toFixed(2)} min)`);
          console.log(`    Album: "${t.album?.name}" [ID: ${t.album?.id}] (Type: ${t.album?.album_type})`);
          console.log(`    Artists: ${t.artists.map(a => a.name).join(', ')}`);
        }
        await new Promise(r => setTimeout(r, 1000)); // sleep 1s
      } catch (err) {
        console.error(`Error searching for "${q}":`, err.message);
      }
    }
  } catch (err) {
    console.error('Error during test:', err.message);
  } finally {
    await browser.close();
  }
}

test();

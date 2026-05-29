const { launchBrowser } = require('./spotify');
require('dotenv').config({ path: '../../.env' });

async function main() {
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  try {
    page.on('request', async (req) => {
      const url = req.url();
      if (url.includes('pathfinder/v2')) {
        console.log(`\n>>> PATHFINDER REQUEST: ${url.slice(0, 120)}`);
        console.log(`Method: ${req.method()}`);
        if (req.method() === 'POST') {
          console.log(`PostData: ${req.postData()}`);
        }
      }
    });

    page.on('response', async (res) => {
      const url = res.url();
      if (url.includes('pathfinder/v2')) {
        try {
          const text = await res.text();
          const body = JSON.parse(text);
          if (body?.data?.artistUnion) {
            console.log(`<<< PATHFINDER RESPONSE for artistUnion:`);
            console.log(JSON.stringify(body, null, 2).slice(0, 300));
          }
        } catch (e) {}
      }
    });

    console.log('Navigating to Billie Eilish...');
    await page.goto('https://open.spotify.com/artist/6qqG38t71JXMv4q7znpcr0', {
      waitUntil: 'networkidle2', timeout: 40000
    });
    
    console.log('Waiting 5s...');
    await new Promise(r => setTimeout(r, 5000));
  } catch (err) {
    console.error(err);
  } finally {
    await browser.close();
  }
}

main();

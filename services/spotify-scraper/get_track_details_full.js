const { launchBrowser } = require('./spotify');
require('dotenv').config({ path: '../../.env' });

async function main() {
  console.log("Launching browser...");
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  
  try {
    console.log("Navigating to open.spotify.com...");
    await page.goto('https://open.spotify.com', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for token to be captured
    console.log("Waiting for token...");
    let token = null;
    for (let i = 0; i < 30; i++) {
      if (page.capturedToken) {
        token = page.capturedToken;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (!token) {
      console.error("Token not captured.");
      return;
    }

    console.log("Token captured! Fetching track details via page evaluate...");
    
    const track = await page.evaluate(async (tok, trackId) => {
      const url = `https://api.spotify.com/v1/tracks/${trackId}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${tok}` }
      });
      return res.json();
    }, token, '71BEy8FVmk4BCQ2TGhLlvm');

    console.log("Full Track Details:");
    console.log(JSON.stringify(track, null, 2));

  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await browser.close();
  }
}

main();

const { launchBrowser } = require('./spotify');
require('dotenv').config({ path: '../../.env' });

async function main() {
  console.log("Launching browser...");
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  
  try {
    const trackId = '71BEy8FVmk4BCQ2TGhLlvm';
    console.log(`Navigating to track ${trackId}...`);
    
    let trackResult = null;
    const handler = async (res) => {
      try {
        if (!res.url().includes('pathfinder/v2')) return;
        const body = await res.json().catch(() => null);
        const tr = body?.data?.trackUnion;
        if (tr && tr.uri === `spotify:track:${trackId}` && !trackResult) {
          trackResult = tr;
        }
      } catch {}
    };
    page.on('response', handler);

    await page.goto(`https://open.spotify.com/track/${trackId}`, {
      waitUntil: 'networkidle2', timeout: 40000,
    });
    
    for (let i = 0; i < 20; i++) {
      if (trackResult) break;
      await new Promise(r => setTimeout(r, 500));
    }
    page.off('response', handler);

    if (!trackResult) {
      console.error("Failed to capture track details.");
      return;
    }

    console.log("Track Details Captured:");
    console.log("- Title:", trackResult.name);
    console.log("- Album Name:", trackResult.album?.name);
    console.log("- Album ID:", trackResult.album?.uri?.split(':')[2]);
    console.log("- Playcount:", trackResult.playcount);
    console.log("- Duration (ms):", trackResult.duration?.totalMilliseconds);
    console.log("- Artists:", trackResult.firstArtist?.items?.map(a => a.profile?.name) || trackResult.artists?.items?.map(a => a.profile?.name));
    console.log("- Artist URIs:", trackResult.artists?.items?.map(a => a.uri));

  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await browser.close();
  }
}

main();

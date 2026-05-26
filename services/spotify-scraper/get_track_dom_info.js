const { launchBrowser } = require('./spotify');
require('dotenv').config({ path: '../../.env' });

async function main() {
  console.log("Launching browser...");
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  
  try {
    const trackId = '71BEy8FVmk4BCQ2TGhLlvm';
    console.log(`Navigating to open.spotify.com/track/${trackId}...`);
    await page.goto(`https://open.spotify.com/track/${trackId}`, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Wait for elements to load
    await page.waitForSelector('h1', { timeout: 10000 });
    
    const info = await page.evaluate(() => {
      const title = document.querySelector('h1')?.innerText;
      
      // Select artist links
      const artistEls = Array.from(document.querySelectorAll('a[href^="/artist/"]'));
      const artists = artistEls.map(el => el.innerText).filter((v, i, self) => self.indexOf(v) === i); // unique

      // Select album link
      const albumEl = document.querySelector('a[href^="/album/"]');
      const albumName = albumEl?.innerText;
      const albumId = albumEl?.getAttribute('href')?.split('/')[2];

      return { title, artists, albumName, albumId };
    });

    console.log("DOM Information:");
    console.log(info);

  } catch (err) {
    console.error("Error:", err.message);
  } finally {
    await browser.close();
  }
}

main();

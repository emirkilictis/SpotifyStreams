const { launchBrowser } = require('./spotify');
require('dotenv').config({ path: '../../.env' });
const fs = require('fs');

async function main() {
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  try {
    console.log('Navigating to Billie Eilish...');
    await page.goto('https://open.spotify.com/artist/6qqG38t71JXMv4q7znpcr0', {
      waitUntil: 'networkidle2', timeout: 40000
    });
    
    console.log('Taking screenshot...');
    await page.screenshot({ path: 'billie_screenshot.png' });
    
    const title = await page.title();
    console.log(`Page title: ${title}`);
    
    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('Body snippet:', bodyText.slice(0, 1000));
  } catch (err) {
    console.error(err);
  } finally {
    await browser.close();
  }
}

main();

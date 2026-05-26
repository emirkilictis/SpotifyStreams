require('dotenv').config({ path: '../../.env' });
const { launchBrowser } = require('./spotify');

const ARTIST_ID = '31TPClRtHm23RisEBtV3X7';

async function test() {
  console.log('Launching browser...');
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  
  try {
    console.log('Navigating to appears-on page...');
    await page.goto(`https://open.spotify.com/artist/${ARTIST_ID}/appears-on`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await new Promise(r => setTimeout(r, 3000));

    console.log('Scrolling and extracting IDs incrementally...');
    const allIds = new Set();
    
    // We will scroll 15 times and extract IDs after each scroll
    for (let i = 0; i < 15; i++) {
      // 1. Scroll
      await page.evaluate(() => {
        const scrollNode = Array.from(document.querySelectorAll('*')).find(el => {
          const style = window.getComputedStyle(el);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
        });
        if (scrollNode) {
          scrollNode.scrollTop += 1200;
          scrollNode.dispatchEvent(new Event('scroll'));
        }
      });
      
      await new Promise(r => setTimeout(r, 800)); // wait for lazy loading
      
      // 2. Extract
      const ids = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a'))
          .map(a => a.getAttribute('href'))
          .filter(href => href && href.startsWith('/album/'))
          .map(href => href.split('/')[2]);
      });
      
      ids.forEach(id => allIds.add(id));
      console.log(`  Scroll ${i+1}: Found ${ids.length} links in DOM (total unique so far: ${allIds.size})`);
    }

    console.log(`\nFinal unique album IDs count: ${allIds.size}`);
    const list = Array.from(allIds);
    console.log('Sample IDs:', list.slice(0, 5));

  } catch (err) {
    console.error('Error during test:', err.message);
  } finally {
    await browser.close();
  }
}

test();

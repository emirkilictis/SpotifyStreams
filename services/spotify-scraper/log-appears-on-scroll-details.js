require('dotenv').config({ path: '../../.env' });
const { launchBrowser } = require('./spotify');

const ARTIST_ID = '31TPClRtHm23RisEBtV3X7';

async function test() {
  console.log('Launching browser...');
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  
  page.on('request', async req => {
    try {
      const url = req.url();
      if (!url.includes('pathfinder/v2')) return;
      if (req.method() !== 'POST') return;
      
      const postData = JSON.parse(req.postData() || '{}');
      if (postData.operationName) {
        console.log(`Pathfinder POST: operationName=${postData.operationName}`);
        console.log(`  Variables:`, JSON.stringify(postData.variables));
      }
    } catch {}
  });

  try {
    console.log('Navigating to appears-on page...');
    await page.goto(`https://open.spotify.com/artist/${ARTIST_ID}/appears-on`, {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await new Promise(r => setTimeout(r, 3000));

    console.log('Scrolling down incrementally...');
    await page.evaluate(async () => {
      const scrollNode = Array.from(document.querySelectorAll('*')).find(el => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      });
      if (scrollNode) {
        for (let i = 0; i < 5; i++) {
          scrollNode.scrollTop += 2000;
          scrollNode.dispatchEvent(new Event('scroll'));
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    });

    await new Promise(r => setTimeout(r, 2000));
  } catch (err) {
    console.error('Error during test:', err.message);
  } finally {
    await browser.close();
  }
}

test();

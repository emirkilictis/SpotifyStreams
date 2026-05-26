require('dotenv').config({ path: '../../.env' });
const { launchBrowser } = require('./spotify');

const ARTIST_ID = '31TPClRtHm23RisEBtV3X7';

async function test() {
  console.log('Launching browser...');
  const { browser, page } = await launchBrowser(process.env.SP_DC);
  
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));

  page.on('response', async res => {
    try {
      if (!res.url().includes('pathfinder/v2')) return;
      const body = await res.json().catch(() => null);
      if (!body?.data) return;
      
      const keys = Object.keys(body.data);
      if (keys.includes('playlistV2')) {
        const pl = body.data.playlistV2;
        console.log(`\n--- playlistV2 Intercepted ---`);
        console.log(`Name: ${pl.name}`);
        console.log(`URI: ${pl.uri}`);
        if (pl.content?.items) {
          console.log(`Content items count: ${pl.content.items.length}`);
          if (pl.content.items.length > 0) {
            console.log(`First item structure:`, JSON.stringify(pl.content.items[0], null, 2));
          }
        } else {
          console.log(`Keys in playlistV2:`, Object.keys(pl));
        }
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

    console.log('Scrolling...');
    await page.evaluate(async () => {
      const scrollNode = Array.from(document.querySelectorAll('*')).find(el => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      });
      if (scrollNode) {
        let prevScrollTop = -1;
        for (let i = 0; i < 5; i++) {
          scrollNode.scrollTop += 2000;
          scrollNode.dispatchEvent(new Event('scroll'));
          await new Promise(r => setTimeout(r, 1500));
          if (scrollNode.scrollTop === prevScrollTop) break;
          prevScrollTop = scrollNode.scrollTop;
        }
      }
    });

    await new Promise(r => setTimeout(r, 3000));
  } catch (err) {
    console.error('Error during test:', err.message);
  } finally {
    await browser.close();
  }
}

test();

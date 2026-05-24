/**
 * Setup login flow.
 * Görünür Chrome penceresi açar, kullanıcı Spotify'a giriş yapar,
 * sp_dc cookie'si otomatik olarak .env dosyasına yazılır.
 */

require('dotenv').config({ path: '../../.env' });
const fs        = require('fs');
const path      = require('path');
const puppeteer = require('puppeteer-extra');
const Stealth   = require('puppeteer-extra-plugin-stealth');
puppeteer.use(Stealth());

const ENV_PATH = path.join(__dirname, '../../.env');

(async () => {
  console.log('\n=== Spotify Login Setup ===\n');
  console.log('Birazdan Chrome penceresi açılacak.');
  console.log('1) Spotify\'a giriş yap (Google ile, e-posta ile, fark etmez)');
  console.log('2) Ana sayfa açıldıktan sonra bu pencere otomatik kapanacak\n');

  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });

  const page = await browser.newPage();
  await page.goto('https://accounts.spotify.com/login', { waitUntil: 'domcontentloaded' });

  console.log('Login bekleniyor... (giriş yaptıktan sonra otomatik devam eder)');

  // Login başarılı olunca open.spotify.com'a yönlendirilir, sp_dc orada set edilir
  let spDc = null;
  for (let i = 0; i < 600; i++) { // 10 dakika timeout
    await new Promise(r => setTimeout(r, 1000));
    const cookies = await page.cookies('https://open.spotify.com', 'https://accounts.spotify.com');
    const dc = cookies.find(c => c.name === 'sp_dc');
    if (dc) {
      spDc = dc.value;
      // Anasayfa açılana kadar biraz daha bekle
      const url = page.url();
      if (url.includes('open.spotify.com') && !url.includes('login')) break;
    }
  }

  await browser.close();

  if (!spDc) {
    console.error('\n❌ sp_dc cookie\'si yakalanamadı. Tekrar dene.');
    process.exit(1);
  }

  console.log('\n✅ sp_dc yakalandı:', spDc.slice(0, 50) + '...');

  // .env dosyasını güncelle
  let envContent = fs.readFileSync(ENV_PATH, 'utf8');
  if (/^SP_DC=/m.test(envContent)) {
    envContent = envContent.replace(/^SP_DC=.*$/m, `SP_DC=${spDc}`);
  } else {
    envContent += `\nSP_DC=${spDc}\n`;
  }
  fs.writeFileSync(ENV_PATH, envContent);
  console.log('✅ .env güncellendi.\n');
  console.log('Şimdi `node scraper.js` çalıştırabilirsin.');
})().catch(err => { console.error('HATA:', err.message); process.exit(1); });

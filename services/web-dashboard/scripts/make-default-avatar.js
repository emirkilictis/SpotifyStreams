/**
 * One-off generator for the default artist avatar (public/images/default.jpg).
 *
 * app.js falls back to '/images/default.jpg' in several places (picker cards,
 * modal covers, comparison avatars) whenever an artist has no image_url yet —
 * but that file never existed, so those artists rendered a broken-image icon
 * instead of a placeholder. og-default.png can't cover this: it's a 1200×630
 * landscape OG banner, wrong aspect ratio for a square/circular avatar slot.
 * This produces a neutral square placeholder (no single artist), same
 * Spotify-green brand mark as og-default.png's logo.
 *
 * Run from anywhere:  node services/web-dashboard/scripts/make-default-avatar.js
 * Re-run only when the design changes; the JPEG is committed.
 */
const path = require('path');
const puppeteer = require(path.join(__dirname, '../../spotify-scraper/node_modules/puppeteer'));

const SIZE = 512;
const OUT = path.join(__dirname, '../public/images/default.jpg');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1120"/>
      <stop offset="0.55" stop-color="#0f172a"/>
      <stop offset="1" stop-color="#111c33"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.38" r="0.65">
      <stop offset="0" stop-color="#1db954" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#1db954" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect width="${SIZE}" height="${SIZE}" fill="url(#bg)"/>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#glow)"/>

  <!-- Spotify-style mark, scaled up as the whole placeholder -->
  <g transform="translate(${SIZE/2}, ${SIZE/2 - 10})">
    <circle r="130" fill="#1db954"/>
    <g fill="none" stroke="#0b1120" stroke-width="20" stroke-linecap="round">
      <path d="M -76 -36 Q 0 -63 76 -22"/>
      <path d="M -67 4 Q 0 -18 67 13"/>
      <path d="M -54 44 Q 0 29 54 53"/>
    </g>
  </g>

  <text x="${SIZE/2}" y="${SIZE - 46}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="700"
        fill="#94a3b8" letter-spacing="4">NO PHOTO</text>
</svg>`;

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox'],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
    await page.setContent(
      `<!DOCTYPE html><html><head><style>*{margin:0;padding:0}body{width:${SIZE}px;height:${SIZE}px;overflow:hidden}</style></head><body>${svg}</body></html>`,
      { waitUntil: 'networkidle0' }
    );
    await page.screenshot({ path: OUT, type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
    console.log('Wrote', OUT);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });

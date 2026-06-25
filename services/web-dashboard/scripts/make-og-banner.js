/**
 * One-off generator for the default link-preview banner (public/images/og-default.png).
 *
 * Twitter/OG cards need a real raster image at ~1200×630 (1.91:1, landscape).
 * The old default was jt.jpg — a 682×1024 PORTRAIT artist photo — so the
 * summary_large_image card cropped a tall face into a huge ugly band. This
 * produces a neutral, branded 1200×630 cover instead (no single artist).
 *
 * Run from anywhere:  node services/web-dashboard/scripts/make-og-banner.js
 * Re-run only when the design changes; the PNG is committed.
 */
const path = require('path');
const puppeteer = require(path.join(__dirname, '../../spotify-scraper/node_modules/puppeteer'));

const W = 1200, H = 630;
const OUT = path.join(__dirname, '../public/images/og-default.png');

// Static "equalizer" bars (heights as % of a 180px band), Spotify-green.
const BARS = [38, 64, 30, 88, 52, 100, 46, 74, 34, 92, 58, 70, 26, 82, 44];
const barW = 26, gap = 14;
const barsTotalW = BARS.length * barW + (BARS.length - 1) * gap;
const barsX0 = (W - barsTotalW) / 2;
const barsBaseY = 500;
const barsBand = 118;
const barsSvg = BARS.map((h, i) => {
  const bh = Math.round((h / 100) * barsBand);
  const x = barsX0 + i * (barW + gap);
  const y = barsBaseY - bh;
  const op = 0.45 + (h / 100) * 0.55;
  return `<rect x="${x}" y="${y}" width="${barW}" height="${bh}" rx="6" fill="#1db954" opacity="${op.toFixed(2)}"/>`;
}).join('');

const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b1120"/>
      <stop offset="0.55" stop-color="#0f172a"/>
      <stop offset="1" stop-color="#111c33"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.18" r="0.75">
      <stop offset="0" stop-color="#1db954" stop-opacity="0.28"/>
      <stop offset="1" stop-color="#1db954" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="title" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#cdeede"/>
    </linearGradient>
  </defs>

  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect x="0" y="0" width="${W}" height="6" fill="#1db954"/>

  <!-- Spotify-style mark -->
  <g transform="translate(${W/2}, 168)">
    <circle r="58" fill="#1db954"/>
    <g fill="none" stroke="#0b1120" stroke-width="9" stroke-linecap="round">
      <path d="M -34 -16 Q 0 -28 34 -10"/>
      <path d="M -30 2 Q 0 -8 30 6"/>
      <path d="M -24 20 Q 0 13 24 24"/>
    </g>
  </g>

  <text x="${W/2}" y="300" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="78" font-weight="800"
        fill="url(#title)" letter-spacing="-1.5">Spotify Streams</text>

  <text x="${W/2}" y="352" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="30" font-weight="600"
        fill="#1db954" letter-spacing="6">FAN DASHBOARD</text>

  <text x="${W/2}" y="${barsBaseY + 78}" text-anchor="middle"
        font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="500"
        fill="#94a3b8">Live stream counts · daily gains · milestones — updated daily</text>

  ${barsSvg}
</svg>`;

(async () => {
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    await page.setContent(
      `<!DOCTYPE html><html><head><style>*{margin:0;padding:0}body{width:${W}px;height:${H}px;overflow:hidden}</style></head><body>${svg}</body></html>`,
      { waitUntil: 'networkidle0' }
    );
    await page.screenshot({ path: OUT, type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
    console.log('Wrote', OUT);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });

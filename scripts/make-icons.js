// Draws the PNG app icons from public/icons/icon.svg (needs playwright-core + a Chromium)
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
(async () => {
  const dir = path.join(__dirname, '..', 'public', 'icons');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const exe = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
  const b = await chromium.launch({ executablePath: exe });
  const shot = async (name, size, pad, bg) => {
    const pg = await b.newPage({ viewport: { width: size, height: size } });
    const inner = svg.replace('<svg ', `<svg width="${size - 2 * pad}" height="${size - 2 * pad}" `);
    await pg.setContent(`<body style="margin:0;background:${bg || 'transparent'};display:flex;align-items:center;justify-content:center;width:${size}px;height:${size}px">${inner}</body>`);
    await pg.screenshot({ path: path.join(dir, name), omitBackground: !bg });
    await pg.close();
  };
  await shot('icon-192.png', 192, 0);
  await shot('icon-512.png', 512, 0);
  await shot('icon-maskable-512.png', 512, 64, '#0f5c3f');
  await shot('apple-touch-icon.png', 180, 0, '#0f5c3f');
  await b.close();
})();

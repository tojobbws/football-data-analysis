// Row rects of the home list for 2026-11-07 (CSS px at 390 wide; the capture is 3x), with the featured flag.
const path = require('path'); const fs = require('fs');
const { chromium } = require('playwright-core');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
  const pg = await ctx.newPage();
  await pg.goto('https://khemthitfootball.com/?date=2026-11-07', { waitUntil: 'networkidle', timeout: 90000 });
  await pg.waitForTimeout(2000);
  const info = await pg.evaluate(() => {
    const sy = window.scrollY;
    const rows = [...document.querySelectorAll('a[href^="/matches/"]')].map((a) => { const r = a.getBoundingClientRect(); return { href: a.getAttribute('href'), x: r.x, y: r.y + sy, w: r.width, h: r.height, featured: [...a.querySelectorAll('img')].some((i) => decodeURIComponent(i.currentSrc || i.src).includes('compass-picks')), ring: getComputedStyle(a).borderColor + ' ' + getComputedStyle(a).backgroundColor, text: a.innerText.replace(/\s+/g, ' ').slice(0, 60) }; }).filter((r) => r.h > 40 && r.h < 140);
    const head = document.querySelector('header'); const hr = head ? head.getBoundingClientRect() : null;
    const h2 = [...document.querySelectorAll('h2')].map((e) => { const r = e.getBoundingClientRect(); return { text: e.innerText.slice(0, 40), y: r.y + sy, h: r.height }; });
    return { rows, header: hr && { y: hr.y + sy, h: hr.height }, h2, height: document.documentElement.scrollHeight };
  });
  await pg.screenshot({ path: path.join(__dirname, 'assets', 'real', 'home-1107.png'), fullPage: true });
  fs.writeFileSync(path.join(__dirname, 'assets', 'real', 'home-1107.json'), JSON.stringify(info, null, 1));
  console.log(info.rows.length, 'rows', info.rows.filter((r) => r.featured).map((r) => r.text + ' @' + Math.round(r.y)).join(' | '), 'h', info.height, 'header', JSON.stringify(info.header));
  await b.close();
})();

// Capture the live site at phone size, 3x, for the intro film's plates. usage: node intro/capture.cjs
const path = require('path');
const { chromium } = require('playwright-core');
const OUT = path.join(__dirname, 'assets', 'real');
const PAGES = [
  ['home-1107', '/?date=2026-11-07'],
  ['match-parma-bologna', '/matches/parma-vs-bologna-2026-11-07'],
  ['perf-week-1102', '/performance?week=2026-11-02'],
  ['perf-day-1107', '/performance/2026-11-07'],
  ['perf-now', '/performance'],
];
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
  const pg = await ctx.newPage();
  for (const [name, url] of PAGES) {
    await pg.goto('https://khemthitfootball.com' + url, { waitUntil: 'networkidle', timeout: 90000 });
    await pg.waitForTimeout(2000);
    await pg.screenshot({ path: path.join(OUT, name + '.png'), fullPage: true });
    console.log(name, await pg.evaluate(() => document.documentElement.scrollHeight));
  }
  await b.close();
})();

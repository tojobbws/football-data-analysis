// Frame-by-frame render of a clip page through window.seek(t) (Playwright + system Edge, deterministic).
// usage: node render.cjs probe <date> <clip> t1 t2 ...  -> days/<date>/out/<clip>/sheet.png (stills side by side)
//        node render.cjs full  <date> <clip>            -> days/<date>/out/<clip>/video.mp4 (silent, 30 fps)
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { chromium } = require('playwright-core');
const { ROOT, REPO, dayDir, readJson } = require('./lib.cjs');

const [mode, date, key, ...rest] = process.argv.slice(2);
const dir = path.join(dayDir(date), 'out', key);
const TL = readJson(path.join(dir, 'timeline.json'));
const BRAND = path.join(REPO, 'apps', 'web', 'public', 'brand'); // the site's own brand files
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, rsp) => {
      const url = decodeURIComponent(req.url.split('?')[0]);
      const [base, rel] = url.startsWith('/brand/') ? [BRAND, url.slice(7)] : [ROOT, url];
      const p = path.join(base, rel);
      if (!p.startsWith(base) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(rsp);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  const srv = await serve();
  const browser = await chromium.launch({ channel: 'msedge', args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--run-all-compositor-stages-before-draw'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  page.on('requestfailed', (r) => console.error('request failed', r.url()));
  page.on('response', (r) => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) console.error('missing', r.url()); });
  await page.addInitScript((tl) => { window.TL = tl; window.RENDER = true; }, TL);
  await page.goto(`http://127.0.0.1:${srv.address().port}/${TL.page}`);
  await page.waitForFunction(() => window.ready === true, null, { timeout: 30000 });
  await page.addStyleTag({ content: '#hud{display:none}' });
  const shot = async (t) => {
    await page.evaluate((t) => new Promise((r) => { window.seek(t); requestAnimationFrame(() => requestAnimationFrame(r)); }), t);
    return page.screenshot({ type: 'png' });
  };
  if (mode === 'probe') {
    const times = rest.length ? rest.map(Number) : TL.type === 'opening' ? TL.subs.filter((_, i) => i % 2 === 0 || i === TL.subs.length - 1).map((x) => Math.min(x.t1, TL.T - 0.5)) : [1.6, TL.scenes[1] + 1.2, TL.scenes[1] + 3.5, Math.min(TL.reveal, TL.T) - 0.4, Math.min(TL.reveal + 0.9, TL.T - 0.5), TL.T - 0.3].filter((t) => t > 0 && t < TL.T);
    const files = [];
    for (const t of times) { const f = path.join(dir, `probe_${t.toFixed(2)}.png`); fs.writeFileSync(f, await shot(t)); files.push(f); }
    const args = ['-v', 'error', '-y'];
    files.forEach((f) => args.push('-i', f));
    args.push('-filter_complex', files.map((_, i) => `[${i}:v]scale=360:640[s${i}]`).join(';') + ';' + files.map((_, i) => `[s${i}]`).join('') + `hstack=inputs=${files.length}`, path.join(dir, 'sheet.png'));
    if (files.length > 1) execFileSync('ffmpeg', args); else fs.copyFileSync(files[0], path.join(dir, 'sheet.png'));
    console.log(key, 'stills', times.map((t) => t.toFixed(2)).join(' '), '->', path.join(dir, 'sheet.png'));
  } else if (mode === 'full') {
    const out = path.join(dir, 'video.mp4');
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'png', '-i', '-', '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-pix_fmt', 'yuv420p', '-r', '30', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    const t0 = Date.now();
    for (let f = 0; f < TL.frames; f++) {
      const buf = await shot(f / 30);
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
      if (f % 90 === 0) console.log(key, 'frame', f, '/', TL.frames, ((Date.now() - t0) / 1000).toFixed(0) + 's');
    }
    ff.stdin.end();
    await new Promise((r) => ff.on('close', r));
    console.log(key, 'video', out);
  }
  await browser.close();
  srv.close();
})().catch((e) => { console.error(e); process.exit(1); });

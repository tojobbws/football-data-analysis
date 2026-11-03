// Run the pipeline for one football day after spot.json is written.
// usage: node run.cjs [YYYY-MM-DD] stills   -> prepare, tts, timeline, one stills sheet per clip (review these first)
//        node run.cjs [YYYY-MM-DD] film     -> render every clip in parallel, audio, join
//        node run.cjs [YYYY-MM-DD] all      -> both
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { dateArg, dayDir, readJson } = require('./lib.cjs');

const date = dateArg();
const step = process.argv.slice(2).find((a) => ['stills', 'film', 'all'].includes(a)) || 'all';
const dir = dayDir(date);
const node = (args) => execFileSync(process.execPath, args, { cwd: __dirname, stdio: 'inherit' });
const bg = (args) => new Promise((res, rej) => { const p = spawn(process.execPath, args, { cwd: __dirname, stdio: 'inherit' }); p.on('close', (c) => (c ? rej(new Error(args.join(' ') + ' exited ' + c)) : res())); });

(async () => {
  if (step === 'stills' || step === 'all') {
    node(['prepare.cjs', date]);
    node(['tts.cjs', date]);
    node(['timeline.cjs', date]);
    const keys = readJson(path.join(dir, 'clips.json')).map((c) => c.key);
    await Promise.all(keys.map((k) => bg(['render.cjs', 'probe', date, k])));
  }
  if (step === 'film' || step === 'all') {
    const keys = readJson(path.join(dir, 'clips.json')).map((c) => c.key);
    const t0 = Date.now();
    await Promise.all(keys.map((k) => bg(['render.cjs', 'full', date, k])));
    console.log(`rendered ${keys.length} clips in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    node(['audio.cjs', date]);
    node(['join.cjs', date]);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

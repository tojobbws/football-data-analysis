// Yesterday Prediction Recap: one vertical film of a finished day's คู่น่าจับตา, from recap-fetch.cjs facts and a
// written script (days/<date>/recap/spot.json, shape: examples/2026-11-03.recap.json).
// usage: node recap.cjs <YYYY-MM-DD> stills   -> check the script, voice (cached), timeline, stills sheet
//        node recap.cjs <YYYY-MM-DD> film     -> parallel chunk render, music + SFX + mix, final mp4 + contact sheet
//        node recap.cjs <YYYY-MM-DD> all
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync, spawnSync } = require('child_process');
const { dayDir, readJson, writeJson } = require('./lib.cjs');
const { speak } = require('./tts.cjs');
const { kit, mixdown } = require('./audio.cjs');

const date = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const step = process.argv.slice(2).find((a) => ['stills', 'film', 'all'].includes(a)) || 'all';
if (!date) { console.error('usage: node recap.cjs <YYYY-MM-DD> stills|film|all'); process.exit(1); }
const DAY = dayDir(date);
const RDIR = path.join(DAY, 'recap');
const ODIR = path.join(DAY, 'out', 'recap');
fs.mkdirSync(ODIR, { recursive: true });

const TEMPO = 1.15;                 // same voice speed as the spotlight film
const LEAD = { opening: 0.95, match: 0.45, summary: 0.55, closing: 0.6 }; // silence before each segment (room for the transition)
const RESULT_PAUSE = 0.32;          // beat of silence before the result word (ทายถูก / ทายผิด)
const TAIL = 2.0;                   // logo hold after the last word
const HOLD = 0.9;                   // the result stays on screen after the voice before the next card flips in
const TAGS = { opening: '[excited] ', match: '[excited] ', summary: '[confident] ', closing: '[confident] ' };
const BANNED = ['ทีเด็ด', 'แทง', 'กำไร', 'ตามคู่นี้', 'การันตี', 'ชัวร์', 'แน่นอน', 'ได้เงิน', 'เสียเงิน'];
// marks each segment must carry: a verbatim piece of its text whose first character times a visual event
const MARKS = { opening: ['title', 'date'], match: ['score', 'pick', 'result'], summary: ['total', 'win', 'loss', 'rate'], closing: ['line1', 'line2', 'logo', 'tag'] };

// ---------- 1. script + facts -> segments ----------
function prepare() {
  const facts = readJson(path.join(RDIR, 'facts.json'));
  const spot = readJson(path.join(RDIR, 'spot.json'));
  const errors = [];
  const s = facts.summary;
  if (s.pending || facts.matches.some((m) => !m.finished)) errors.push('a match is not finished or settled yet');
  const segs = [{ role: 'opening', ...spot.opening }];
  const keys = spot.matches.map((m) => m.match);
  for (const m of facts.matches) if (!keys.includes(m.key)) errors.push(`${m.key} (${m.home.name} vs ${m.away.name}) is missing from the script: every pick is shown, right or wrong`);
  for (const sm of spot.matches) {
    const m = facts.matches.find((x) => x.key === sm.match);
    if (!m) { errors.push(`unknown match ${sm.match}`); continue; }
    if (!sm.segment.includes(m.result)) errors.push(`${sm.match}: the voice must say the real result "${m.result}"`);
    if (!sm.marks.result.includes(m.result)) errors.push(`${sm.match}: marks.result must be the result word "${m.result}"`);
    for (const p of sm.subs) {
      const sc = p.show.match(/(\d+)\s*-\s*(\d+)/);
      if (sc && ![`${m.home.goals}-${m.away.goals}`, `${m.away.goals}-${m.home.goals}`].includes(`${sc[1]}-${sc[2]}`)) errors.push(`${sm.match}: score "${sc[0]}" is not the real ${m.home.goals}-${m.away.goals}`);
    }
    segs.push({ role: 'match', ...sm, match: m });
  }
  // the dashboard numbers come from facts; the spoken ones must agree with the subtitles that show them
  const sumShow = spot.summary.subs.map((p) => p.show).join(' ');
  if (s.rate_pct != null && !sumShow.includes(`${s.rate_pct}%`)) errors.push(`summary: the subtitles must show the real rate ${s.rate_pct}%`);
  segs.push({ role: 'summary', ...spot.summary }, { role: 'closing', ...spot.closing });
  segs.forEach((g, i) => {
    const where = `${g.role}${g.match ? ' ' + g.match.key : ''}`;
    for (const w of BANNED) if (g.segment.includes(w)) errors.push(`${where}: banned word "${w}"`);
    let cur = 0;
    for (const p of g.subs) {
      const ix = g.segment.indexOf(p.say, cur);
      if (ix < 0) errors.push(`${where}: subtitle "${p.say}" is not in the voice text (in order)`); else cur = ix + p.say.length;
      for (const h of p.hi || []) if (!p.show.includes(h)) errors.push(`${where}: highlight "${h}" is not in "${p.show}"`);
    }
    for (const k of MARKS[g.role]) if (!g.marks || !g.marks[k] || !g.segment.includes(g.marks[k])) errors.push(`${where}: marks.${k} must be a piece of the voice text`);
    g.i = i;
  });
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  return { facts, segs };
}

// ---------- 2. voice ----------
async function voice(segs) {
  for (const g of segs) await speak(TAGS[g.role] + g.segment, path.join(RDIR, 'vo'), g.i, `recap ${g.role}`);
}

// ---------- 3. timeline from the character timestamps ----------
function timeline({ facts, segs }) {
  let clock = 0;
  const out = [], subs = [], scenes = [];
  for (const g of segs) {
    const j = readJson(path.join(RDIR, 'vo', `s${g.i}.json`));
    const a = j.alignment, chars = a.characters, text = chars.join('');
    if (text !== j.text) throw new Error(`s${g.i}: alignment text mismatch`);
    const tagEnd = text.indexOf(']') + 1;
    let first = tagEnd; while (!chars[first].trim()) first++;
    const speechStart = a.character_start_times_seconds[first], speechEnd = a.character_end_times_seconds.at(-1);
    const trim = Math.max(0, speechStart - 0.04);
    const fast = path.join(RDIR, 'vo', `s${g.i}_fast.wav`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(trim), '-i', path.join(RDIR, 'vo', `s${g.i}.mp3`), '-af', `atempo=${TEMPO},aresample=48000`, '-ac', '1', fast]);
    const at = clock + LEAD[g.role];
    // a silent beat before the result word
    const cuts = [];
    if (g.role === 'match') {
      const ix = text.indexOf(g.marks.result, tagEnd);
      let p = ix - 1; while (p > tagEnd && !chars[p].trim()) p--;
      cuts.push({ src: (a.character_end_times_seconds[p] + a.character_start_times_seconds[ix]) / 2, pause: RESULT_PAUSE });
    }
    const toFilm = (t) => at + (t - trim) / TEMPO + cuts.filter((c) => t > c.src).reduce((s, c) => s + c.pause, 0);
    const charAt = (piece, from = tagEnd) => { const ix = text.indexOf(piece, from); if (ix < 0) throw new Error(`s${g.i}: "${piece}" not found`); return ix; };
    const marks = {};
    for (const k of MARKS[g.role]) marks[k] = +toFilm(a.character_start_times_seconds[charAt(g.marks[k])]).toFixed(3);
    let cursor = tagEnd;
    const first0 = subs.length;
    for (const p of g.subs) {
      const ix = charAt(p.say, cursor), last = ix + p.say.length - 1;
      subs.push({ seg: g.i, show: p.show, hi: p.hi || [], onscreen: !!p.onscreen, t0: +toFilm(a.character_start_times_seconds[ix]).toFixed(3), t1: +toFilm(a.character_end_times_seconds[last]).toFixed(3) });
      cursor = last + 1;
    }
    const start = toFilm(speechStart), end = toFilm(speechEnd);
    out.push({ i: g.i, role: g.role, file: `recap/vo/s${g.i}_fast.wav`, at: +at.toFixed(3), start: +start.toFixed(3), end: +end.toFixed(3), cuts: cuts.map((c) => ({ at: +((c.src - trim) / TEMPO).toFixed(3), pause: c.pause })) });
    scenes.push({ role: g.role, key: g.match ? g.match.key : g.role, t0: +(g.i === 0 ? 0 : clock + 0.05).toFixed(3), speech: +start.toFixed(3), end: +end.toFixed(3), marks, subs: [first0, subs.length] });
    clock = end + (g.role === 'match' ? HOLD : 0);
  }
  const T = +(clock + TAIL).toFixed(3);
  scenes.forEach((s, k) => { s.t1 = k + 1 < scenes.length ? scenes[k + 1].t0 : T; });
  const ms = scenes.filter((s) => s.role === 'match');
  const sum = scenes.find((s) => s.role === 'summary'), cl = scenes.find((s) => s.role === 'closing');
  const probe = [scenes[0].marks.date + 0.9, ...ms.flatMap((s) => [s.marks.pick + 0.6, s.marks.result + 1.0]), sum.marks.rate + 1.4, cl.marks.line2 + 0.8, T - 0.3].map((t) => +Math.min(t, T - 0.05).toFixed(2));
  const TL = { key: 'recap', page: 'recap.html', type: 'recap', T, fps: 30, frames: Math.round(T * 30), tempo: TEMPO, segs: out, subs, scenes, probe,
    facts: { date: facts.date, date_th: facts.date_th, date_short: facts.date_short, summary: facts.summary, matches: segs.filter((g) => g.match).map((g) => ({ ...g.match, head: g.head })) } };
  writeJson(path.join(ODIR, 'timeline.json'), TL);
  console.log('recap T', T, '·', scenes.map((s) => `${s.key} ${s.t0.toFixed(2)}`).join(' / '));
  for (const s of subs) console.log('  ', s.t0.toFixed(2), s.t1.toFixed(2), s.onscreen ? '(on screen)' : '', s.show);
  return TL;
}

// ---------- 4. sound ----------
function sound(TL) {
  const T = TL.T + 0.6;
  const K = kit(T);
  const { mus, sfx, kick, noiseHit, snare, bassNote, chord, riser, whoosh, boom, crowd, bell, groove, audioLogo, fadeTail, add } = K;
  const sc = TL.scenes, open = sc[0], ms = sc.filter((s) => s.role === 'match'), sum = sc.find((s) => s.role === 'summary'), cl = sc.find((s) => s.role === 'closing');
  const statusOf = (key) => TL.facts.matches.find((m) => m.key === key).status;
  // a short mechanical flap (split-flap scoreboard)
  const flap = (t0, g = 1) => { noiseHit(sfx, t0, 0.05, 90, 9000, 2500, g * 0.5, 0.2); noiseHit(sfx, t0 + 0.028, 0.04, 110, 7000, 2000, g * 0.35, -0.2); };
  const tick = (t0, g = 1) => add(sfx, t0, (t) => Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 140), 0.05, g * 0.25);
  // opening: floodlights clunk on, riser into the logo impact, the stadium hums
  [0.1, 0.25, 0.4, 0.55].forEach((t, k) => { kick(sfx, t, 0.22); noiseHit(sfx, t, 0.25, 18, 5000, 600, 0.18, k % 2 ? 0.5 : -0.5); });
  riser(sfx, 0, 0.75, 0.32); boom(sfx, 0.75, 0.6); noiseHit(sfx, 0.75, 1.6, 2.2, 12000, 3000, 0.25);
  crowd(sfx, 0.2, cl.t0 + 0.5, 0.045, (t) => Math.min(1, t / 1.2));
  whoosh(sfx, open.marks.title - 0.25, 0.45, 0.25, -0.4); whoosh(sfx, open.marks.date - 0.2, 0.45, 0.25, 0.4);
  groove(0.75, ms[0].t0, 0.6);
  // matches: flip in, score flaps, drumroll to the result, then a cheer or a low thud
  for (const s of ms) {
    whoosh(sfx, s.t0 - 0.1, 0.5, 0.4, 0); flap(s.t0 + 0.15); flap(s.t0 + 0.32, 0.8);
    groove(s.t0 + 0.2, s.marks.pick, 0.8);
    for (let k = 0; k < 6; k++) flap(s.marks.score + k * 0.07, 0.6 + 0.08 * k);
    kick(sfx, s.marks.score + 0.45, 0.4);
    chord(mus, s.marks.pick, s.marks.result - s.marks.pick, [57, 60, 64, 69], 0.6, 900);
    { let tt = s.marks.pick + 0.15; while (tt < s.marks.result - 0.05) { const u = (tt - s.marks.pick) / (s.marks.result - s.marks.pick); snare(sfx, tt, 0.08 + 0.22 * u); tt += 0.12 / (1 + 2 * u); } }
    const R = s.marks.result, st = statusOf(s.key), good = st === 'WIN' || st === 'HALF_WIN', bad = st === 'LOSS' || st === 'HALF_LOSS';
    boom(sfx, R, good ? 0.6 : 0.5);
    if (good) { bell(sfx, R, 76, 0.8, -0.2); bell(sfx, R + 0.09, 81, 0.8, 0.2); bell(sfx, R + 0.18, 88, 0.9, 0); crowd(sfx, R - 0.05, 2.4, 0.22, (t) => Math.min(1, t / 0.15) * Math.exp(-Math.max(0, t - 0.5) * 1.3)); }
    else if (bad) { bassNote(mus, R, 0.55, 28, 0.55); bassNote(mus, R + 0.02, 0.5, 40, 0.25); crowd(sfx, R + 0.05, 1.6, 0.08, (t) => Math.min(1, t / 0.3) * Math.exp(-t * 1.6)); }
    else bell(sfx, R, 81, 0.6, 0);
    groove(R, s.t1, 0.85);
  }
  // summary: dashboard build, count-up ticks, a hit on the rate
  whoosh(sfx, sum.t0 - 0.1, 0.55, 0.45, 0); boom(sfx, sum.t0 + 0.2, 0.4);
  groove(sum.t0 + 0.2, cl.t0, 0.75);
  for (const k of ['total', 'win', 'loss']) { whoosh(sfx, sum.marks[k] - 0.12, 0.35, 0.22, k === 'win' ? -0.5 : 0.5); for (let n = 0; n < 5; n++) tick(sum.marks[k] + 0.08 + n * 0.09, 0.8); }
  for (let n = 0; n < 18; n++) tick(sum.marks.rate + n * 0.065, 0.7 + n * 0.02);
  boom(sfx, sum.marks.rate + 1.2, 0.55); noiseHit(sfx, sum.marks.rate + 1.2, 1.6, 2, 12000, 3000, 0.22);
  // closing: the stadium goes dark, two soft hits for the lines, the audio logo on the logo
  whoosh(sfx, cl.t0 - 0.1, 0.6, 0.35, 0);
  chord(mus, cl.t0, cl.marks.logo - cl.t0, [57, 60, 64, 69], 0.5, 700); bassNote(mus, cl.t0, cl.marks.logo - cl.t0, 33, 0.3);
  kick(sfx, cl.marks.line1, 0.3); kick(sfx, cl.marks.line2, 0.3);
  riser(sfx, cl.marks.line2, cl.marks.logo - cl.marks.line2, 0.25);
  audioLogo(cl.marks.logo, T);
  fadeTail();
  return { mus, sfx };
}

// ---------- 5. render ----------
const node = (args) => execFileSync(process.execPath, args, { cwd: __dirname, stdio: 'inherit' });
const bg = (args) => new Promise((res, rej) => { const p = spawn(process.execPath, args, { cwd: __dirname, stdio: 'inherit' }); p.on('close', (c) => (c ? rej(new Error(args.join(' ') + ' exited ' + c)) : res())); });

async function film(TL) {
  const n = Math.max(2, Math.min(8, os.cpus().length - 4));
  const per = Math.ceil(TL.frames / n);
  for (const f of fs.readdirSync(ODIR).filter((f) => f.startsWith('part_'))) fs.unlinkSync(path.join(ODIR, f));
  const t0 = Date.now();
  await Promise.all(Array.from({ length: n }, (_, k) => bg(['render.cjs', 'full', date, 'recap', String(k * per), String(Math.min(TL.frames, (k + 1) * per))])));
  console.log(`rendered ${TL.frames} frames in ${n} chunks, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  const parts = fs.readdirSync(ODIR).filter((f) => /^part_\d+\.mp4$/.test(f)).sort();
  fs.writeFileSync(path.join(ODIR, 'parts.txt'), parts.map((f) => `file '${f}'`).join('\n') + '\n');
  const { mus, sfx } = sound(TL);
  mixdown(DAY, ODIR, TL, mus, sfx, 'recap');
  fs.mkdirSync(path.join(DAY, 'final'), { recursive: true });
  const out = path.join(DAY, 'final', `${date}_recap.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(ODIR, 'parts.txt'), '-i', path.join(ODIR, 'mix.wav'), '-map', '0:v', '-map', '1:a',
    '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-r', '30', '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-t', (TL.frames / 30).toFixed(3), '-movflags', '+faststart', out]);
  const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout.trim();
  const loud = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.split('\n').filter((l) => /^\s+(I|Peak):/.test(l)).slice(-2).map((l) => l.trim()).join(' · ');
  const contact = path.join(DAY, 'final', 'recap_contact.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', out, '-vf', 'fps=1,scale=180:-1,tile=10x5', '-frames:v', '1', contact]);
  console.log(`${out}\n${Number(dur).toFixed(1)} s · ${loud}\ncontact sheet: ${contact}`);
}

(async () => {
  const P = prepare();
  let TL;
  if (step === 'stills' || step === 'all') {
    await voice(P.segs);
    TL = timeline(P);
    node(['render.cjs', 'probe', date, 'recap']);
  }
  if (step === 'film' || step === 'all') await film(TL || readJson(path.join(ODIR, 'timeline.json')));
})().catch((e) => { console.error(e.message); process.exit(1); });

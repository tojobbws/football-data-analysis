// Build days/<date>/out/<clip>/timeline.json from the ElevenLabs alignment: speeds each VO segment up,
// trims lead silence, places the segments on the film clock, and times every subtitle phrase
// (and every scene cut) from the real character timestamps.
// usage: node timeline.cjs [YYYY-MM-DD] [c0 c1 ...]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TEMPO = 1.15;          // VO speed-up (clear, a little faster than the raw take)
const LEAD = [0.35, 0.12, 0.12, 0.18]; // silence before each segment starts on the film clock
const TAIL = 0.6;            // hold after the last word of the outro
const REVEAL_PAUSE = 0.28;    // extra beat of silence before the pick name
const { dateArg, dayDir, readJson } = require('./lib.cjs');
const date = dateArg();
const dir = dayDir(date);
const clips = readJson(path.join(dir, 'clips.json'));
const want = process.argv.slice(2).filter((a) => /^c\d+$/.test(a));

for (const m of clips.filter((x) => !want.length || want.includes(x.key))) {
  const key = m.key;
  const vdir = path.join(dir, 'vo', key);
  const odir = path.join(dir, 'out', key);
  fs.mkdirSync(odir, { recursive: true });
  let clock = 0;
  const segs = [];
  const subs = [];
  for (let i = 0; i < m.segments.length; i++) {
    const j = JSON.parse(fs.readFileSync(path.join(vdir, `s${i}.json`), 'utf8'));
    const a = j.alignment;
    const chars = a.characters;
    const text = chars.join('');
    if (text !== j.text) throw new Error(`${key} s${i}: alignment text mismatch`);
    const tagEnd = text.indexOf(']') + 1;
    let first = tagEnd; while (!chars[first].trim()) first++;
    const speechStart = a.character_start_times_seconds[first];
    const speechEnd = a.character_end_times_seconds.at(-1);
    const trim = Math.max(0, speechStart - 0.04);
    const fast = path.join(vdir, `s${i}_fast.wav`);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(trim), '-i', path.join(vdir, `s${i}.mp3`), '-af', `atempo=${TEMPO},aresample=48000`, '-ac', '1', fast]);
    const at = clock + LEAD[i];
    let cut = Infinity;
    if (i === 2) { const p1 = text.indexOf(m.subs[2][0].say, tagEnd) + m.subs[2][0].say.length - 1; const p2 = text.indexOf(m.subs[2][1].say, p1); cut = (a.character_end_times_seconds[p1] + a.character_start_times_seconds[p2]) / 2; }
    const toFilm = (t) => at + (t - trim) / TEMPO + (t > cut ? REVEAL_PAUSE : 0);
    const start = toFilm(speechStart);
    const end = toFilm(speechEnd);
    segs.push({ i, file: `vo/${key}/s${i}_fast.wav`, at: +at.toFixed(3), start: +start.toFixed(3), end: +end.toFixed(3), cut: isFinite(cut) ? +((cut - trim) / TEMPO).toFixed(3) : null, pause: isFinite(cut) ? REVEAL_PAUSE : 0 });
    let cursor = tagEnd;
    for (const p of m.subs[i]) {
      const ix = text.indexOf(p.say, cursor);
      if (ix < 0) throw new Error(`${key} s${i}: phrase not found: ${p.say}`);
      const last = ix + p.say.length - 1;
      subs.push({ seg: i, show: p.show, hi: p.hi || [], t0: +toFilm(a.character_start_times_seconds[ix]).toFixed(3), t1: +toFilm(a.character_end_times_seconds[last]).toFixed(3) });
      cursor = last + 1;
    }
    clock = end;
  }
  const exit = m.segments.length < 4; // clip that hands over to the next one (no brand outro)
  const T = +(clock + (exit ? 0.85 : TAIL)).toFixed(3);
  // scene boundaries: each scene starts just before its segment's first word
  const scenes = segs.map((s, k) => (k === 0 ? 0 : +(s.start - 0.1).toFixed(3)));
  while (scenes.length < 4) scenes.push(+(T + 100).toFixed(3));
  const pickSub = subs.filter((s) => s.seg === 2)[1] || { t0: T + 100 };
  const out = { key, page: m.page || 'spot.html', type: m.type || 'match', exitAt: exit ? +(T - 0.45).toFixed(3) : null, T, fps: 30, frames: Math.round(T * 30), tempo: TEMPO, scenes, reveal: pickSub.t0, segs, subs, match: m };
  fs.writeFileSync(path.join(odir, 'timeline.json'), JSON.stringify(out, null, 2));
  console.log(key, 'T', T, 'scenes', scenes.join(' / '), 'reveal', pickSub.t0);
  for (const s of subs) console.log('  ', s.t0.toFixed(2), s.t1.toFixed(2), s.show);
}

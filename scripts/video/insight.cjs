// "ข้อมูลที่เว็บอื่นไม่บอก" film: one data insight, one vertical film (HyperFrames). First topic: late75, the league
// table as it would stand if every match had ended at minute 75 (insight-fetch.cjs).
// Inputs: insights/<slug>/facts.json (insight-fetch.cjs, the only source of numbers) + insights/<slug>/spot.json (the script).
// usage: node insight.cjs [slug=39-2026-late75] stills   -> check the script, voice (cached), timeline, mix, HyperFrames project, stills
//        node insight.cjs [slug] film                      -> render insights/<slug>/final/<slug>.mp4 + contact sheet
//        node insight.cjs [slug] all
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ROOT, REPO, readJson, writeJson } = require('./lib.cjs');
const { speak } = require('./tts.cjs');
const { kit, mixdown } = require('./audio.cjs');
const { r3, esc, mulberry, TLB, E, FONTS, BASE, ambient, sparks, scene, BRAND } = require('./hfkit.cjs');

const args = process.argv.slice(2);
const step = args.find((a) => ['stills', 'film', 'all'].includes(a)) || 'stills';
const slug = args.find((a) => a !== step) || '39-2026-late75';
const DIR = path.join(ROOT, 'insights', slug);
const OUT = path.join(DIR, 'out');
const HF = path.join(DIR, 'hf');
const FINAL = path.join(DIR, 'final');
const HFV = 'hyperframes@0.9.23';
const FPS = 30;

const TEMPO = 1.15;                 // same voice speed as the daily films
const COVER = 1.0;                  // film 0 -> COVER s: a still cover, the thumbnail frame
const LEAD = { hook: 0.3, table: 1.6, stat: 0.45, team: 0.55, lead: 0.45, outro: 0.45 }; // silence before each segment (table: room for the reshuffle)
const HOLD = { hook: 0.05, table: 0.5, stat: 0.55, team: 0.9, lead: 0.8, outro: 0 };     // the picture stays after the voice
const TAIL = 2.4;                   // the brand alone after the last word
const TAGS = { hook: '[excited] ', table: '[excited] ', stat: '[confident] ', team: '[excited] ', lead: '[confident] ', outro: '[confident] ' };
const BANNED = ['ทีเด็ด', 'แทง', 'กำไร', 'ตามคู่นี้', 'การันตี', 'ชัวร์', 'แน่นอน', 'ได้เงิน', 'เสียเงิน', 'ราคาบอล', 'ฟันธง'];
const MARKS = { hook: ['clock', 'turn'], table: ['up', 'mid', 'down'], stat: ['n'], team: ['head', 'total'], lead: ['led', 'won'], outro: ['ask', 'comment', 'follow'] };

// ---------- 1. script + facts ----------
function prepare() {
  const facts = readJson(path.join(DIR, 'facts.json'));
  const spot = readJson(path.join(DIR, 'spot.json'));
  const errors = [];
  const team = (n) => facts.teams.find((t) => t.name === n);
  // every number written on screen must be a number the facts hold
  const allowed = new Set((JSON.stringify(facts).match(/\d+/g) || []).map(Number));
  const subOf = (g, piece) => g.subs.find((p) => p.say.includes(piece));
  const nums = (s) => (s.match(/\d+/g) || []).map(Number);
  if (facts.warnings && facts.warnings.length) errors.push(`facts.json has warnings, check them first: ${facts.warnings.join('; ')}`);
  const segs = spot.segments.map((g, i) => ({ ...g, i }));
  for (const g of segs) {
    const where = `${g.role}${g.team ? ' ' + g.team : ''}`;
    for (const w of BANNED) if (g.segment.includes(w)) errors.push(`${where}: banned word "${w}"`);
    let cur = 0;
    for (const p of g.subs) {
      const ix = g.segment.indexOf(p.say, cur);
      if (ix < 0) errors.push(`${where}: subtitle "${p.say}" is not in the voice text (in order)`); else cur = ix + p.say.length;
      for (const h of p.hi || []) if (!p.show.includes(h)) errors.push(`${where}: highlight "${h}" is not in "${p.show}"`);
      for (const n of nums(p.show)) if (!allowed.has(n)) errors.push(`${where}: "${n}" in "${p.show}" is not a number in facts.json`);
    }
    const need = [...(MARKS[g.role] || []), ...(g.role === 'team' && team(g.team) ? team(g.team).swings.map((_, k) => `s${k}`) : [])];
    for (const k of need) if (!g.marks || !g.marks[k] || !g.segment.includes(g.marks[k])) errors.push(`${where}: marks.${k} must be a piece of the voice text`);
    if (g.role === 'table') {
      for (const [k, name] of Object.entries(g.focus || {})) {
        const t = team(name), p = subOf(g, g.marks[k]);
        if (!t) { errors.push(`table: unknown team ${name}`); continue; }
        if (!p) continue;
        for (const n of nums(p.show)) if (n !== t.rank75) errors.push(`table: ${name} is ${t.rank75} at ${facts.cut}', not ${n}`);
        if (p.show.includes('บ๊วย') && t.rank75 !== facts.teams.length) errors.push(`table: ${name} is not last at ${facts.cut}'`);
        if (p.show.includes('ขึ้น') && !(t.rank75 < t.rank)) errors.push(`table: ${name} does not go up`);
        if (/ร่วง|ตก/.test(p.show) && !(t.rank75 > t.rank)) errors.push(`table: ${name} does not go down`);
      }
    }
    if (g.role === 'stat') {
      const all = g.subs.map((p) => p.show).join(' ');
      if (!nums(all).includes(facts.results_changed_after_cut)) errors.push(`stat: the subtitles must show ${facts.results_changed_after_cut} (results changed after ${facts.cut}')`);
    }
    if (g.role === 'team') {
      const t = team(g.team);
      if (!t) { errors.push(`team: unknown team ${g.team}`); continue; }
      if (t.swings.length > 3) errors.push(`${where}: ${t.swings.length} late swings, the card list fits 3`);
      const p = subOf(g, g.marks.total);
      if (p && !nums(p.show).includes(Math.abs(t.delta))) errors.push(`${where}: the total must say ${Math.abs(t.delta)} points`);
      if (p && /หาย|เสีย/.test(p.show) && t.delta >= 0) errors.push(`${where}: ${g.team} did not lose points late`);
      if (p && /เพิ่ม|ได้/.test(p.show) && t.delta <= 0) errors.push(`${where}: ${g.team} did not gain points late`);
      if (g.marks.without) { const w = subOf(g, g.marks.without); if (w && !nums(w.show).includes(t.pts75)) errors.push(`${where}: at ${facts.cut}' ${g.team} has ${t.pts75} points`); }
      g.data = t;
    }
    if (g.role === 'lead') {
      const t = team(g.team);
      if (!t) { errors.push(`lead: unknown team ${g.team}`); continue; }
      const all = g.subs.map((p) => p.show).join(' ');
      if (!nums(all).includes(t.ledAt)) errors.push(`lead: ${g.team} led in ${t.ledAt} matches`);
      if (all.includes('ครบ') && t.ledWon !== t.ledAt) errors.push(`lead: ${g.team} won ${t.ledWon} of ${t.ledAt}, not all`);
      if (all.includes('จ่าฝูง') && t.rank !== 1) errors.push(`lead: ${g.team} is not top`);
      g.data = t;
    }
  }
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  return { facts, spot, segs };
}

// ---------- 2. voice ----------
async function voice(segs) {
  for (const g of segs) await speak(TAGS[g.role] + g.segment, path.join(DIR, 'vo'), g.i, `insight ${g.role}`);
}

// ---------- 3. timeline (film clock: the cover, then the story) ----------
function timeline({ facts, spot, segs }) {
  let clock = COVER;
  const out = [], subs = [], scenes = [];
  for (const g of segs) {
    const j = readJson(path.join(DIR, 'vo', `s${g.i}.json`));
    const a = j.alignment, chars = a.characters, text = chars.join('');
    if (text !== j.text) throw new Error(`s${g.i}: alignment text mismatch`);
    const tagEnd = text.indexOf(']') + 1;
    let first = tagEnd; while (!chars[first].trim()) first++;
    const speechStart = a.character_start_times_seconds[first], speechEnd = a.character_end_times_seconds.at(-1);
    const trim = Math.max(0, speechStart - 0.04);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(trim), '-i', path.join(DIR, 'vo', `s${g.i}.mp3`), '-af', `atempo=${TEMPO},aresample=48000`, '-ac', '1', path.join(DIR, 'vo', `s${g.i}_fast.wav`)]);
    const t0 = clock, at = clock + LEAD[g.role];
    const toFilm = (t) => at + (t - trim) / TEMPO;
    const charAt = (piece, from = tagEnd) => { const ix = text.indexOf(piece, from); if (ix < 0) throw new Error(`s${g.i}: "${piece}" not found`); return ix; };
    const marks = {};
    for (const [k, v] of Object.entries(g.marks || {})) marks[k] = +toFilm(a.character_start_times_seconds[charAt(v)]).toFixed(3);
    let cursor = tagEnd;
    const first0 = subs.length;
    for (const p of g.subs) {
      const ix = charAt(p.say, cursor), last = ix + p.say.length - 1;
      subs.push({ seg: g.i, show: p.show, hi: p.hi || [], onscreen: !!p.onscreen, t0: +toFilm(a.character_start_times_seconds[ix]).toFixed(3), t1: +toFilm(a.character_end_times_seconds[last]).toFixed(3) });
      cursor = last + 1;
    }
    const start = toFilm(speechStart), end = toFilm(speechEnd);
    out.push({ i: g.i, role: g.role, file: `vo/s${g.i}_fast.wav`, at: +at.toFixed(3), start: +start.toFixed(3), end: +end.toFixed(3) });
    scenes.push({ i: g.i, role: g.role, team: g.team || null, up: g.data ? g.data.delta > 0 : null, t0: +t0.toFixed(3), speech: +start.toFixed(3), end: +end.toFixed(3), marks, subs: [first0, subs.length], focus: g.focus || null });
    clock = end + HOLD[g.role];
  }
  const T = +(clock + TAIL).toFixed(3);
  scenes[0].t0 = 0;
  scenes.forEach((s, k) => { s.t1 = k + 1 < scenes.length ? scenes[k + 1].t0 : T; });
  const S = (role, k = 0) => scenes.filter((s) => s.role === role)[k];
  const probe = [0, S('hook').marks.clock + 0.6, S('table').t0 + 0.5, S('table').t0 + 2.2, S('table').marks.up + 0.5, S('table').marks.down + 0.6, S('stat').marks.n + 1.3,
    ...scenes.filter((s) => s.role === 'team').flatMap((s) => [s.marks.s1 + 0.5, s.marks.total + 0.9]), S('lead').marks.won + 0.8, S('outro').marks.follow + 0.6, T - 0.4].map((t) => +Math.min(t, T - 0.05).toFixed(2));
  const TL = { slug, T, cover: COVER, fps: FPS, frames: Math.round(T * FPS), tempo: TEMPO, segs: out, subs, scenes, probe, logoAt: +(S('outro').end + 0.35).toFixed(3) };
  writeJson(path.join(OUT, 'timeline.json'), TL);
  console.log(`${slug} T ${T}s ·`, scenes.map((s) => `${s.role}${s.team ? ':' + s.team : ''} ${s.t0.toFixed(2)}`).join(' / '));
  for (const s of subs) console.log('  ', s.t0.toFixed(2), s.t1.toFixed(2), s.onscreen ? '(on screen)' : '', s.show);
  return TL;
}

// ---------- 4. sound ----------
function sound(TL) {
  const T = TL.T + 0.8;
  const K = kit(T);
  const { mus, sfx, add, kick, noiseHit, snare, bassNote, chord, riser, whoosh, boom, crowd, bell, groove, audioLogo, fadeTail } = K;
  const S = (role) => TL.scenes.filter((s) => s.role === role);
  const [hook] = S('hook'), [table] = S('table'), [stat] = S('stat'), [lead] = S('lead'), [outro] = S('outro');
  const SR = 48000;
  const tick = (t0, g = 1) => add(sfx, t0, (t) => Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 140), 0.05, g * 0.25);
  const flap = (t0, g = 1) => { noiseHit(sfx, t0, 0.05, 90, 9000, 2500, g * 0.5, 0.2); noiseHit(sfx, t0 + 0.028, 0.04, 110, 7000, 2000, g * 0.35, -0.2); };
  // a referee's whistle: a pea-whistle trill around 2.9 kHz
  const whistle = (t0, dur, g = 1) => { let ph = 0; add(sfx, t0, (t) => { ph += 2 * Math.PI * (2900 + 120 * Math.sin(2 * Math.PI * 32 * t)) / SR; const e = Math.min(1, t / 0.02) * Math.min(1, Math.max(0, (dur - t) / 0.06)); return (Math.sin(ph) * 0.6 + Math.sin(2 * ph) * 0.12) * e; }, dur, g * 0.32); };
  // cover: a low pad and one bell, a whoosh into the story
  chord(mus, 0, TL.cover + 0.1, [57, 60, 64, 69], 0.45, 800); bassNote(mus, 0, TL.cover, 33, 0.25); bell(sfx, 0.02, 81, 0.35, 0); whoosh(sfx, TL.cover - 0.3, 0.5, 0.35, 0);
  // hook: the clock runs (ticks speed up with a riser), the whistle stops it at 75'
  const C0 = TL.cover + 0.1, CK = hook.marks.clock;
  for (let t = C0, k = 0; t < CK - 0.04; k++) { tick(t, 0.6 + 0.4 * (t - C0) / (CK - C0)); t += 0.16 / (1 + 2.5 * (t - C0) / (CK - C0)); }
  riser(sfx, C0, CK - C0, 0.3);
  chord(mus, C0, CK - C0, [57, 60, 64, 69], 0.5, 700); bassNote(mus, C0, CK - C0, 33, 0.3);
  whistle(CK, 0.9, 1); boom(sfx, CK, 0.6); noiseHit(sfx, CK, 1.6, 2.2, 12000, 3000, 0.22);
  crowd(sfx, CK - 0.05, 2.0, 0.12, (t) => Math.min(1, t / 0.2) * Math.exp(-Math.max(0, t - 0.4) * 1.5));
  whoosh(sfx, hook.marks.turn - 0.1, 0.55, 0.35, 0);
  // the beat runs from the table to the brand
  groove(table.t0 + 0.2, TL.logoAt, 0.7);
  // table: rows slide in, the reshuffle flaps, a hit on each named club
  whoosh(sfx, table.t0, 0.5, 0.35, -0.4);
  const SW = table.t0 + 0.75;
  riser(sfx, SW - 0.6, 0.6, 0.25);
  for (let k = 0; k < 18; k++) flap(SW + k * 0.055, 0.5 + 0.02 * k);
  boom(sfx, SW + 1.05, 0.45);
  for (const k of ['up', 'mid', 'down']) { kick(sfx, table.marks[k], 0.45); noiseHit(sfx, table.marks[k], 0.6, 4, 12000, 4000, 0.14); }
  bell(sfx, table.marks.up + 0.05, 88, 0.6, 0); bassNote(mus, table.marks.down + 0.05, 0.5, 28, 0.45);
  // stat: the dots count up, then a hit
  whoosh(sfx, stat.t0, 0.5, 0.35, 0);
  for (let n = 0; n < 22; n++) tick(stat.marks.n + n * 0.045, 0.7 + n * 0.015);
  boom(sfx, stat.marks.n + 1.05, 0.45);
  // a club's late swings: a whoosh per match, then the total (bells for points won, a low thud for points lost)
  for (const s of S('team')) {
    whoosh(sfx, s.t0, 0.55, 0.4, 0); kick(sfx, s.t0 + 0.3, 0.35);
    for (const [k, v] of Object.entries(s.marks)) if (/^s\d+$/.test(k)) { whoosh(sfx, v - 0.15, 0.4, 0.28, Number(k.slice(1)) % 2 ? 0.4 : -0.4); kick(sfx, v + 0.1, 0.35); }
    const R = s.marks.total;
    snare(sfx, R - 0.3, 0.15); snare(sfx, R - 0.18, 0.2); snare(sfx, R - 0.08, 0.25);
    boom(sfx, R + 0.1, 0.55);
    if (s.up) { bell(sfx, R + 0.1, 76, 0.8, -0.2); bell(sfx, R + 0.19, 81, 0.8, 0.2); bell(sfx, R + 0.28, 88, 0.9, 0); crowd(sfx, R, 2.2, 0.2, (t) => Math.min(1, t / 0.15) * Math.exp(-Math.max(0, t - 0.5) * 1.3)); }
    else { bassNote(mus, R + 0.1, 0.6, 28, 0.55); bassNote(mus, R + 0.12, 0.55, 40, 0.25); crowd(sfx, R + 0.1, 1.6, 0.08, (t) => Math.min(1, t / 0.3) * Math.exp(-t * 1.6)); }
    if (s.marks.without) kick(sfx, s.marks.without, 0.4);
  }
  // lead: the slots fill, then they all turn into wins
  whoosh(sfx, lead.t0, 0.5, 0.35, 0);
  for (let k = 0; k < 9; k++) tick(lead.marks.led + 0.2 + k * 0.07, 0.8);
  for (let k = 0; k < 9; k++) bell(sfx, lead.marks.won + k * 0.06, 76 + (k % 3) * 5, 0.35, (k % 3 - 1) * 0.4);
  crowd(sfx, lead.marks.won, 2.4, 0.2, (t) => Math.min(1, t / 0.2) * Math.exp(-Math.max(0, t - 0.6) * 1.2));
  // outro: the question, the follow button, then the audio logo on the brand
  whoosh(sfx, outro.t0, 0.55, 0.35, 0);
  kick(sfx, outro.marks.comment, 0.35); kick(sfx, outro.marks.follow, 0.4);
  chord(mus, outro.marks.follow, TL.logoAt - outro.marks.follow, [57, 60, 64, 69], 0.5, 800);
  riser(sfx, outro.marks.follow, TL.logoAt - outro.marks.follow, 0.25);
  audioLogo(TL.logoAt, T);
  fadeTail();
  return { mus, sfx };
}

// ---------- 5. HyperFrames scenes ----------
const local = (sc) => (t) => r3(t - sc.t0);
const logoPlate = (id, src, size, pos = '', ring = '#f6b72a') => `<div class="lp" id="${id}" style="${pos}width:${size}px;height:${size}px;box-shadow:0 0 0 ${Math.round(size / 28)}px ${ring},0 0 0 ${Math.round(size / 16)}px #3a2203,0 ${Math.round(size / 14)}px ${Math.round(size / 5)}px rgba(0,0,0,.55)"><img src="${src}" alt=""></div>`;
/** A rolling number: a column of values; tween its y from row a to row b. */
function strip(id, values, H, cls = '') {
  return `<div class="strip ${cls}" style="height:${H}px"><div id="${id}">${values.map((v) => `<div style="height:${H}px;line-height:${H}px">${v}</div>`).join('')}</div></div>`;
}
const KIT_CSS = `
.lp{position:absolute;border-radius:50%;background:radial-gradient(circle at 38% 30%,#fff 0%,#eef3fb 45%,#cfd9ea 100%);display:flex;align-items:center;justify-content:center;overflow:hidden}
.lp img{width:66%;height:66%;object-fit:contain}
.strip{overflow:hidden;position:relative}
.strip>div{will-change:transform}
.up{color:#4ade80}.dn{color:#f87171}
.chip{display:inline-flex;align-items:center;gap:14px;padding:12px 30px 16px;border-radius:999px;background:rgba(10,26,70,.9);box-shadow:inset 0 0 0 3px rgba(251,191,36,.55);font-weight:700;font-size:40px;white-space:nowrap}
.foot{position:absolute;left:0;width:1080px;text-align:center;font-weight:600;font-size:30px;color:rgba(220,230,255,.7)}
.beam.g{background:linear-gradient(180deg,rgba(255,196,80,.26),rgba(255,160,40,.05) 55%,rgba(0,0,0,0) 80%)}`;

function buildHook(TL, sc, facts, spot) {
  const p = 'hook', L = local(sc), T = sc.t1 - sc.t0, C = TL.cover;
  const B = TLB();
  const amb = ambient(p, T, 11); amb.tl.forEach((a) => B.ft(...a));
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const sp = sparks(p, 's', 34, 21);
  const bou = facts.teams.find((t) => t.name === spot.segments[1].focus.up), ips = facts.teams.find((t) => t.name === spot.segments[1].focus.down);
  const R = 290, CIRC = 2 * Math.PI * R, CUT = facts.cut;
  const CK = L(sc.marks.clock), TURN = L(sc.marks.turn);
  // cover (complete from frame 0), then it lifts away
  B.ft(`#${p}-cover`, { opacity: 1, scale: 1 }, { opacity: 0, scale: 1.12, duration: 0.28, ease: E.in }, C - 0.22);
  B.set(`#${p}-cover`, { visibility: 'hidden' }, C + 0.08);
  // the clock
  B.ft(`#${p}-lg`, { y: -80, opacity: 0, scale: 0.5 }, { y: 0, opacity: 1, scale: 0.5, duration: 0.45, ease: E.pop }, C);
  B.ft(`#${p}-watch`, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: E.pop }, C);
  B.ft(`#${p}-arc`, { strokeDashoffset: CIRC }, { strokeDashoffset: CIRC * (1 - CUT / 90), duration: CK - C - 0.1, ease: 'power2.inOut' }, C + 0.1);
  B.ft(`#${p}-num`, { y: 0 }, { y: -CUT * 260, duration: CK - C - 0.1, ease: 'power2.inOut' }, C + 0.1);
  B.ft(`#${p}-hand`, { rotation: 0 }, { rotation: 360 * CUT / 90, duration: CK - C - 0.1, ease: 'power2.inOut' }, C + 0.1);
  // 75': the whistle stops the clock
  B.ft(`#${p}-arc`, { stroke: '#5b8cff' }, { stroke: '#fbbf24', duration: 0.15 }, CK);
  B.ft(`#${p}-watch`, { scale: 1 }, { scale: 1.08, duration: 0.12, ease: E.out }, CK);
  B.ft(`#${p}-watch`, { scale: 1.08 }, { scale: 1, duration: 0.5, ease: E.spring }, CK + 0.12);
  B.ft(`#${p}-flash`, { opacity: 0.7 }, { opacity: 0, duration: 0.5, ease: E.out }, CK);
  sp.burst(B, CK, 540, 830);
  B.ft(`#${p}-stop`, { scale: 0.4, opacity: 0, rotation: -8 }, { scale: 1, opacity: 1, rotation: -4, duration: 0.45, ease: 'back.out(2.2)' }, CK + 0.12);
  B.ft(`#${p}-what`, { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, TURN - 0.1);
  // into the table
  B.ft(`#${p}-stage`, { scale: 1, opacity: 1 }, { scale: 1.6, opacity: 0, duration: 0.4, ease: E.in }, T - 0.4);
  const nums = Array.from({ length: CUT + 1 }, (_, k) => `${k}<small>'</small>`);
  const css = `${KIT_CSS}
#hook-cover{position:absolute;inset:0;z-index:20;transform-origin:540px 900px;background:radial-gradient(110% 60% at 50% 46%,#123378 0%,#0a1c4a 42%,#050c22 75%,#02050f 100%)}
.cv-logo{position:absolute;left:150px;top:120px;width:780px;height:230px;border-radius:44px;background:linear-gradient(180deg,#fff,#eef3fb);box-shadow:0 0 0 6px rgba(251,191,36,.95),0 0 0 12px #3a2203,0 30px 80px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}
.cv-logo img{width:700px}
.cv-series{position:absolute;left:0;top:420px;width:1080px;text-align:center}
.cv-t{position:absolute;left:0;width:1080px;text-align:center;font-weight:700;line-height:1.05;white-space:nowrap}
.cv-move{position:absolute;left:110px;width:860px;height:190px;border-radius:40px;background:linear-gradient(180deg,rgba(16,36,86,.92),rgba(5,12,34,.96));box-shadow:inset 0 0 0 3px rgba(251,191,36,.55),0 24px 60px rgba(0,0,0,.55)}
.cv-move .nm{position:absolute;left:220px;top:28px;font-weight:700;font-size:44px}
.cv-move .rk{position:absolute;left:220px;top:88px;font-family:Barlow;font-weight:900;font-size:76px;line-height:1;white-space:nowrap}
.cv-move .rk span{font-family:Plex;font-weight:700;font-size:34px;color:rgba(220,230,255,.75);margin-right:14px}
.watch{position:absolute;left:540px;top:830px;width:0;height:0}
.watch svg{position:absolute;left:-340px;top:-340px}
.wnum{position:absolute;left:-300px;top:-130px;width:600px;text-align:center;font-family:Barlow;font-weight:900;font-size:230px;color:#fff;text-shadow:0 8px 0 #04102e,0 18px 40px rgba(0,0,0,.6)}
.wnum small{font-size:150px;color:#fbbf24}
.stop{position:absolute;left:0;top:1185px;width:1080px;text-align:center}
.what{position:absolute;left:0;top:1310px;width:1080px;text-align:center;font-weight:700;font-size:54px;text-shadow:0 4px 0 #04102e,0 10px 30px rgba(0,0,0,.7)}`;
  const move = (t, top, dir) => `<div class="cv-move" style="top:${top}px">${logoPlate(`${p}-cv${t.id}`, t.logo, 136, 'left:40px;top:27px;')}
    <div class="nm">${esc(t.name)}</div><div class="rk"><span>อันดับ</span>${t.rank} <span style="color:#fbbf24;margin:0 10px">→</span><b class="${dir}">${t.rank75}</b> <span class="${dir}" style="font-size:44px">${dir === 'up' ? '▲' : '▼'}</span></div></div>`;
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  <div class="plate league" style="left:540px;top:250px" id="${p}-lg"><div class="face"><img src="${facts.league.logo}" alt=""></div></div>
  <div class="watch" id="${p}-watch">
    <svg width="680" height="680" viewBox="-340 -340 680 680">
      <circle r="${R}" fill="rgba(6,16,44,.85)" stroke="rgba(120,160,255,.18)" stroke-width="34"/>
      ${Array.from({ length: 18 }, (_, k) => { const a = (k / 18) * Math.PI * 2; return `<line x1="${(Math.sin(a) * (R - 40)).toFixed(1)}" y1="${(-Math.cos(a) * (R - 40)).toFixed(1)}" x2="${(Math.sin(a) * (R - 62)).toFixed(1)}" y2="${(-Math.cos(a) * (R - 62)).toFixed(1)}" stroke="rgba(220,230,255,.45)" stroke-width="${k % 3 ? 4 : 8}" stroke-linecap="round"/>`; }).join('')}
      <circle id="${p}-arc" r="${R}" fill="none" stroke="#5b8cff" stroke-width="34" stroke-linecap="round" stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${CIRC.toFixed(1)}" transform="rotate(-90)"/>
      <g id="${p}-hand"><line x1="0" y1="0" x2="0" y2="${-(R - 70)}" stroke="#fbbf24" stroke-width="10" stroke-linecap="round"/></g>
      <circle r="16" fill="#fbbf24"/>
    </svg>
    <div class="wnum">${strip(`${p}-num`, nums, 260)}</div>
  </div>
  <div class="stop" id="${p}-stop"><span class="pill">สมมติว่าจบเกมตรงนี้</span></div>
  <div class="what" id="${p}-what">ตารางคะแนนจะเปลี่ยนไปแค่ไหน?</div>
  ${sp.html}
</div>
<div class="flash" id="${p}-flash"></div><div class="vig"></div>
<div id="hook-cover">
  <div class="cv-logo"><img src="${BRAND('logo-lockup.webp')}" alt=""></div>
  <div class="cv-series"><span class="pill" style="font-size:56px">${esc(spot.series)}</span></div>
  <div class="cv-t" style="top:560px;font-size:118px">${esc(spot.title[0])}</div>
  <div class="cv-t gold" style="top:700px;font-size:150px">${esc(spot.title[1])}</div>
  ${move(bou, 940, 'up')}${move(ips, 1160, 'dn')}
  <div class="foot" style="top:1400px;font-size:36px">${esc(facts.league.name)} · ${facts.rounds} นัดแรก</div>
</div>`;
  return scene(p, css, body, B.js());
}

function buildTable(TL, sc, facts) {
  const p = 'tb', L = local(sc), T = sc.t1 - sc.t0;
  const B = TLB();
  const amb = ambient(p, T, 23); amb.tl.forEach((a) => B.ft(...a));
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const Y0 = 330, RH = 51, SW = 0.75;
  const rows = facts.teams;
  const focus = sc.focus, focusIds = Object.fromEntries(Object.entries(focus).map(([k, n]) => [k, rows.find((t) => t.name === n).id]));
  let html = '';
  rows.forEach((t, k) => {
    const d = t.rank - t.rank75;
    const badge = d > 0 ? `<b class="up">▲${d}</b>` : d < 0 ? `<b class="dn">▼${-d}</b>` : `<b style="color:rgba(220,230,255,.45)">–</b>`;
    html += `<div class="row" id="${p}-r${t.id}" style="top:${Y0}px">
      <div class="pos"><span id="${p}-pa${t.id}">${t.rank}</span><span id="${p}-pb${t.id}" class="b">${t.rank75}</span></div>
      <img src="${t.logo}" alt=""><div class="nm">${esc(t.name)}</div>
      <div class="dl" id="${p}-d${t.id}">${badge}</div>
      <div class="pt"><span id="${p}-xa${t.id}">${t.pts}</span><span id="${p}-xb${t.id}" class="b">${t.pts75}</span></div></div>`;
    const y0 = (t.rank - 1) * RH, y1 = (t.rank75 - 1) * RH;
    B.ft(`#${p}-r${t.id}`, { x: 1100, y: y0 }, { x: 0, y: y0, duration: 0.45, ease: E.out }, 0.05 + k * 0.012);
    B.ft(`#${p}-r${t.id}`, { y: y0 }, { y: y1, duration: 1.0, ease: 'power3.inOut' }, SW + Math.abs(t.rank - t.rank75) * 0.01);
    B.ft(`#${p}-pa${t.id}`, { opacity: 1 }, { opacity: 0, duration: 0.2 }, SW + 0.4);
    B.ft(`#${p}-pb${t.id}`, { opacity: 0 }, { opacity: 1, duration: 0.2 }, SW + 0.4);
    B.ft(`#${p}-xa${t.id}`, { opacity: 1, y: 0 }, { opacity: 0, y: -20, duration: 0.2 }, SW + 0.4);
    B.ft(`#${p}-xb${t.id}`, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.2 }, SW + 0.4);
    B.ft(`#${p}-d${t.id}`, { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.3, ease: 'back.out(2.4)' }, SW + 1.0 + k * 0.01);
  });
  B.ft(`#${p}-h`, { y: -60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, 0);
  B.ft(`#${p}-la`, { opacity: 1 }, { opacity: 0, duration: 0.2 }, SW);
  B.ft(`#${p}-lb`, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(2.2)' }, SW + 0.05);
  B.ft(`#${p}-flash`, { opacity: 0.35 }, { opacity: 0, duration: 0.4, ease: E.out }, SW + 1.0);
  // the named clubs, one by one: the others dim
  const order = ['up', 'mid', 'down'];
  order.forEach((k, j) => {
    const at = L(sc.marks[k]) - 0.05, id = focusIds[k];
    if (j === 0) rows.forEach((t) => { if (!Object.values(focusIds).includes(t.id)) B.ft(`#${p}-r${t.id}`, { opacity: 1 }, { opacity: 0.32, duration: 0.3 }, at); });
    if (j > 0) { const prev = focusIds[order[j - 1]]; B.ft(`#${p}-r${prev}`, { opacity: 1, scale: 1.06 }, { opacity: 0.32, scale: 1, duration: 0.25 }, at); }
    B.ft(`#${p}-r${id}`, { opacity: 1, scale: 1 }, { opacity: 1, scale: 1.06, duration: 0.3, ease: E.pop }, at);
    B.set(`#${p}-r${id}`, { zIndex: 5 }, at);
    B.ft(`#${p}-r${id}`, { boxShadow: '0 0 0 0px rgba(251,191,36,0)' }, { boxShadow: '0 0 0 5px rgba(251,191,36,1)', duration: 0.25 }, at);
    if (j < order.length - 1) B.set(`#${p}-r${id}`, { boxShadow: '0 0 0 0px rgba(251,191,36,0)' }, L(sc.marks[order[j + 1]]) - 0.06);
    // the first two keep their glow until the next one lights up; others not named stay dim
    if (j === 0) for (const kk of order.slice(1)) B.ft(`#${p}-r${focusIds[kk]}`, { opacity: 1 }, { opacity: 0.32, duration: 0.3 }, at);
  });
  B.ft(`#${p}-stage`, { opacity: 1, scale: 1 }, { opacity: 0, scale: 0.92, duration: 0.3, ease: E.in }, T - 0.3);
  const css = `${KIT_CSS}
.th{position:absolute;left:0;top:120px;width:1080px;text-align:center}
.th .t1{font-weight:700;font-size:62px;text-shadow:0 5px 0 #04102e}
.th .t2{position:relative;height:90px;margin-top:6px}
.th .t2>div{position:absolute;left:0;width:1080px;text-align:center}
.row{position:absolute;left:70px;width:940px;height:${RH - 6}px;border-radius:14px;background:linear-gradient(90deg,rgba(18,40,96,.95),rgba(8,20,54,.95));box-shadow:inset 0 0 0 2px rgba(120,160,255,.18);display:flex;align-items:center;font-weight:700;font-size:31px;transform-origin:50% 50%}
.row .pos{position:relative;width:70px;height:100%;font-family:Barlow;font-weight:900;font-size:36px;color:#fbbf24}
.row .pos span,.row .pt span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.row .b{opacity:0}
.row img{width:36px;height:36px;object-fit:contain;margin:0 18px 0 6px}
.row .nm{flex:1;white-space:nowrap}
.row .dl{width:110px;text-align:center;font-family:Barlow;font-size:36px}
.row .pt{position:relative;width:90px;height:100%;font-family:Barlow;font-weight:900;font-size:40px}`;
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  <div class="th" id="${p}-h"><div class="t1">ตาราง ${esc(facts.league.name)}</div>
    <div class="t2"><div id="${p}-la"><span class="chip">ผลจริง ${facts.rounds} นัดแรก</span></div><div id="${p}-lb"><span class="pill" style="font-size:52px">ถ้าจบเกมที่นาที ${facts.cut}</span></div></div></div>
  ${html}
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>`;
  return scene(p, css, body, B.js());
}

function buildStat(TL, sc, facts) {
  const p = 'st', L = local(sc), T = sc.t1 - sc.t0;
  const B = TLB();
  const amb = ambient(p, T, 31); amb.tl.forEach((a) => B.ft(...a));
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const N = facts.matches.finished, K = facts.results_changed_after_cut, NT = L(sc.marks.n);
  const rnd = mulberry(7);
  const lit = new Set(); while (lit.size < K) lit.add(Math.floor(rnd() * N));
  const litOrder = [...lit];
  const cols = 10, D = 56, G = 14, W = cols * D + (cols - 1) * G, X0 = (1080 - W) / 2, Y0 = 590;
  let dots = '';
  for (let k = 0; k < N; k++) dots += `<div class="dot" id="${p}-o${k}" style="left:${X0 + (k % cols) * (D + G)}px;top:${Y0 + Math.floor(k / cols) * (D + G)}px"></div>`;
  for (let k = 0; k < N; k++) B.ft(`#${p}-o${k}`, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.25, ease: E.pop }, 0.1 + k * 0.006);
  litOrder.forEach((k, j) => {
    B.ft(`#${p}-o${k}`, { backgroundColor: '#1b2f66', boxShadow: '0 0 0 0 rgba(251,191,36,0)' }, { backgroundColor: '#fbbf24', boxShadow: '0 0 24px 4px rgba(251,191,36,.75)', duration: 0.12 }, NT + j * 0.045);
    B.ft(`#${p}-o${k}`, { scale: 1.35 }, { scale: 1, duration: 0.3, ease: E.out }, NT + j * 0.045);
  });
  B.ft(`#${p}-num`, { y: 0 }, { y: -K * 240, duration: K * 0.045, ease: 'none' }, NT);
  B.ft(`#${p}-big`, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: E.pop }, NT - 0.2);
  B.ft(`#${p}-big`, { scale: 1 }, { scale: 1.12, duration: 0.12, ease: E.out }, NT + K * 0.045);
  B.ft(`#${p}-big`, { scale: 1.12 }, { scale: 1, duration: 0.45, ease: E.spring }, NT + K * 0.045 + 0.12);
  B.ft(`#${p}-top`, { y: -50, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, 0.05);
  B.ft(`#${p}-goals`, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, NT + K * 0.045 + 0.4);
  B.ft(`#${p}-stage`, { opacity: 1, x: 0 }, { opacity: 0, x: -200, duration: 0.3, ease: E.in }, T - 0.3);
  const css = `${KIT_CSS}
.top{position:absolute;left:0;top:150px;width:1080px;text-align:center}
.big{position:absolute;left:0;top:250px;width:1080px;display:flex;justify-content:center;align-items:flex-end;gap:24px}
.big .n{font-family:Barlow;font-weight:900;font-size:220px;color:#fbbf24;text-shadow:0 10px 0 #6b3303,0 24px 50px rgba(0,0,0,.6)}
.big .of{font-weight:700;font-size:64px;padding-bottom:44px;white-space:nowrap}
.dot{position:absolute;width:${D}px;height:${D}px;border-radius:50%;background:#1b2f66;box-shadow:inset 0 0 0 3px rgba(120,160,255,.25)}
`;
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  <div class="top" id="${p}-top"><span class="chip">${esc(facts.league.name)} · ${facts.rounds} นัดแรก</span></div>
  <div class="big" id="${p}-big"><div class="n">${strip(`${p}-num`, Array.from({ length: K + 1 }, (_, k) => k), 240)}</div><div class="of">จาก ${N} เกม<br><span style="color:#fbbf24">ผลเปลี่ยนหลังนาที ${facts.cut}</span></div></div>
  ${dots}
  <div class="foot" id="${p}-goals" style="top:1300px"><span class="chip" style="font-size:38px">${facts.goals.late} จาก ${facts.goals.total} ประตู มาหลังนาที ${facts.cut}</span></div>
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>`;
  return scene(p, css, body, B.js());
}

function buildTeam(TL, sc, facts, g, n) {
  const p = `tm${n}`, L = local(sc), T = sc.t1 - sc.t0;
  const t = g.data;
  const B = TLB();
  const amb = ambient(p, T, 41 + n); amb.tl.forEach((a) => B.ft(...a));
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const sp = sparks(p, 's', 30, 51 + n);
  const up = t.delta > 0;
  const logoOf = (id) => facts.teams.find((x) => x.id === id).logo;
  let cards = '';
  t.swings.forEach((s, k) => {
    const top = 560 + k * 236, at = L(sc.marks[`s${k}`]);
    const goals = s.late_goals.map((x) => `<span class="gl ${x.for ? 'f' : 'a'}">${x.minute}'</span>`).join('');
    cards += `<div class="card" id="${p}-c${k}" style="top:${top}px">
      ${logoPlate(`${p}-cl${k}`, logoOf(s.opponent_id), 120, 'left:34px;top:30px;')}
      <div class="op">${s.venue === 'home' ? 'เหย้า' : 'เยือน'} · ${esc(s.opponent)}</div>
      <div class="sc"><span class="lb">นาที ${facts.cut}</span>${s.at75}<span class="ar">→</span><span class="lb">จบ</span><b class="${s.points > 0 ? 'up' : 'dn'}">${s.final}</b></div>
      <div class="gls">${goals}</div>
      <div class="pts ${s.points > 0 ? 'pu' : 'pd'}" id="${p}-cp${k}">${s.points > 0 ? '+' : '−'}${Math.abs(s.points)}</div></div>`;
    B.ft(`#${p}-c${k}`, { x: 1100, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: E.out }, at - 0.15);
    B.ft(`#${p}-cp${k}`, { scale: 0.3, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: 'back.out(2.6)' }, at + 0.45);
  });
  const TOT = L(sc.marks.total);
  B.ft(`#${p}-hd`, { y: -80, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: E.pop }, 0.05);
  B.ft(`#${p}-rk`, { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: 0.4, ease: E.pop }, L(sc.marks.head));
  B.ft(`#${p}-tot`, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.2)' }, TOT + 0.05);
  B.ft(`#${p}-tn`, { y: 0 }, { y: -Math.abs(t.delta) * 170, duration: 0.5, ease: 'power2.out' }, TOT + 0.1);
  B.ft(`#${p}-flash`, { opacity: 0.45 }, { opacity: 0, duration: 0.5, ease: E.out }, TOT + 0.6);
  if (up) sp.burst(B, TOT + 0.6, 540, 1300);
  if (sc.marks.without) {
    B.ft(`#${p}-rk`, { scale: 1 }, { scale: 1.1, duration: 0.15, ease: E.out }, L(sc.marks.without));
    B.ft(`#${p}-rk`, { scale: 1.1 }, { scale: 1, duration: 0.4, ease: E.spring }, L(sc.marks.without) + 0.15);
  }
  B.ft(`#${p}-stage`, { opacity: 1, x: 0 }, { opacity: 0, x: -220, duration: 0.3, ease: E.in }, T - 0.3);
  const css = `${KIT_CSS}
.hd{position:absolute;left:70px;top:150px;width:940px;height:330px}
.hd .nm{position:absolute;left:290px;top:30px;font-weight:700;font-size:72px;white-space:nowrap;text-shadow:0 5px 0 #04102e}
.rk{position:absolute;left:290px;top:140px;display:flex;flex-direction:column;gap:14px;transform-origin:0 50%}
.rk .chip{font-size:36px}
.rk b{font-family:Barlow;font-weight:900;font-size:50px;line-height:.9}
.card{position:absolute;left:60px;width:960px;height:212px;border-radius:30px;background:linear-gradient(180deg,rgba(16,36,86,.95),rgba(5,12,34,.97));box-shadow:inset 0 0 0 3px rgba(120,160,255,.25),0 20px 50px rgba(0,0,0,.5)}
.card .op{position:absolute;left:190px;top:22px;font-weight:600;font-size:32px;color:rgba(220,230,255,.8);white-space:nowrap}
.card .sc{position:absolute;left:190px;top:66px;font-family:Barlow;font-weight:900;font-size:76px;line-height:1;white-space:nowrap;display:flex;align-items:baseline;gap:12px}
.card .sc .lb{font-family:Plex;font-weight:700;font-size:28px;color:#fbbf24}
.card .sc .ar{color:rgba(220,230,255,.6);font-size:56px;margin:0 6px}
.card .gls{position:absolute;left:190px;top:154px;display:flex;gap:12px}
.gl{padding:2px 16px 4px;border-radius:12px;font-family:Barlow;font-weight:800;font-size:34px}
.gl.a{background:rgba(248,113,113,.18);color:#fca5a5;box-shadow:inset 0 0 0 2px rgba(248,113,113,.6)}
.gl.f{background:rgba(74,222,128,.16);color:#86efac;box-shadow:inset 0 0 0 2px rgba(74,222,128,.6)}
.pts{position:absolute;right:34px;top:46px;width:120px;height:120px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:Barlow;font-weight:900;font-size:66px}
.pts.pd{background:radial-gradient(circle at 40% 35%,#f87171,#b91c1c);box-shadow:0 0 30px rgba(248,113,113,.6)}
.pts.pu{background:radial-gradient(circle at 40% 35%,#4ade80,#15803d);box-shadow:0 0 30px rgba(74,222,128,.6)}
.tot{position:absolute;left:0;top:1262px;width:1080px;display:flex;justify-content:center;align-items:center;gap:26px}
.tot .lb{font-weight:700;font-size:52px;white-space:nowrap}
.tot .n{font-family:Barlow;font-weight:900;font-size:150px;line-height:1}`;
  const totVals = Array.from({ length: Math.abs(t.delta) + 1 }, (_, k) => (k === 0 ? '0' : (up ? '+' : '−') + k));
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  <div class="hd" id="${p}-hd">${logoPlate(`${p}-lg`, t.logo, 250, 'left:0;top:20px;')}
    <div class="nm">${esc(t.name)}</div>
    <div class="rk" id="${p}-rk"><span class="chip">อันดับจริง <b>${t.rank}</b> · ${t.pts} แต้ม</span><span class="chip" style="box-shadow:inset 0 0 0 3px ${up ? '#f87171' : '#4ade80'}">ถ้าจบนาที ${facts.cut} <b class="${up ? 'dn' : 'up'}">${t.rank75}</b> · ${t.pts75} แต้ม</span></div></div>
  ${cards}
  <div class="tot" id="${p}-tot"><div class="lb">${up ? 'แต้มที่ได้เพิ่มหลังนาที ' : 'แต้มที่หายไปหลังนาที '}${facts.cut}</div><div class="n ${up ? 'up' : 'dn'}">${strip(`${p}-tn`, totVals, 170)}</div></div>
  ${sp.html}
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>`;
  return scene(p, css, body, B.js());
}

function buildLead(TL, sc, facts, g) {
  const p = 'ld', L = local(sc), T = sc.t1 - sc.t0, t = g.data;
  const B = TLB();
  const amb = ambient(p, T, 61); amb.tl.forEach((a) => B.ft(...a));
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const sp = sparks(p, 's', 36, 71);
  const LED = L(sc.marks.led), WON = L(sc.marks.won), n = t.ledAt;
  const D = 96, G = 12, W = n * D + (n - 1) * G, X0 = (1080 - W) / 2;
  let slots = '';
  for (let k = 0; k < n; k++) {
    slots += `<div class="sl" style="left:${X0 + k * (D + G)}px"><div class="a" id="${p}-a${k}">นำ</div><div class="w" id="${p}-w${k}"><svg viewBox="0 0 40 40" width="50" height="50"><path d="M9 21 L17 29 L32 12" fill="none" stroke="#052e12" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg></div></div>`;
    B.ft(`#${p}-a${k}`, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: E.pop }, LED + 0.2 + k * 0.07);
    if (k < t.ledWon) B.ft(`#${p}-w${k}`, { rotationY: 90, opacity: 0 }, { rotationY: 0, opacity: 1, duration: 0.3, ease: E.out }, WON + k * 0.06);
  }
  B.ft(`#${p}-lg`, { scale: 0.5, opacity: 0, y: -60 }, { scale: 1, opacity: 1, y: 0, duration: 0.55, ease: E.pop }, 0.05);
  B.ft(`#${p}-nm`, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, 0.25);
  B.ft(`#${p}-big`, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(2.2)' }, WON + n * 0.06);
  B.ft(`#${p}-flash`, { opacity: 0.5 }, { opacity: 0, duration: 0.5, ease: E.out }, WON + n * 0.06);
  sp.burst(B, WON + n * 0.06, 540, 1150);
  B.ft(`#${p}-stage`, { opacity: 1, scale: 1 }, { opacity: 0, scale: 0.9, duration: 0.3, ease: E.in }, T - 0.3);
  const css = `${KIT_CSS}
.nm{position:absolute;left:0;top:640px;width:1080px;text-align:center;font-weight:700;font-size:70px;text-shadow:0 5px 0 #04102e}
.nm .chip{font-size:36px;margin-top:16px}
.sl{position:absolute;top:880px;width:${D}px;height:${D}px;border-radius:50%;background:#1b2f66;box-shadow:inset 0 0 0 3px rgba(120,160,255,.3)}
.sl>div{position:absolute;inset:0;border-radius:50%;display:flex;align-items:center;justify-content:center}
.sl .a{background:linear-gradient(180deg,#ffd166,#f59e0b);color:#1a0d00;font-weight:700;font-size:34px}
.sl .w{background:radial-gradient(circle at 40% 35%,#4ade80,#16a34a);box-shadow:0 0 24px rgba(74,222,128,.6)}
.big{position:absolute;left:0;top:1030px;width:1080px;text-align:center;font-family:Barlow;font-weight:900;font-size:200px;line-height:1}
.big span{font-family:Plex;font-weight:700;font-size:52px;display:block;margin-top:10px;color:#fff;text-shadow:0 4px 0 #04102e}`;
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  ${logoPlate(`${p}-lg`, t.logo, 300, 'left:390px;top:250px;')}
  <div class="nm" id="${p}-nm">${esc(t.name)}<br><span class="chip">อันดับ ${t.rank} · ${t.pts} แต้ม</span></div>
  ${slots}
  <div class="big up" id="${p}-big">${t.ledWon}/${t.ledAt}<span>ชนะทุกนัดที่ได้ขึ้นนำ</span></div>
  ${sp.html}
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>`;
  return scene(p, css, body, B.js());
}

function buildOutro(TL, sc, facts) {
  const p = 'ou', L = local(sc), T = sc.t1 - sc.t0;
  const B = TLB();
  const amb = ambient(p, T, 77); amb.tl.forEach((a) => B.ft(...a));
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const sp = sparks(p, 's', 40, 333);
  const ASK = L(sc.marks.ask), COM = L(sc.marks.comment), FOL = L(sc.marks.follow), LOGO = L(TL.logoAt);
  B.ft(`#${p}-q`, { y: 80, scale: 0.8, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.5, ease: E.pop }, ASK - 0.05);
  B.ft(`#${p}-cm`, { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: E.pop }, COM - 0.05);
  B.ft(`#${p}-fo`, { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: E.pop }, FOL - 0.05);
  B.ft(`#${p}-fob`, { scale: 1 }, { scale: 1.08, duration: 0.22, ease: 'sine.inOut', repeat: 3, yoyo: true }, FOL + 0.35);
  B.ft(`#${p}-url`, { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(2.2)' }, FOL + 0.4);
  // the brand alone
  B.ft(`#${p}-cta`, { opacity: 1, scale: 1 }, { opacity: 0, scale: 0.9, duration: 0.3, ease: E.in }, LOGO - 0.3);
  B.ft(`#${p}-rays`, { opacity: 0, scale: 0.8, rotation: 0 }, { opacity: 0.9, scale: 1, rotation: (T - LOGO) * 14, duration: T - LOGO, ease: 'none' }, LOGO);
  B.ft(`#${p}-brand`, { y: 120, scale: 0.6, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.8, ease: E.pop }, LOGO + 0.05);
  B.ft(`#${p}-sheen`, { x: -300 }, { x: 1100, duration: 0.8, ease: E.io }, LOGO + 0.6);
  B.ft(`#${p}-tag`, { y: 50, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: E.pop }, LOGO + 0.6);
  B.ft(`#${p}-flash`, { opacity: 0.6 }, { opacity: 0, duration: 0.5, ease: E.out }, LOGO + 0.3);
  sp.burst(B, LOGO + 0.3, 540, 860);
  const css = `${KIT_CSS}
.cta{position:absolute;inset:0;transform-origin:540px 800px}
.q{position:absolute;left:110px;top:300px;width:860px;padding:40px 46px 48px;border-radius:44px 44px 44px 10px;background:#fff;color:#0b1324;font-weight:700;font-size:66px;line-height:1.3;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.q b{color:#d9730a}
.cm{position:absolute;left:0;top:760px;width:1080px;text-align:center}
.fo{position:absolute;left:0;top:930px;width:1080px;text-align:center}
.fo .b{display:inline-block;padding:20px 60px 26px;border-radius:999px;background:linear-gradient(180deg,#ffd166,#f59e0b 60%,#d9730a);color:#1a0d00;font-weight:700;font-size:62px;box-shadow:0 8px 0 #7a3a04,0 20px 50px rgba(245,158,11,.45);white-space:nowrap}
.url{position:absolute;left:0;top:1110px;width:1080px;text-align:center}
.url .u{display:inline-block;padding:20px 50px 24px;border-radius:28px;background:#0b1d4a;box-shadow:inset 0 0 0 5px #fbbf24,0 20px 50px rgba(0,0,0,.5);font-family:Barlow;font-weight:800;font-size:72px;white-space:nowrap}
.url .u b{color:#fbbf24}
.rays{position:absolute;left:-360px;top:0;width:1800px;height:1800px;background:repeating-conic-gradient(from 0deg,rgba(251,191,36,.22) 0deg 5deg,rgba(251,191,36,0) 5deg 15deg);-webkit-mask:radial-gradient(closest-side,#000 0%,rgba(0,0,0,.6) 40%,transparent 75%);mask:radial-gradient(closest-side,#000 0%,rgba(0,0,0,.6) 40%,transparent 75%);mix-blend-mode:screen}
.brand{position:absolute;left:120px;top:700px;width:840px;height:250px;border-radius:44px;background:linear-gradient(180deg,#fff,#eef3fb);box-shadow:0 0 0 6px rgba(251,191,36,.95),0 0 0 12px #3a2203,0 30px 80px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;overflow:hidden}
.brand img{width:760px}
.brand .sheen{position:absolute;top:-20px;bottom:-20px;width:220px;left:0;background:linear-gradient(100deg,rgba(255,255,255,0),rgba(255,255,255,.85),rgba(255,255,255,0));transform:skewX(-18deg)}
.tag{position:absolute;left:0;top:1020px;width:1080px;text-align:center;font-weight:700;font-size:58px;text-shadow:0 4px 0 #04102e,0 10px 30px rgba(0,0,0,.7)}`;
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  <div class="rays" id="${p}-rays" style="opacity:0"></div>
  <div class="cta" id="${p}-cta">
    <div class="q" id="${p}-q">ทีมของคุณ<br><b>ได้หรือเสียแต้ม</b><br>ช่วงท้ายเกม?</div>
    <div class="cm" id="${p}-cm"><span class="chip" style="font-size:50px">คอมเมนต์บอกเรา</span></div>
    <div class="fo" id="${p}-fo"><div class="b" id="${p}-fob">กดติดตาม เข็มทิศฟุตบอล</div></div>
    <div class="url" id="${p}-url"><div class="u">khemthit<b>football</b>.com</div></div>
  </div>
  <div class="brand" id="${p}-brand"><img src="${BRAND('logo-lockup.webp')}" alt=""><div class="sheen" id="${p}-sheen"></div></div>
  <div class="tag" id="${p}-tag">อ่านเกมด้วยข้อมูลจริง</div>
  ${sp.html}
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>`;
  return scene(p, css, body, B.js());
}

// every subtitle phrase on the film clock (a phrase written big on screen is not repeated as a caption)
function buildCaptions(TL) {
  const p = 'cap', B = TLB();
  let html = '';
  const all = TL.subs.filter((s) => !s.onscreen);
  all.forEach((s, i) => {
    const end = i + 1 < all.length ? Math.min(all[i + 1].t0 - 0.08, s.t1 + 0.6) : s.t1 + 0.6;
    const h = s.show, marks = [];
    for (const w of s.hi) { const k = h.indexOf(w); if (k >= 0) marks.push([k, w]); }
    marks.sort((a, b) => a[0] - b[0]);
    let o = '', c = 0, hk = 0;
    for (const [k, w] of marks) {
      if (k < c) continue;
      o += esc(h.slice(c, k)) + `<span class="hi" id="${p}-h${i}_${hk}">${esc(w)}</span>`;
      const tOn = s.t0 + (s.t1 - s.t0) * ((k + w.length * 0.3) / h.length);
      B.ft(`#${p}-h${i}_${hk}`, { color: '#ffffff', scale: 1 }, { color: '#ffc53d', scale: 1.12, duration: 0.12, ease: 'power2.out' }, tOn);
      B.ft(`#${p}-h${i}_${hk}`, { scale: 1.12 }, { scale: 1, duration: 0.25, ease: 'power2.out' }, tOn + 0.12);
      c = k + w.length; hk++;
    }
    o += esc(h.slice(c));
    html += `<div class="grp" id="${p}-g${i}"><div class="tx">${o}</div><div class="ul"><i id="${p}-u${i}"></i></div></div>`;
    const t0 = Math.max(0.1, s.t0 - 0.06);
    B.set(`#${p}-g${i}`, { visibility: 'visible' }, t0);
    B.ft(`#${p}-g${i}`, { y: 26, scale: 0.94, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.22, ease: E.out }, t0);
    B.ft(`#${p}-u${i}`, { scaleX: 0 }, { scaleX: 1, duration: Math.max(0.1, s.t1 - s.t0), ease: 'none' }, s.t0);
    B.ft(`#${p}-g${i}`, { opacity: 1 }, { opacity: 0, duration: 0.1, ease: E.in }, end - 0.1);
    B.set(`#${p}-g${i}`, { visibility: 'hidden' }, end);
  });
  const css = `
.cbg{position:absolute;left:0;top:1390px;width:1080px;height:340px;background:radial-gradient(60% 50% at 50% 50%,rgba(2,6,20,.7),rgba(2,6,20,0))}
.grp{position:absolute;left:60px;top:1430px;width:960px;text-align:center;visibility:hidden;overflow:visible}
.grp .tx{font-weight:700;font-size:60px;line-height:1.34;color:#fff;text-shadow:0 4px 0 #04102e,0 0 2px #04102e,0 10px 28px rgba(0,0,0,.8)}
.grp .hi{display:inline-block}
.grp .ul{margin:12px auto 0;height:8px;width:260px;border-radius:4px;background:rgba(255,255,255,.15);overflow:hidden}
.grp .ul i{display:block;height:100%;background:linear-gradient(90deg,#f59e0b,#ffd166);border-radius:4px;transform-origin:0 50%}`;
  return `<template>
<style>${FONTS}
#root{position:absolute;inset:0;font-family:Plex,sans-serif;pointer-events:none}
${css}
</style>
<div id="root" data-composition-id="${p}" data-width="1080" data-height="1920">
<div class="cbg"></div>
${html}
</div>
<script>
(function(){
const tl=gsap.timeline({paused:true});
${B.js()}
window.__timelines["${p}"]=tl;
})();
</script>
</template>
`;
}

function buildProject(TL, P) {
  const { facts, spot, segs } = P;
  fs.rmSync(path.join(HF, 'compositions'), { recursive: true, force: true });
  fs.mkdirSync(path.join(HF, 'compositions'), { recursive: true });
  for (const d of ['fonts', 'logos', 'brand']) fs.mkdirSync(path.join(HF, 'assets', d), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'assets', 'fonts'))) fs.copyFileSync(path.join(ROOT, 'assets', 'fonts', f), path.join(HF, 'assets', 'fonts', f));
  for (const l of [facts.league.logo, ...facts.teams.map((t) => t.logo)]) fs.copyFileSync(path.join(ROOT, l), path.join(HF, l));
  fs.copyFileSync(path.join(REPO, 'apps', 'web', 'public', 'brand', 'logo-lockup.webp'), path.join(HF, 'assets', 'brand', 'logo-lockup.webp'));
  fs.copyFileSync(path.join(OUT, 'mix.wav'), path.join(HF, 'assets', 'mix.wav'));
  const hosts = [];
  let tn = 0;
  for (const sc of TL.scenes) {
    const g = segs[sc.i];
    const id = { hook: 'hook', table: 'tb', stat: 'st', lead: 'ld', outro: 'ou' }[sc.role] || `tm${tn}`;
    const html = sc.role === 'hook' ? buildHook(TL, sc, facts, spot) : sc.role === 'table' ? buildTable(TL, sc, facts) : sc.role === 'stat' ? buildStat(TL, sc, facts)
      : sc.role === 'team' ? buildTeam(TL, sc, facts, g, tn++) : sc.role === 'lead' ? buildLead(TL, sc, facts, g) : buildOutro(TL, sc, facts);
    fs.writeFileSync(path.join(HF, 'compositions', `${id}.html`), html);
    hosts.push({ id, start: r3(sc.t0), dur: r3(sc.t1 - sc.t0) });
  }
  fs.writeFileSync(path.join(HF, 'compositions', 'cap.html'), buildCaptions(TL));
  const index = `<!doctype html>
<html lang="th">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>${esc(spot.series)}: ${esc(spot.title.join(' '))}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1080px; height: 1920px; overflow: hidden; background: #02060f; }
      #root { position: relative; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${TL.T}" data-width="1080" data-height="1920" data-fps="${FPS}">
${hosts.map((h) => `      <div id="${h.id}" data-composition-id="${h.id}" data-composition-src="compositions/${h.id}.html" data-start="${h.start}" data-duration="${h.dur}" data-track-index="1" data-track-kind="graphics" data-width="1080" data-height="1920" style="z-index:1"></div>`).join('\n')}
      <div id="cap" data-composition-id="cap" data-composition-src="compositions/cap.html" data-start="0" data-duration="${TL.T}" data-track-index="5" data-track-kind="captions" data-width="1080" data-height="1920" style="z-index:10"></div>
      <audio id="mix" class="clip" src="assets/mix.wav" data-start="0" data-duration="${TL.T}" data-track-index="8" data-volume="1"></audio>
    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(HF, 'index.html'), index);
  fs.writeFileSync(path.join(HF, 'hyperframes.json'), JSON.stringify({ $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json', registry: 'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry', paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' }, media: { autoProxy: true }, authoringSkill: 'hyperframes' }, null, 2));
  fs.writeFileSync(path.join(HF, 'meta.json'), JSON.stringify({ id: `insight-${slug}`, name: `${spot.series} ${slug}` }, null, 2));
  fs.writeFileSync(path.join(HF, 'package.json'), JSON.stringify({ name: `insight-${slug}`, private: true, type: 'module', scripts: { dev: `npx --yes ${HFV} preview`, check: `npx --yes ${HFV} check`, render: `npx --yes ${HFV} render` } }, null, 2));
  console.log(`hf project: ${path.relative(ROOT, HF)} · ${hosts.map((h) => `${h.id}@${h.start}+${h.dur}`).join(' ')} · total ${TL.T}s`);
}

// ---------- 6. stills + film ----------
const npx = (a) => spawnSync('npx', ['--yes', HFV, ...a], { cwd: HF, encoding: 'utf8', shell: true, maxBuffer: 64 << 20 });

function stills(TL) {
  const chk = npx(['check']);
  console.log((chk.stdout || '').split('\n').filter((l) => /error|warn|✓|✗|pass|fail/i.test(l)).slice(0, 30).join('\n'));
  const snap = path.join(OUT, 'snaps');
  fs.rmSync(snap, { recursive: true, force: true });
  const r = npx(['snapshot', '.', '--at', TL.probe.join(','), '--no-end', '-o', snap, '--timeout', '120000']);
  if (r.status) { console.error(r.stdout, r.stderr); process.exit(1); }
  console.log(`stills: ${path.relative(ROOT, snap)} (${fs.readdirSync(snap).join(', ')})`);
}

function film(TL) {
  fs.mkdirSync(FINAL, { recursive: true });
  const out = path.join(FINAL, `${slug}.mp4`);
  const t0 = Date.now();
  const r = spawnSync('npx', ['--yes', HFV, 'render', '.', '-o', out, '--quality', 'looks'], { cwd: HF, stdio: 'inherit', shell: true });
  if (r.status) process.exit(r.status);
  const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout.trim();
  const loud = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.split('\n').filter((l) => /^\s+(I|Peak):/.test(l)).slice(-2).map((l) => l.trim()).join(' · ');
  const contact = path.join(FINAL, 'contact.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', out, '-vf', 'fps=1,scale=180:-1,tile=10x6', '-frames:v', '1', contact]);
  console.log(`${out}\n${Number(dur).toFixed(1)} s · ${loud} · rendered in ${((Date.now() - t0) / 60000).toFixed(1)} min\ncontact sheet: ${contact}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const P = prepare();
  let TL;
  if (step === 'stills' || step === 'all') {
    await voice(P.segs);
    TL = timeline(P);
    const { mus, sfx } = sound(TL);
    mixdown(DIR, OUT, TL, mus, sfx, slug);
    buildProject(TL, P);
    stills(TL);
  }
  if (step === 'film' || step === 'all') film(TL || readJson(path.join(OUT, 'timeline.json')));
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

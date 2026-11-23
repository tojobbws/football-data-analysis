// "เปิดแฟ้มข้อมูล" film, the new-coach episode: a struggling team's numbers (same plan, fewer points), three problems
// the data shows, and what the new coach's last club looked like. First episode: Manchester United x Pochettino.
// Inputs: insights/<slug>/facts.json (the only source of numbers, built read-only from the production DB),
//         insights/<slug>/spot.json (the script), insights/<slug>/photos/ + credits.json (freely licensed photos).
// usage: node insight-coach.cjs <slug> stills   -> check the script, voice (cached), timeline, mix, HyperFrames project, stills
//        node insight-coach.cjs <slug> film     -> render insights/<slug>/final/<slug>.mp4 + contact sheet
//        node insight-coach.cjs <slug> all
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ROOT, REPO, readJson, writeJson } = require('./lib.cjs');
const { speak } = require('./tts.cjs');
const { kit, mixdown } = require('./audio.cjs');
const { r3, esc, TLB, E, FONTS, ambient, sparks, scene, BRAND } = require('./hfkit.cjs');

const args = process.argv.slice(2);
const step = args.find((a) => ['check', 'stills', 'film', 'all'].includes(a)) || 'stills';
const slug = args.find((a) => a !== step) || '33-2026-pochettino';
const DIR = path.join(ROOT, 'insights', slug);
const OUT = path.join(DIR, 'out');
const HF = path.join(DIR, 'hf');
const FINAL = path.join(DIR, 'final');
const HFV = 'hyperframes@0.9.23';
const FPS = 30;

const TEMPO = 1.15;
const COVER = 1.0;
const LEAD = { hook: 0.3, plan: 0.5, defence: 0.5, leads: 0.5, shots: 0.45, coach: 0.5, lean: 0.45, outro: 0.45 };
const HOLD = { hook: 0.2, plan: 0.6, defence: 0.7, leads: 0.8, shots: 0.7, coach: 0.7, lean: 0.6, outro: 0 };
const TAIL = 2.4;
const TAGS = { hook: '[excited] ', plan: '[confident] ', defence: '[confident] ', leads: '[excited] ', shots: '[confident] ', coach: '[excited] ', lean: '[confident] ', outro: '[confident] ' };
const BANNED = ['ทีเด็ด', 'แทง', 'กำไร', 'ตามคู่นี้', 'การันตี', 'ชัวร์', 'แน่นอน', 'ได้เงิน', 'เสียเงิน', 'ราคาบอล', 'ฟันธง', 'ราคาต่อรอง', 'สูงต่ำ'];
const MARKS = { hook: ['rec', 'rank', 'coach', 'turn'], plan: ['back3', 'last', 'lastpts', 'now', 'nowpts'], defence: ['head', 'rise', 'last4', 'cs'], leads: ['head', 's0', 's1', 's2', 'eq', 'late', 'total'],
  shots: ['head', 'now', 'was', 'xg'], coach: ['ask', 'che', 'first', 'miss', 'second'], lean: ['keep', 'poss', 'def', 'che'], outro: ['next', 'ask', 'comment', 'follow'] };
const ROLES = Object.keys(MARKS);

const f1 = (x) => Math.round(x * 10) / 10;
const pts = (gf, ga) => (gf > ga ? 3 : gf === ga ? 1 : 0);
const minuteOf = (g) => g.m; // elapsed + extra/100

// ---------- 1. script + facts ----------
/** The numbers the film may say, each derived from facts.json in one place. */
function derive(facts) {
  const now = facts.mu_2026, last = facts.mu_2025.by_formation['4-2-3-1'], che = facts.che_2023_pochettino;
  const led = now.led_not_won_list;
  const lost = led.reduce((s, m) => { const [gf, ga] = m.final.split('-').map(Number); return s + 3 - pts(gf, ga); }, 0);
  const lateN = led.filter((m) => { const a = m.goals.filter((g) => !g.forUs); return a.length && minuteOf(a.at(-1)) >= 90; }).length;
  const ko = new Date(facts.next_match.kickoff_utc);
  const part = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', ...o }).format(ko);
  const wd = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'][new Date(ko.getTime() + 7 * 3600e3).getUTCDay()];
  const xgSum = now.matches.reduce((s, m) => s + (m.xg || 0), 0);
  return {
    played: now.played, w: now.w, d: now.d, l: now.l, rank: now.standing.rank, points: now.standing.points,
    early_formation: '3-4-2-1', early_played: facts.mu_2025.by_formation['3-4-2-1'].played, ppg_early: f1(facts.mu_2025.by_formation['3-4-2-1'].ppg),
    ppg_last: f1(last.ppg), ppg_now: f1(now.ppg), last_played: last.played, now_played: now.by_formation['4-2-3-1']?.played,
    xga_last: f1(last.xga_pg), xga_now: f1(now.xga_pg), xga_last_exact: last.xga_pg, clean: now.clean_sheets,
    led_n: led.length, late_n: lateN, lost,
    shots_last: Math.round(last.shots_pg), shots_now: Math.round(now.shots_pg), shots_now_exact: now.shots_pg,
    below_xg: -now.goals_minus_xg, below_xg_whole: Math.floor(-now.goals_minus_xg), goals_now: now.gf, xg_sum: Math.round(xgSum * 100) / 100,
    che_first: f1(che.first19.ppg), che_second: f1(che.last19.ppg), che_miss: -che.first19.goals_minus_xg, che_miss_whole: Math.floor(-che.first19.goals_minus_xg),
    che_4231: che.by_formation['4-2-3-1'].played, che_played: che.played, che_xga: Math.round(che.xga_pg * 100) / 100, che_poss: Math.round(che.poss_pg), poss_now: Math.round(now.poss_pg),
    ko_day: Number(part({ day: 'numeric' })), ko_hh: Number(part({ hour: '2-digit', hour12: false })), ko_mm: Number(part({ minute: '2-digit' })), ko_wd: wd,
    ko_month: new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', month: 'short' }).format(ko),
  };
}

function prepare() {
  const facts = readJson(path.join(DIR, 'facts.json'));
  const spot = readJson(path.join(DIR, 'spot.json'));
  const credits = readJson(path.join(DIR, 'photos', 'credits.json'));
  const D = derive(facts);
  const errors = [];
  const ints = new Set((JSON.stringify(facts).match(/\d+/g) || []).map(Number));
  const derived = new Set(Object.values(D).filter((v) => typeof v === 'number'));
  const nums = (s) => (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  const segs = spot.segments.map((g, i) => ({ ...g, i }));
  if (segs.map((g) => g.role).join() !== ROLES.join()) errors.push(`segments must be ${ROLES.join(', ')} in that order`);
  for (const g of segs) {
    const where = g.role;
    for (const w of BANNED) if (g.segment.includes(w)) errors.push(`${where}: banned word "${w}"`);
    let cur = 0;
    const shown = [];
    for (const p of g.subs) {
      const ix = g.segment.indexOf(p.say, cur);
      if (ix < 0) errors.push(`${where}: subtitle "${p.say}" is not in the voice text (in order)`); else cur = ix + p.say.length;
      for (const h of p.hi || []) if (!p.show.includes(h)) errors.push(`${where}: highlight "${h}" is not in "${p.show}"`);
      for (const n of nums(p.show)) {
        shown.push(n);
        if (Number.isInteger(n) ? !(ints.has(n) || derived.has(n)) : !derived.has(n)) errors.push(`${where}: "${n}" in "${p.show}" is not a number the facts give`);
      }
      if (p.show.includes('ลูกครึ่ง')) { const m = p.show.match(/(\d+) ลูกครึ่ง/); if (m && Math.abs(Number(m[1]) + 0.5 - D.below_xg) > 0.25) errors.push(`${where}: "${m[0]}" is not about ${D.below_xg.toFixed(2)}`); }
    }
    for (const k of g.need || []) if (!shown.includes(D[k])) errors.push(`${where}: the subtitles must show ${k} = ${D[k]}`);
    for (const k of MARKS[g.role] || []) if (!g.marks || !g.marks[k] || !g.segment.includes(g.marks[k])) errors.push(`${where}: marks.${k} must be a piece of the voice text`);
  }
  // claims tied to the words
  if (D.led_n !== 3 || !segs[3].segment.includes('สามนัด')) errors.push(`leads: the facts have ${D.led_n} leads not won`);
  for (const r of Object.keys(spot.photos)) if (!credits.find((c) => c.file === spot.photos[r] && c.downloaded)) errors.push(`photo ${spot.photos[r]} has no credit entry`);
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('derived', JSON.stringify(D));
  return { facts, spot, segs, D, credits };
}

// ---------- 2. voice ----------
async function voice(segs) {
  for (const g of segs) await speak(TAGS[g.role] + g.segment, path.join(DIR, 'vo'), g.i, `coach ${g.role}`);
}

// ---------- 3. timeline ----------
function timeline({ segs }) {
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
    scenes.push({ i: g.i, role: g.role, t0: +t0.toFixed(3), speech: +start.toFixed(3), end: +end.toFixed(3), marks, subs: [first0, subs.length] });
    clock = end + HOLD[g.role];
  }
  const T = +(clock + TAIL).toFixed(3);
  scenes[0].t0 = 0;
  scenes.forEach((s, k) => { s.t1 = k + 1 < scenes.length ? scenes[k + 1].t0 : T; });
  const S = (role) => scenes.find((s) => s.role === role);
  const probe = [0.5, S('hook').marks.rank + 0.9, S('hook').marks.turn + 0.8, S('plan').marks.last - 0.15, S('plan').marks.lastpts + 0.6, S('plan').marks.nowpts + 0.8, S('defence').marks.last4 + 1.4, S('defence').marks.cs + 0.7,
    S('leads').marks.late + 0.8, S('leads').marks.total + 0.9, S('shots').marks.xg + 1.2, S('coach').marks.che + 0.8, S('coach').marks.second + 0.9, S('lean').marks.che + 1.0,
    S('outro').marks.ask + 0.8, S('outro').marks.follow + 0.9, T - 0.4].map((t) => +Math.min(t, T - 0.05).toFixed(2));
  const TL = { slug, T, cover: COVER, fps: FPS, frames: Math.round(T * FPS), tempo: TEMPO, segs: out, subs, scenes, probe, logoAt: +(S('outro').end + 0.35).toFixed(3) };
  writeJson(path.join(OUT, 'timeline.json'), TL);
  console.log(`${slug} T ${T}s ·`, scenes.map((s) => `${s.role} ${s.t0.toFixed(2)}`).join(' / '));
  return TL;
}

// ---------- 4. sound ----------
function sound(TL) {
  const T = TL.T + 0.8;
  const K = kit(T);
  const { mus, sfx, add, kick, noiseHit, snare, bassNote, chord, riser, whoosh, boom, crowd, bell, groove, audioLogo, fadeTail } = K;
  const S = (role) => TL.scenes.find((s) => s.role === role);
  const tick = (t0, g = 1) => add(sfx, t0, (t) => Math.sin(2 * Math.PI * 2400 * t) * Math.exp(-t * 140), 0.05, g * 0.25);
  const sad = (t0) => { bassNote(mus, t0, 0.6, 28, 0.55); bassNote(mus, t0 + 0.02, 0.55, 40, 0.25); };
  const hook = S('hook'), plan = S('plan'), def = S('defence'), leads = S('leads'), shots = S('shots'), coach = S('coach'), lean = S('lean'), outro = S('outro');
  // cover: a low pad and one bell, a whoosh into the story
  chord(mus, 0, TL.cover + 0.1, [57, 60, 64, 69], 0.45, 800); bassNote(mus, 0, TL.cover, 33, 0.25); bell(sfx, 0.02, 81, 0.35, 0); whoosh(sfx, TL.cover - 0.3, 0.5, 0.35, 0);
  // hook: a tense pad, a hit on the record and the rank, a riser into the turn
  chord(mus, TL.cover, hook.t1 - TL.cover, [57, 60, 64], 0.4, 700); bassNote(mus, TL.cover, hook.t1 - TL.cover, 33, 0.25);
  boom(sfx, hook.marks.rec, 0.4); boom(sfx, hook.marks.rank, 0.55); sad(hook.marks.rank + 0.05);
  kick(sfx, hook.marks.coach, 0.4); riser(sfx, hook.marks.turn - 0.9, 0.9, 0.25); boom(sfx, hook.marks.turn, 0.4);
  // the beat runs from the plan to the brand
  groove(plan.t0 + 0.1, TL.logoAt, 0.6);
  for (const s of [plan, def, leads, shots, coach, lean, outro]) { whoosh(sfx, s.t0, 0.5, 0.35, 0); kick(sfx, s.t0 + 0.25, 0.3); }
  kick(sfx, plan.marks.last, 0.35); bell(sfx, plan.marks.lastpts + 0.2, 81, 0.5, 0); kick(sfx, plan.marks.now, 0.35); sad(plan.marks.nowpts + 0.2);
  boom(sfx, def.marks.rise + 0.3, 0.45);
  for (let k = 0; k < 4; k++) { whoosh(sfx, def.marks.last4 + 0.1 + k * 0.3, 0.3, 0.2, k % 2 ? 0.4 : -0.4); kick(sfx, def.marks.last4 + 0.3 + k * 0.3, 0.3); }
  sad(def.marks.cs + 0.1);
  for (const k of ['s0', 's1', 's2']) { whoosh(sfx, leads.marks[k] - 0.15, 0.4, 0.28, 0); kick(sfx, leads.marks[k] + 0.1, 0.35); }
  noiseHit(sfx, leads.marks.eq, 0.6, 4, 12000, 4000, 0.14); crowd(sfx, leads.marks.eq, 1.6, 0.08, (t) => Math.min(1, t / 0.3) * Math.exp(-t * 1.6));
  const R = leads.marks.total; snare(sfx, R - 0.3, 0.15); snare(sfx, R - 0.18, 0.2); snare(sfx, R - 0.08, 0.25); boom(sfx, R + 0.1, 0.55); sad(R + 0.1);
  for (let n = 0; n < 19; n++) tick(shots.marks.now + n * 0.04, 0.7 + n * 0.015);
  kick(sfx, shots.marks.was, 0.35); boom(sfx, shots.marks.xg + 0.6, 0.4); sad(shots.marks.xg + 0.7);
  kick(sfx, coach.marks.che, 0.35); sad(coach.marks.first + 0.3);
  bell(sfx, coach.marks.second + 0.2, 76, 0.8, -0.2); bell(sfx, coach.marks.second + 0.29, 81, 0.8, 0.2); bell(sfx, coach.marks.second + 0.38, 88, 0.9, 0);
  crowd(sfx, coach.marks.second + 0.2, 2.2, 0.18, (t) => Math.min(1, t / 0.15) * Math.exp(-Math.max(0, t - 0.5) * 1.3));
  for (const k of ['keep', 'poss', 'def', 'che']) kick(sfx, lean.marks[k], 0.35);
  kick(sfx, outro.marks.next, 0.4); kick(sfx, outro.marks.ask, 0.35); kick(sfx, outro.marks.comment, 0.35); kick(sfx, outro.marks.follow, 0.4);
  chord(mus, outro.marks.follow, TL.logoAt - outro.marks.follow, [57, 60, 64, 69], 0.5, 800);
  riser(sfx, outro.marks.follow, TL.logoAt - outro.marks.follow, 0.25);
  audioLogo(TL.logoAt, T);
  fadeTail();
  return { mus, sfx };
}

// ---------- 5. HyperFrames scenes ----------
const local = (sc) => (t) => r3(t - sc.t0);
const logo = (id) => `assets/logos/teams-${id}.png`;
const plate = (id, src, size, pos = '', ring = '#f6b72a') => `<div class="lp" id="${id}" style="${pos}width:${size}px;height:${size}px;box-shadow:0 0 0 ${Math.round(size / 28)}px ${ring},0 0 0 ${Math.round(size / 16)}px #3a2203,0 ${Math.round(size / 14)}px ${Math.round(size / 5)}px rgba(0,0,0,.55)"><img src="${src}" alt=""></div>`;
const KIT_CSS = `
.lp{position:absolute;border-radius:50%;background:radial-gradient(circle at 38% 30%,#fff 0%,#eef3fb 45%,#cfd9ea 100%);display:flex;align-items:center;justify-content:center;overflow:hidden}
.lp img{width:66%;height:66%;object-fit:contain}
.up{color:#4ade80}.dn{color:#f87171}
.chip{display:inline-flex;align-items:center;gap:14px;padding:12px 30px 16px;border-radius:999px;background:rgba(10,26,70,.9);box-shadow:inset 0 0 0 3px rgba(251,191,36,.55);font-weight:700;font-size:40px;white-space:nowrap}
.ph{position:absolute;inset:0;overflow:hidden;transform-origin:50% 35%}
.ph img{width:100%;height:100%;object-fit:cover}
.shade{position:absolute;inset:0}
.cred{position:absolute;left:28px;right:28px;top:1874px;font-weight:600;font-size:21px;color:rgba(230,236,250,.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 2px 6px rgba(0,0,0,.9)}
.hd{position:absolute;left:0;top:120px;width:1080px;text-align:center}
.hd .k{display:inline-block;padding:10px 30px 14px;border-radius:16px 16px 16px 4px;background:linear-gradient(180deg,#ffd166,#f59e0b);color:#1a0d00;font-weight:700;font-size:38px}
.hd .t{margin-top:14px;font-weight:700;font-size:84px;line-height:1.1;text-shadow:0 6px 0 #04102e,0 16px 40px rgba(0,0,0,.6)}
.n{font-family:Barlow;font-weight:900;line-height:1}
.card{position:absolute;border-radius:30px;background:linear-gradient(180deg,rgba(16,36,86,.94),rgba(5,12,34,.96));box-shadow:inset 0 0 0 3px rgba(120,160,255,.25),0 20px 50px rgba(0,0,0,.5)}`;
/** A full-bleed photo with a slow push-in, a shade and its credit line. */
function photo(B, p, file, credit, T, { pos = '50% 30%', shade = 'linear-gradient(180deg,rgba(2,6,15,.15) 0%,rgba(2,6,15,.3) 38%,rgba(2,6,15,.9) 62%,#02060f 100%)', filter = '', box = 'inset:0' } = {}) {
  B.ft(`#${p}-ph`, { scale: 1.04 }, { scale: 1.14, duration: T, ease: 'none' }, 0);
  const html = `<div class="ph" id="${p}-ph" style="${box}"><img src="assets/photos/${file}" style="object-position:${pos};${filter ? 'filter:' + filter : ''}" alt=""></div><div class="shade" style="background:${shade}"></div>`;
  const cred = `<div class="cred">ภาพ: ${esc(credit.author)} · ${esc(credit.license)} · Wikimedia Commons</div>`;
  return { html, cred };
}
const creditOf = (P, role) => P.credits.find((c) => c.file === P.spot.photos[role]);
const head = (p, k, t) => `<div class="hd" id="${p}-hd"><div class="k">${esc(k)}</div><div class="t">${esc(t)}</div></div>`;

function buildHook(TL, sc, P) {
  const { D, spot, facts } = P, p = 'hk', L = local(sc), T = sc.t1 - sc.t0, C = TL.cover;
  const B = TLB();
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const ph = photo(B, p, spot.photos.hook, creditOf(P, 'hook'), T, { pos: '50% 18%', shade: 'linear-gradient(180deg,rgba(2,6,15,.05) 0%,rgba(2,6,15,.2) 36%,rgba(2,6,15,.86) 55%,#02060f 78%)' });
  const sp = sparks(p, 's', 26, 21);
  const REC = L(sc.marks.rec), RANK = L(sc.marks.rank), CO = L(sc.marks.coach), TURN = L(sc.marks.turn);
  B.ft(`#${p}-cover`, { opacity: 1, scale: 1 }, { opacity: 0, scale: 1.08, duration: 0.28, ease: E.in }, C - 0.22);
  B.set(`#${p}-cover`, { visibility: 'hidden' }, C + 0.08);
  B.ft(`#${p}-rec`, { y: 80, opacity: 0, scale: 0.8 }, { y: 0, opacity: 1, scale: 1, duration: 0.45, ease: E.pop }, REC - 0.1);
  B.ft(`#${p}-rk`, { y: 80, opacity: 0, scale: 0.8 }, { y: 0, opacity: 1, scale: 1, duration: 0.45, ease: 'back.out(2.2)' }, RANK - 0.05);
  B.ft(`#${p}-flash`, { opacity: 0.45 }, { opacity: 0, duration: 0.5, ease: E.out }, RANK + 0.1);
  B.ft(`#${p}-nm`, { x: -120, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: E.out }, CO - 0.1);
  B.ft(`#${p}-nm`, { opacity: 1 }, { opacity: 0, duration: 0.2 }, TURN - 0.15);
  B.ft(`#${p}-q`, { scale: 0.4, opacity: 0, rotation: -8 }, { scale: 1, opacity: 1, rotation: -3, duration: 0.45, ease: 'back.out(2.2)' }, TURN);
  sp.burst(B, TURN + 0.1, 540, 900);
  B.ft(`#${p}-stage`, { scale: 1, opacity: 1 }, { scale: 1.25, opacity: 0, duration: 0.35, ease: E.in }, T - 0.35);
  const css = `${KIT_CSS}
#hk-cover{position:absolute;inset:0;z-index:20;transform-origin:540px 900px}
.cv-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(2,6,15,.55) 0%,rgba(2,6,15,0) 22%,rgba(2,6,15,.15) 40%,rgba(2,6,15,.92) 58%,#02060f 80%)}
.cv-logo{position:absolute;left:290px;top:70px;width:500px;height:150px;border-radius:30px;background:linear-gradient(180deg,#fff,#eef3fb);box-shadow:0 0 0 5px rgba(251,191,36,.95),0 0 0 10px #3a2203,0 20px 60px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center}
.cv-logo img{width:450px}
.cv-tab{position:absolute;left:0;top:1060px;width:1080px;text-align:center}
.cv-tab span{display:inline-block;padding:14px 46px 18px;border-radius:26px 26px 0 0;background:linear-gradient(180deg,#ffd166,#f59e0b);color:#1a0d00;font-weight:700;font-size:54px;box-shadow:0 -6px 30px rgba(245,158,11,.4)}
.cv-file{position:absolute;left:60px;top:1150px;width:960px;height:380px;border-radius:12px 12px 36px 36px;background:linear-gradient(180deg,rgba(16,36,86,.96),rgba(5,12,34,.98));box-shadow:inset 0 0 0 4px rgba(251,191,36,.7),0 30px 80px rgba(0,0,0,.7)}
.cv-t{position:absolute;left:0;width:960px;text-align:center;font-weight:700;line-height:1.05;white-space:nowrap}
.cv-foot{position:absolute;left:0;top:1580px;width:1080px;text-align:center;font-weight:600;font-size:34px;color:rgba(220,230,255,.8)}
.rec{position:absolute;left:90px;top:1000px;width:900px;height:200px;display:flex;gap:18px}
.rec .c{flex:1;border-radius:26px;background:rgba(10,26,70,.88);box-shadow:inset 0 0 0 3px rgba(120,160,255,.3);display:flex;flex-direction:column;align-items:center;justify-content:center}
.rec .c .n{font-size:110px}
.rec .c b{font-weight:700;font-size:34px;color:rgba(220,230,255,.85)}
.rk{position:absolute;left:90px;top:1225px;width:900px;height:170px;border-radius:30px;background:linear-gradient(90deg,rgba(127,29,29,.95),rgba(69,10,10,.95));box-shadow:inset 0 0 0 4px #f87171,0 20px 60px rgba(248,113,113,.35)}
.rk .lb{position:absolute;left:190px;top:22px;font-weight:700;font-size:40px}
.rk .sub{position:absolute;left:190px;top:84px;font-weight:600;font-size:34px;color:rgba(255,220,220,.85)}
.rk .n{position:absolute;right:40px;top:12px;font-size:150px;color:#fff}
.nm{position:absolute;left:60px;top:840px}
.nm .a{display:inline-block;padding:10px 26px 14px;border-radius:14px;background:rgba(2,6,15,.75);box-shadow:inset 4px 0 0 #fbbf24;font-weight:700;font-size:46px}
.nm .b{margin-top:8px;font-weight:600;font-size:32px;color:#fbbf24;text-shadow:0 2px 8px #000}
.q{position:absolute;left:0;top:850px;width:1080px;text-align:center;z-index:3}`;
  const mu = facts.team.id;
  const body = `<div class="stage" id="${p}-stage">${ph.html}
  <div class="nm" id="${p}-nm"><div class="a">${esc(spot.coach.name)}</div><div class="b">${esc(spot.coach.role)}</div></div>
  <div class="rec" id="${p}-rec"><div class="c"><div class="n">${D.played}</div><b>นัด</b></div><div class="c"><div class="n up">${D.w}</div><b>ชนะ</b></div><div class="c"><div class="n">${D.d}</div><b>เสมอ</b></div><div class="c"><div class="n dn">${D.l}</div><b>แพ้</b></div></div>
  <div class="rk" id="${p}-rk">${plate(`${p}-mu`, logo(mu), 130, 'left:30px;top:20px;', '#f87171')}<div class="lb">อันดับในพรีเมียร์ลีก</div><div class="sub">${D.points} แต้ม · ถึง ${esc(thDate(facts.mu_2026.through))}</div><div class="n">${D.rank}</div></div>
  <div class="q" id="${p}-q"><span class="pill" style="font-size:54px">ปัญหาอยู่ตรงไหน?</span></div>
  ${sp.html}
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>${ph.cred}
<div id="hk-cover">
  <div class="cv-shade"></div>
  <div class="cv-logo"><img src="${BRAND('logo-lockup.webp')}" alt=""></div>
  <div class="cv-tab"><span>${esc(spot.series)}</span></div>
  <div class="cv-file">
    ${plate(`${p}-cvmu`, logo(mu), 150, 'left:790px;top:-70px;')}
    <div class="cv-t" style="top:130px;font-size:100px">${esc(spot.title[0])}</div>
    <div class="cv-t gold" style="top:240px;font-size:112px">${esc(spot.title[1])}</div>
  </div>
  <div class="cv-foot">แมนยู · พรีเมียร์ลีก ${D.played} นัดแรก ฤดูกาล 2026-27</div>
</div>`;
  return scene(p, css, body, B.js());
}

/** Dot positions of a formation on a W x H pitch (attack upward): goalkeeper, then the lines of the formation string. */
function formationPos(formation, W, H) {
  const lines = [1, ...formation.split('-').map(Number)];
  const ys = lines.map((_, k) => 0.9 - k * (0.75 / (lines.length - 1)));
  const out = [];
  lines.forEach((cnt, r) => { for (let k = 0; k < cnt; k++) out.push({ left: Math.round(((k + 1) / (cnt + 1)) * W - 22), top: Math.round(ys[r] * H - 22) }); });
  return out;
}
/** Formation dots on a small pitch. */
function miniPitch(id, formation, W, H) {
  const pos = formationPos(formation, W, H);
  const dots = pos.map((q, n) => `<div class="pd" id="${id}-d${n}" style="left:${q.left}px;top:${q.top}px"></div>`).join('');
  const n = pos.length;
  const L = 'fill="none" stroke="rgba(235,245,255,.6)" stroke-width="3"';
  const svg = `<svg width="${W}" height="${H}" style="position:absolute;inset:0"><rect x="0" y="0" width="${W}" height="${H}" rx="18" fill="#0b403c"/>${Array.from({ length: 8 }, (_, i) => `<rect x="0" y="${(i * H) / 8}" width="${W}" height="${H / 16}" fill="#0d4a45"/>`).join('')}
    <rect x="12" y="12" width="${W - 24}" height="${H - 24}" rx="6" ${L}/><line x1="12" y1="${H / 2}" x2="${W - 12}" y2="${H / 2}" ${L}/><circle cx="${W / 2}" cy="${H / 2}" r="${W * 0.16}" ${L}/>
    <rect x="${W * 0.22}" y="12" width="${W * 0.56}" height="${H * 0.14}" ${L}/><rect x="${W * 0.22}" y="${H - 12 - H * 0.14}" width="${W * 0.56}" height="${H * 0.14}" ${L}/></svg>`;
  return { html: `<div class="mp" id="${id}" style="width:${W}px;height:${H}px">${svg}${dots}</div>`, n };
}

function buildPlan(TL, sc, P) {
  const { D, facts, spot } = P, p = 'pl', L = local(sc), T = sc.t1 - sc.t0;
  const B = TLB();
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const ph = photo(B, p, spot.photos.plan, creditOf(P, 'plan'), T, { pos: '50% 50%', filter: 'blur(4px) brightness(.55)', shade: 'linear-gradient(180deg,rgba(2,6,15,.55),rgba(2,6,15,.8) 50%,#02060f 85%)' });
  const W = 400, H = 560;
  // last season: the left pitch starts in the back three, then its dots move into the 4-2-3-1
  const A = miniPitch(`${p}-a`, D.early_formation, W, H), Bp = miniPitch(`${p}-b`, '4-2-3-1', W, H);
  const to4 = formationPos('4-2-3-1', W, H);
  const BACK = L(sc.marks.back3), LAST = L(sc.marks.last), LP = L(sc.marks.lastpts), NOW = L(sc.marks.now), NP = L(sc.marks.nowpts);
  for (const [side, at, m] of [['a', 0.25, A], ['b', NOW, Bp]]) {
    B.ft(`#${p}-${side}`, { y: 80, opacity: 0, rotationX: 35 }, { y: 0, opacity: 1, rotationX: 0, duration: 0.5, ease: E.out }, at - 0.15);
    for (let k = 0; k < m.n; k++) B.ft(`#${p}-${side}-d${k}`, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.25, ease: 'back.out(2.4)' }, at + 0.2 + k * 0.04);
  }
  B.ft(`#${p}-a0`, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: E.pop }, Math.min(0.5, BACK));
  const from = formationPos(D.early_formation, W, H);
  for (let k = 0; k < A.n; k++) B.ft(`#${p}-a-d${k}`, { x: 0, y: 0 }, { x: to4[k].left - from[k].left, y: to4[k].top - from[k].top, duration: 0.7, ease: E.io }, LAST - 0.05 + k * 0.02);
  B.ft(`#${p}-a0`, { opacity: 1 }, { opacity: 0, duration: 0.2 }, LAST - 0.1);
  B.ft(`#${p}-al`, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: E.pop }, LAST + 0.1);
  B.ft(`#${p}-hd`, { y: -60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: E.pop }, LAST + 0.2);
  B.ft(`#${p}-bl`, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: E.pop }, NOW + 0.1);
  B.ft(`#${p}-an`, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.4)' }, LP);
  B.ft(`#${p}-bn`, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.4)' }, NP);
  B.ft(`#${p}-flash`, { opacity: 0.35 }, { opacity: 0, duration: 0.45, ease: E.out }, NP + 0.1);
  B.ft(`#${p}-bpit`, { boxShadow: '0 0 0 0px rgba(248,113,113,0)' }, { boxShadow: '0 0 0 6px rgba(248,113,113,.9)', duration: 0.3 }, NP);
  B.ft(`#${p}-stage`, { opacity: 1, x: 0 }, { opacity: 0, x: -200, duration: 0.3, ease: E.in }, T - 0.3);
  const css = `${KIT_CSS}
.mp{position:absolute;left:0;top:0;transform-origin:50% 100%}
.pd{position:absolute;width:44px;height:44px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#ff6b6b,#b91c1c);box-shadow:0 0 0 4px #fff,0 6px 14px rgba(0,0,0,.5)}
.col{position:absolute;top:380px;width:${W}px;height:${H}px;border-radius:18px}
.lab{position:absolute;top:${380 + H + 26}px;width:${W}px;text-align:center}
.lab .s{font-weight:700;font-size:40px}
.lab .m{font-weight:600;font-size:30px;color:rgba(220,230,255,.75)}
.big{position:absolute;top:${380 + H + 140}px;width:${W}px;text-align:center}
.big .n{font-size:150px}
.big b{display:block;font-weight:700;font-size:34px;margin-top:4px}`;
  const body = `<div class="stage" id="${p}-stage">${ph.html}
  ${head(p, 'แผนเดียวกัน', facts.mu_2026.by_formation['4-2-3-1'] ? '4-2-3-1' : '')}
  <div class="col" style="left:100px">${A.html}</div>
  <div class="col" id="${p}-bpit" style="left:580px">${Bp.html}</div>
  <div class="lab" id="${p}-a0" style="left:100px"><div class="s">2025-26 ช่วงแรก</div><div class="m">${esc(D.early_formation)} · ${D.early_played} นัด · ${D.ppg_early.toFixed(1)} แต้ม/นัด</div></div>
  <div class="lab" id="${p}-al" style="left:100px"><div class="s">2025-26 ช่วงหลัง</div><div class="m">ใช้แผนนี้ ${D.last_played} นัด</div></div>
  <div class="lab" id="${p}-bl" style="left:580px"><div class="s">2026-27</div><div class="m">ใช้แผนนี้ ${D.now_played} นัด</div></div>
  <div class="big" id="${p}-an" style="left:100px"><div class="n up">${D.ppg_last.toFixed(1)}</div><b>แต้มต่อนัด</b></div>
  <div class="big" id="${p}-bn" style="left:580px"><div class="n dn">${D.ppg_now.toFixed(1)}</div><b>แต้มต่อนัด</b></div>
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>${ph.cred}`;
  return scene(p, css, body, B.js());
}

function buildDefence(TL, sc, P) {
  const { D, facts } = P, p = 'df', L = local(sc), T = sc.t1 - sc.t0;
  const B = TLB();
  const amb = ambient(p, T, 31); amb.tl.forEach((a) => B.ft(...a));
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const RISE = L(sc.marks.rise), L4 = L(sc.marks.last4), CS = L(sc.marks.cs);
  const last4 = facts.mu_2026.matches.slice(-4);
  const base = 1150, maxH = 400, maxV = 3, bw = 150, gap = 56, x0 = (1080 - (4 * bw + 3 * gap)) / 2;
  let bars = '';
  last4.forEach((m, k) => {
    const h = (m.xga / maxV) * maxH, x = x0 + k * (bw + gap);
    bars += `<div class="bar" id="${p}-b${k}" style="left:${x}px;top:${base - h}px;height:${h}px;width:${bw}px"></div>
      <div class="bv" id="${p}-v${k}" style="left:${x - 20}px;top:${base - h - 74}px;width:${bw + 40}px">${m.xga.toFixed(2)}</div>
      ${plate(`${p}-l${k}`, logo(m.opponent_id), 96, `left:${x + (bw - 96) / 2}px;top:${base + 22}px;`, 'rgba(120,160,255,.6)')}`;
    B.ft(`#${p}-b${k}`, { scaleY: 0 }, { scaleY: 1, duration: 0.45, ease: E.out }, L4 + 0.1 + k * 0.3);
    B.ft(`#${p}-v${k}`, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: E.pop }, L4 + 0.4 + k * 0.3);
    B.ft(`#${p}-l${k}`, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: E.pop }, L4 + k * 0.3);
  });
  const refY = base - (D.xga_last_exact / maxV) * maxH;
  B.ft(`#${p}-hd`, { y: -60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: E.pop }, 0.05);
  B.ft(`#${p}-cmp`, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, RISE - 0.25);
  B.ft(`#${p}-to`, { scale: 0.3, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.6)' }, RISE + 0.6);
  B.ft(`#${p}-flash`, { opacity: 0.35 }, { opacity: 0, duration: 0.45, ease: E.out }, RISE + 0.7);
  B.ft(`#${p}-ref`, { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.5, ease: E.out }, L4);
  B.ft(`#${p}-cs`, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.4)' }, CS - 0.05);
  B.ft(`#${p}-stage`, { opacity: 1, x: 0 }, { opacity: 0, x: -200, duration: 0.3, ease: E.in }, T - 0.3);
  const css = `${KIT_CSS}
.cmp{position:absolute;left:0;top:330px;width:1080px;text-align:center}
.cmp .lb{font-weight:700;font-size:40px;color:rgba(220,230,255,.85)}
.cmp .row{display:flex;justify-content:center;align-items:center;gap:30px;margin-top:6px}
.cmp .n{font-size:150px}
.cmp .ar{font-size:90px;color:#fbbf24}
.cmp small{display:block;font-weight:600;font-size:28px;color:rgba(220,230,255,.65);font-family:Plex}
.bar{position:absolute;border-radius:16px 16px 4px 4px;background:linear-gradient(180deg,#f87171,#991b1b);transform-origin:50% 100%;box-shadow:0 0 30px rgba(248,113,113,.4)}
.bv{position:absolute;text-align:center;font-family:Barlow;font-weight:900;font-size:60px}
.ref{position:absolute;left:110px;width:860px;top:${refY}px;border-top:4px dashed rgba(251,191,36,.85);transform-origin:0 50%}
.key{position:absolute;left:0;top:1284px;width:1080px;text-align:center;font-weight:600;font-size:28px;color:#fbbf24}
.cs{position:absolute;left:0;top:1336px;width:1080px;text-align:center}`;
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  ${head(p, 'การบ้านข้อ 1', 'เกมรับ')}
  <div class="cmp" id="${p}-cmp"><div class="lb">xG ที่คู่แข่งได้ ต่อนัด</div>
    <div class="row"><div><div class="n" style="color:#cbd5e1">${D.xga_last.toFixed(1)}</div><small>ช่วง 4-2-3-1 ฤดูกาลก่อน</small></div><div class="ar">→</div><div id="${p}-to"><div class="n dn">${D.xga_now.toFixed(1)}</div><small>2026-27</small></div></div></div>
  <div class="ref" id="${p}-ref"></div>
  ${bars}
  <div class="key">- - - ระดับฤดูกาลที่แล้ว ${D.xga_last_exact.toFixed(2)} · 4 นัดหลังสุด</div>
  <div class="cs" id="${p}-cs"><span class="chip" style="font-size:44px;box-shadow:inset 0 0 0 3px #f87171">คลีนชีต <b class="dn" style="font-family:Barlow;font-size:56px;margin:0 6px">${D.clean}</b> จาก ${D.played} นัด</span></div>
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>`;
  return scene(p, css, body, B.js());
}

function buildLeads(TL, sc, P) {
  const { D, facts } = P, p = 'ld', L = local(sc), T = sc.t1 - sc.t0;
  const B = TLB();
  const amb = ambient(p, T, 41); amb.tl.forEach((a) => B.ft(...a));
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const EQ = L(sc.marks.eq), LATE = L(sc.marks.late), TOT = L(sc.marks.total);
  const X0 = 250, XW = 680, MAXM = 95;
  const xOf = (m) => X0 + (Math.min(m, MAXM) / MAXM) * XW;
  let cards = '';
  facts.mu_2026.led_not_won_list.forEach((m, k) => {
    const top = 330 + k * 250, at = L(sc.marks[`s${k}`]);
    let a = 0, b = 0, ledFrom = null, segs = '', marks = '', prevM = -99, below = false;
    m.goals.forEach((g, j) => {
      below = minuteOf(g) - prevM < 7 ? !below : false; prevM = minuteOf(g);
      const was = a - b; g.forUs ? a++ : b++;
      if (a - b > 0 && ledFrom == null) ledFrom = minuteOf(g);
      if (a - b <= 0 && was > 0) { segs += `<div class="lead" style="left:${xOf(ledFrom)}px;width:${xOf(minuteOf(g)) - xOf(ledFrom)}px"></div>`; ledFrom = null; }
      const late = !g.forUs && minuteOf(g) >= 90, eq = !g.forUs && a - b === 0;
      marks += `<div class="gm ${g.forUs ? 'f' : 'a'}${eq ? ' eq' : ''}${late ? ' late' : ''}${below ? ' lo' : ''}" id="${p}-g${k}_${j}" style="left:${xOf(minuteOf(g)) - 24}px"><i></i><span>${esc(g.minute)}′</span></div>`;
      if (eq) B.ft(`#${p}-g${k}_${j}`, { scale: 1 }, { scale: 1.35, duration: 0.18, ease: E.out, repeat: 1, yoyo: true }, EQ + k * 0.12);
      if (late) B.ft(`#${p}-g${k}_${j} i`, { boxShadow: '0 0 0 0 rgba(248,113,113,0)' }, { boxShadow: '0 0 0 12px rgba(248,113,113,.45)', duration: 0.3 }, LATE + 0.2);
    });
    cards += `<div class="card" id="${p}-c${k}" style="left:60px;top:${top}px;width:960px;height:220px">
      ${plate(`${p}-cl${k}`, logo(m.opponent_id), 120, 'left:34px;top:30px;', 'rgba(120,160,255,.6)')}
      <div class="op">${m.venue === 'home' ? 'เหย้า' : 'เยือน'} · ${esc(m.opponent)} · <b>จบ ${esc(m.final)}</b></div>
      <div class="ln"><div class="tk" style="left:${X0}px">0′</div><div class="tk" style="left:${xOf(45)}px">45′</div><div class="tk" style="left:${X0 + XW + 34}px">90′</div><div class="rail" style="left:${X0}px;width:${XW}px"></div>${segs}${marks}</div></div>`;
    B.ft(`#${p}-c${k}`, { x: 1100, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: E.out }, at - 0.2);
  });
  B.ft(`#${p}-hd`, { y: -60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: E.pop }, 0.05);
  B.ft(`#${p}-tot`, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.2)' }, TOT + 0.05);
  B.ft(`#${p}-flash`, { opacity: 0.4 }, { opacity: 0, duration: 0.5, ease: E.out }, TOT + 0.2);
  B.ft(`#${p}-stage`, { opacity: 1, x: 0 }, { opacity: 0, x: -200, duration: 0.3, ease: E.in }, T - 0.3);
  const css = `${KIT_CSS}
.card .op{position:absolute;left:190px;top:26px;font-weight:600;font-size:34px;color:rgba(220,230,255,.85);white-space:nowrap}
.card .op b{color:#fff}
.ln{position:absolute;left:-60px;top:0;width:1080px;height:220px}
.rail{position:absolute;top:140px;height:10px;border-radius:5px;background:rgba(120,160,255,.25)}
.lead{position:absolute;top:136px;height:18px;border-radius:9px;background:linear-gradient(90deg,#22c55e,#4ade80);box-shadow:0 0 16px rgba(74,222,128,.6)}
.tk{position:absolute;top:186px;margin-left:-20px;font-family:Barlow;font-weight:800;font-size:24px;color:rgba(220,230,255,.45)}
.gm{position:absolute;top:121px;width:48px;height:48px}
.gm i{position:absolute;inset:0;border-radius:50%;border:4px solid #fff}
.gm.f i{background:#16a34a}.gm.a i{background:#dc2626}
.gm span{position:absolute;left:-16px;top:-42px;width:80px;text-align:center;font-family:Barlow;font-weight:900;font-size:30px}
.gm.lo span{top:50px}
.gm.f span{color:#86efac}.gm.a span{color:#fca5a5}
.tot{position:absolute;left:0;top:1110px;width:1080px;display:flex;justify-content:center;align-items:center;gap:26px}
.tot .lb{font-weight:700;font-size:56px}
.tot .n{font-size:170px}
.key{position:absolute;left:0;top:1310px;width:1080px;text-align:center;font-weight:600;font-size:28px;color:rgba(220,230,255,.65)}`;
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  ${head(p, 'การบ้านข้อ 2', 'รักษาสกอร์ไม่อยู่')}
  ${cards}
  <div class="tot" id="${p}-tot"><div class="lb">แต้มที่หายไป</div><div class="n dn">−${D.lost}</div></div>
  <div class="key"><span style="color:#4ade80">■</span> ช่วงที่แมนยูนำ · <span style="color:#86efac">●</span> แมนยูยิง · <span style="color:#fca5a5">●</span> โดนยิง</div>
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>`;
  return scene(p, css, body, B.js());
}

function buildShots(TL, sc, P) {
  const { D, spot } = P, p = 'sh', L = local(sc), T = sc.t1 - sc.t0;
  const B = TLB();
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const ph = photo(B, p, spot.photos.shots, creditOf(P, 'shots'), T, { pos: '50% 20%', shade: 'linear-gradient(180deg,rgba(2,6,15,.75) 0%,rgba(2,6,15,.55) 30%,rgba(2,6,15,.88) 55%,#02060f 80%)' });
  const NOW = L(sc.marks.now), WAS = L(sc.marks.was), XG = L(sc.marks.xg);
  const BW = 760;
  B.ft(`#${p}-hd`, { y: -60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: E.pop }, 0.05);
  B.ft(`#${p}-now`, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.4)' }, NOW);
  B.ft(`#${p}-was`, { x: -60, opacity: 0 }, { x: 0, opacity: 1, duration: 0.4, ease: E.pop }, WAS - 0.05);
  B.ft(`#${p}-xb`, { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: E.out }, XG - 0.1);
  B.ft(`#${p}-gb`, { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: E.out }, XG + 0.25);
  B.ft(`#${p}-gap`, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.4)' }, XG + 0.8);
  B.ft(`#${p}-flash`, { opacity: 0.3 }, { opacity: 0, duration: 0.45, ease: E.out }, XG + 0.85);
  B.ft(`#${p}-stage`, { opacity: 1, x: 0 }, { opacity: 0, x: -200, duration: 0.3, ease: E.in }, T - 0.3);
  const css = `${KIT_CSS}
.now{position:absolute;left:0;top:520px;width:1080px;text-align:center}
.now .n{font-size:240px;color:#fbbf24;text-shadow:0 10px 0 #6b3303,0 24px 50px rgba(0,0,0,.6)}
.now b{display:block;font-weight:700;font-size:46px}
.was{position:absolute;left:0;top:880px;width:1080px;text-align:center}
.bars{position:absolute;left:160px;top:1020px;width:${BW}px}
.br{position:relative;height:96px;margin-bottom:28px}
.br .f{position:absolute;left:0;top:0;height:96px;border-radius:14px;transform-origin:0 50%}
.br .t{position:absolute;left:24px;top:22px;font-weight:700;font-size:38px;white-space:nowrap}
.br .v{position:absolute;right:24px;top:8px;font-family:Barlow;font-weight:900;font-size:70px;line-height:1}
.gap{position:absolute;left:0;top:1280px;width:1080px;text-align:center}`;
  const gw = (D.goals_now / D.xg_sum) * BW;
  const body = `<div class="stage" id="${p}-stage">${ph.html}
  ${head(p, 'การบ้านข้อ 3', 'ยิงเยอะแต่ไม่คม')}
  <div class="now" id="${p}-now"><div class="n">${D.shots_now_exact.toFixed(1)}</div><b>ครั้งต่อนัด ฤดูกาลนี้</b></div>
  <div class="was" id="${p}-was"><span class="chip">ช่วง 4-2-3-1 ฤดูกาลก่อน ${D.shots_last} ครั้งต่อนัด</span></div>
  <div class="bars">
    <div class="br"><div class="f" id="${p}-xb" style="width:${BW}px;background:linear-gradient(90deg,#b45309,#fbbf24)"><div class="t">ประตูที่ควรได้ (xG)</div><div class="v">${D.xg_sum.toFixed(2)}</div></div></div>
    <div class="br"><div class="f" id="${p}-gb" style="width:${gw}px;background:linear-gradient(90deg,#7f1d1d,#ef4444)"><div class="t">ประตูจริง</div><div class="v">${D.goals_now}</div></div></div>
  </div>
  <div class="gap" id="${p}-gap"><span class="chip" style="font-size:42px;box-shadow:inset 0 0 0 3px #f87171">ต่ำกว่าที่ควรได้ <b class="dn" style="font-family:Barlow;font-size:54px;margin-left:8px">${D.below_xg.toFixed(2)}</b> ลูก</span></div>
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>${ph.cred}`;
  return scene(p, css, body, B.js());
}

function buildCoach(TL, sc, P) {
  const { D, spot } = P, p = 'co', L = local(sc), T = sc.t1 - sc.t0;
  const B = TLB();
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const ph = photo(B, p, spot.photos.coach, creditOf(P, 'coach'), T, { pos: '62% 30%', box: 'left:0;top:0;width:1080px;height:980px', shade: 'linear-gradient(180deg,rgba(2,6,15,.35) 0%,rgba(2,6,15,0) 18%,rgba(2,6,15,0) 34%,rgba(2,6,15,.85) 48%,#02060f 56%)' });
  const sp = sparks(p, 's', 30, 61);
  const ASK = L(sc.marks.ask), CHE = L(sc.marks.che), FIRST = L(sc.marks.first), MISS = L(sc.marks.miss), SEC = L(sc.marks.second);
  const base = 1360, maxH = 300, maxV = 2.2;
  const h1 = (D.che_first / maxV) * maxH, h2 = (D.che_second / maxV) * maxH;
  B.ft(`#${p}-q`, { y: -40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, ASK - 0.1);
  B.ft(`#${p}-che`, { x: -100, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: E.out }, CHE - 0.1);
  B.ft(`#${p}-b1`, { scaleY: 0 }, { scaleY: 1, duration: 0.5, ease: E.out }, FIRST);
  B.ft(`#${p}-v1`, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: E.pop }, FIRST + 0.35);
  B.ft(`#${p}-miss`, { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: 'back.out(2.4)' }, MISS);
  B.ft(`#${p}-b2`, { scaleY: 0 }, { scaleY: 1, duration: 0.55, ease: E.out }, SEC);
  B.ft(`#${p}-v2`, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: E.pop }, SEC + 0.4);
  B.ft(`#${p}-flash`, { opacity: 0.45 }, { opacity: 0, duration: 0.5, ease: E.out }, SEC + 0.45);
  sp.burst(B, SEC + 0.45, 760, base - h2);
  B.ft(`#${p}-stage`, { opacity: 1, x: 0 }, { opacity: 0, x: -200, duration: 0.3, ease: E.in }, T - 0.3);
  const css = `${KIT_CSS}
.q{position:absolute;right:40px;top:690px}
.che{position:absolute;left:60px;top:840px;width:960px;height:150px}
.che .t{position:absolute;left:170px;top:14px;font-weight:700;font-size:46px;white-space:nowrap}
.che .s{position:absolute;left:170px;top:78px;font-weight:600;font-size:32px;color:rgba(220,230,255,.8);white-space:nowrap}
.bar{position:absolute;width:220px;border-radius:18px 18px 4px 4px;transform-origin:50% 100%}
.bv{position:absolute;width:300px;text-align:center}
.bv .n{font-size:96px}
.bv b{display:block;font-weight:700;font-size:32px;margin-top:2px}
.base{position:absolute;left:120px;width:840px;top:${base}px;height:4px;background:rgba(220,230,255,.3)}
.miss{position:absolute;left:60px;top:${base + 20}px}`;
  const body = `<div class="stage" id="${p}-stage">${ph.html}
  <div class="q" id="${p}-q"><span class="pill" style="font-size:50px">เคยเจอแบบนี้ไหม?</span></div>
  <div class="che" id="${p}-che">${plate(`${p}-cl`, logo(spot.coach.prev_team_id), 140, 'left:0;top:5px;', '#5b8cff')}<div class="t">${esc(spot.coach.prev_team)} ${esc(spot.coach.prev_season)}</div><div class="s">ใช้ 4-2-3-1 ${D.che_4231} จาก ${D.che_played} นัด</div></div>
  <div class="bar" id="${p}-b1" style="left:250px;top:${base - h1}px;height:${h1}px;background:linear-gradient(180deg,#f87171,#991b1b)"></div>
  <div class="bv" id="${p}-v1" style="left:210px;top:${base - h1 - 150}px"><div class="n dn">${D.che_first.toFixed(1)}</div><b>ครึ่งฤดูกาลแรก</b></div>
  <div class="bar" id="${p}-b2" style="left:610px;top:${base - h2}px;height:${h2}px;background:linear-gradient(180deg,#4ade80,#15803d)"></div>
  <div class="bv" id="${p}-v2" style="left:570px;top:${base - h2 - 150}px"><div class="n up">${D.che_second.toFixed(1)}</div><b>ครึ่งหลัง</b></div>
  <div class="base"></div>
  <div class="miss" id="${p}-miss"><span class="chip" style="font-size:32px">ครึ่งแรก ประตูต่ำกว่า xG ${D.che_miss.toFixed(2)} ลูก</span></div>
  ${sp.html}
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>${ph.cred}`;
  return scene(p, css, body, B.js());
}

function buildLean(TL, sc, P) {
  const { D, spot } = P, p = 'le', L = local(sc), T = sc.t1 - sc.t0;
  const B = TLB();
  const ph = photo(B, p, spot.photos.lean, creditOf(P, 'lean'), T, { pos: '50% 15%', shade: 'linear-gradient(180deg,rgba(2,6,15,.25) 0%,rgba(2,6,15,.15) 25%,rgba(2,6,15,.88) 45%,#02060f 62%)' });
  const KEEP = L(sc.marks.keep), POSS = L(sc.marks.poss), DEF = L(sc.marks.def), CHE = L(sc.marks.che);
  B.ft(`#${p}-tag`, { x: -80, opacity: 0 }, { x: 0, opacity: 1, duration: 0.4, ease: E.out }, 0.1);
  B.ft(`#${p}-c0`, { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, KEEP - 0.1);
  B.ft(`#${p}-c1`, { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, POSS - 0.1);
  B.ft(`#${p}-c2`, { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, DEF - 0.1);
  B.ft(`#${p}-c2x`, { opacity: 0, x: 40 }, { opacity: 1, x: 0, duration: 0.35, ease: E.pop }, CHE + 0.3);
  B.ft(`#${p}-stage`, { opacity: 1, x: 0 }, { opacity: 0, x: -200, duration: 0.3, ease: E.in }, T - 0.3);
  const css = `${KIT_CSS}
.tag{position:absolute;left:50px;top:110px;padding:12px 28px 16px;border-radius:16px;background:rgba(2,6,15,.75);box-shadow:inset 0 0 0 3px #fbbf24}
.tag b{display:block;font-weight:700;font-size:42px;color:#fbbf24}
.tag span{font-weight:600;font-size:28px;color:rgba(220,230,255,.8)}
.lc{position:absolute;left:60px;width:960px;height:150px;border-radius:26px;background:linear-gradient(90deg,rgba(16,36,86,.95),rgba(5,12,34,.95));box-shadow:inset 0 0 0 3px rgba(120,160,255,.3)}
.lc .i{position:absolute;left:30px;top:30px;width:90px;height:90px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:48px}
.lc .t{position:absolute;left:150px;top:22px;font-weight:700;font-size:44px;white-space:nowrap}
.lc .s{position:absolute;left:150px;top:84px;font-weight:600;font-size:32px;color:rgba(220,230,255,.8);white-space:nowrap}
.lc.r{box-shadow:inset 0 0 0 4px #f87171;background:linear-gradient(90deg,rgba(127,29,29,.95),rgba(40,8,8,.95))}`;
  const body = `<div class="stage" id="${p}-stage">${ph.html}
  <div class="tag" id="${p}-tag"><b>มุมมองจากข้อมูล</b><span>ประเมินจาก${esc(spot.coach.prev_team)} ${esc(spot.coach.prev_season)} ไม่ใช่ข้อสรุป</span></div>
  <div class="lc" id="${p}-c0" style="top:880px"><div class="i" style="background:#16a34a">✓</div><div class="t">น่าจะคงแผน 4-2-3-1</div><div class="s">${esc(spot.coach.prev_team)}ยุคเขาใช้ ${D.che_4231} จาก ${D.che_played} นัด</div></div>
  <div class="lc" id="${p}-c1" style="top:1050px"><div class="i" style="background:#2563eb">⚽</div><div class="t">ครองบอลมากขึ้น</div><div class="s">แมนยูตอนนี้ ${D.poss_now}% · ${esc(spot.coach.prev_team)}ยุคเขา ${D.che_poss}%</div></div>
  <div class="lc r" id="${p}-c2" style="top:1220px"><div class="i" style="background:#dc2626">!</div><div class="t">เกมรับ ยังต้องพิสูจน์</div><div class="s" id="${p}-c2x">${esc(spot.coach.prev_team)}ยุคเขาเสีย xG ${D.che_xga.toFixed(2)} ต่อนัด</div></div>
</div><div class="vig"></div>${ph.cred}`;
  return scene(p, css, body, B.js());
}

function buildOutro(TL, sc, P) {
  const { D, facts, spot } = P, p = 'ou', L = local(sc), T = sc.t1 - sc.t0;
  const B = TLB();
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  const ph = photo(B, p, spot.photos.outro, creditOf(P, 'outro'), T, { pos: '50% 50%', shade: 'linear-gradient(180deg,rgba(2,6,15,.55),rgba(2,6,15,.75) 40%,rgba(2,6,15,.93) 70%,#02060f)' });
  const sp = sparks(p, 's', 40, 333);
  const NEXT = L(sc.marks.next), ASK = L(sc.marks.ask), COM = L(sc.marks.comment), FOL = L(sc.marks.follow), LOGO = L(TL.logoAt);
  const nm = facts.next_match;
  B.ft(`#${p}-fx`, { y: -60, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: E.pop }, NEXT - 0.1);
  B.ft(`#${p}-q`, { y: 80, scale: 0.8, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.5, ease: E.pop }, ASK - 0.05);
  for (let k = 0; k < 3; k++) B.ft(`#${p}-o${k}`, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.35, ease: E.pop }, ASK + 0.3 + k * 0.15);
  B.ft(`#${p}-cm`, { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, COM - 0.05);
  B.ft(`#${p}-fo`, { y: 60, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.pop }, FOL - 0.05);
  B.ft(`#${p}-fob`, { scale: 1 }, { scale: 1.08, duration: 0.22, ease: 'sine.inOut', repeat: 3, yoyo: true }, FOL + 0.35);
  B.ft(`#${p}-url`, { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(2.2)' }, FOL + 0.4);
  B.ft(`#${p}-cta`, { opacity: 1, scale: 1 }, { opacity: 0, scale: 0.9, duration: 0.3, ease: E.in }, LOGO - 0.3);
  B.ft(`#${p}-dim`, { opacity: 0 }, { opacity: 1, duration: 0.4 }, LOGO - 0.3);
  B.ft(`#${p}-rays`, { opacity: 0, scale: 0.8, rotation: 0 }, { opacity: 0.9, scale: 1, rotation: (T - LOGO) * 14, duration: T - LOGO, ease: 'none' }, LOGO);
  B.ft(`#${p}-brand`, { y: 120, scale: 0.6, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.8, ease: E.pop }, LOGO + 0.05);
  B.ft(`#${p}-sheen`, { x: -300 }, { x: 1100, duration: 0.8, ease: E.io }, LOGO + 0.6);
  B.ft(`#${p}-tag`, { y: 50, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: E.pop }, LOGO + 0.6);
  B.ft(`#${p}-flash`, { opacity: 0.6 }, { opacity: 0, duration: 0.5, ease: E.out }, LOGO + 0.3);
  sp.burst(B, LOGO + 0.3, 540, 860);
  const css = `${KIT_CSS}
.cta{position:absolute;inset:0;transform-origin:540px 800px}
.fx{position:absolute;left:90px;top:150px;width:900px;height:330px;border-radius:36px;background:linear-gradient(180deg,rgba(16,36,86,.94),rgba(5,12,34,.96));box-shadow:inset 0 0 0 4px rgba(251,191,36,.7),0 24px 60px rgba(0,0,0,.6)}
.fx .k{position:absolute;left:0;top:24px;width:900px;text-align:center;font-weight:700;font-size:36px;color:#fbbf24}
.fx .vs{position:absolute;left:0;top:120px;width:900px;text-align:center;font-family:Barlow;font-weight:900;font-size:80px}
.fx .w{position:absolute;left:0;top:250px;width:900px;text-align:center;font-weight:700;font-size:40px}
.q{position:absolute;left:110px;top:560px;width:860px;padding:34px 40px 40px;border-radius:44px 44px 44px 10px;background:#fff;color:#0b1324;font-weight:700;font-size:60px;line-height:1.25;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.5)}
.q b{color:#d9730a}
.opts{position:absolute;left:0;top:820px;width:1080px;display:flex;justify-content:center;gap:16px}
.opts .chip{font-size:36px}
.cm{position:absolute;left:0;top:960px;width:1080px;text-align:center}
.fo{position:absolute;left:0;top:1090px;width:1080px;text-align:center}
.fo .b{display:inline-block;padding:20px 60px 26px;border-radius:999px;background:linear-gradient(180deg,#ffd166,#f59e0b 60%,#d9730a);color:#1a0d00;font-weight:700;font-size:58px;box-shadow:0 8px 0 #7a3a04,0 20px 50px rgba(245,158,11,.45);white-space:nowrap}
.url{position:absolute;left:0;top:1250px;width:1080px;text-align:center}
.url .u{display:inline-block;padding:18px 46px 22px;border-radius:28px;background:#0b1d4a;box-shadow:inset 0 0 0 5px #fbbf24,0 20px 50px rgba(0,0,0,.5);font-family:Barlow;font-weight:800;font-size:66px;white-space:nowrap}
.url .u b{color:#fbbf24}
.dim{position:absolute;inset:0;background:radial-gradient(120% 70% at 50% 38%,#10306e 0%,#0a1b45 38%,#050d24 70%,#02060f 100%);opacity:0}
.rays{position:absolute;left:-360px;top:0;width:1800px;height:1800px;background:repeating-conic-gradient(from 0deg,rgba(251,191,36,.22) 0deg 5deg,rgba(251,191,36,0) 5deg 15deg);-webkit-mask:radial-gradient(closest-side,#000 0%,rgba(0,0,0,.6) 40%,transparent 75%);mask:radial-gradient(closest-side,#000 0%,rgba(0,0,0,.6) 40%,transparent 75%);mix-blend-mode:screen}
.brand{position:absolute;left:120px;top:700px;width:840px;height:250px;border-radius:44px;background:linear-gradient(180deg,#fff,#eef3fb);box-shadow:0 0 0 6px rgba(251,191,36,.95),0 0 0 12px #3a2203,0 30px 80px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;overflow:hidden}
.brand img{width:760px}
.brand .sheen{position:absolute;top:-20px;bottom:-20px;width:220px;left:0;background:linear-gradient(100deg,rgba(255,255,255,0),rgba(255,255,255,.85),rgba(255,255,255,0));transform:skewX(-18deg)}
.btag{position:absolute;left:0;top:1020px;width:1080px;text-align:center;font-weight:700;font-size:58px;text-shadow:0 4px 0 #04102e,0 10px 30px rgba(0,0,0,.7)}`;
  const hh = String(D.ko_hh).padStart(2, '0'), mm = String(D.ko_mm).padStart(2, '0');
  const body = `<div class="stage" id="${p}-stage">${ph.html}
  <div class="cta" id="${p}-cta">
    <div class="fx" id="${p}-fx"><div class="k">บททดสอบแรก · พรีเมียร์ลีก</div>
      ${plate(`${p}-h`, logo(nm.home_id), 130, 'left:60px;top:95px;')}${plate(`${p}-a`, logo(nm.away_id), 130, 'left:710px;top:95px;')}
      <div class="vs">VS</div><div class="w">${esc(D.ko_wd)} ${D.ko_day} ${esc(D.ko_month)} · ${hh}:${mm} น. · แอนฟิลด์</div></div>
    <div class="q" id="${p}-q">คุณว่าต้องแก้<br><b>ข้อไหนก่อน?</b></div>
    <div class="opts"><span class="chip" id="${p}-o0">1 เกมรับ</span><span class="chip" id="${p}-o1">2 รักษาสกอร์</span><span class="chip" id="${p}-o2">3 ปลายทาง</span></div>
    <div class="cm" id="${p}-cm"><span class="chip" style="font-size:48px">คอมเมนต์บอกเรา</span></div>
    <div class="fo" id="${p}-fo"><div class="b" id="${p}-fob">กดติดตาม เข็มทิศฟุตบอล</div></div>
    <div class="url" id="${p}-url"><div class="u">khemthit<b>football</b>.com</div></div>
  </div>
  <div class="dim" id="${p}-dim"></div>
  <div class="rays" id="${p}-rays" style="opacity:0"></div>
  <div class="brand" id="${p}-brand"><img src="${BRAND('logo-lockup.webp')}" alt=""><div class="sheen" id="${p}-sheen"></div></div>
  <div class="btag" id="${p}-tag">อ่านเกมด้วยข้อมูลจริง</div>
  ${sp.html}
</div><div class="flash" id="${p}-flash"></div><div class="vig"></div>${ph.cred}`;
  return scene(p, css, body, B.js());
}

function thDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return `${d} ${M[m - 1]} ${String(y + 543).slice(2)}`;
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
.cbg{position:absolute;left:0;top:1420px;width:1080px;height:340px;background:radial-gradient(60% 50% at 50% 50%,rgba(2,6,20,.75),rgba(2,6,20,0))}
.grp{position:absolute;left:60px;top:1460px;width:960px;text-align:center;visibility:hidden;overflow:visible}
.grp .tx{font-weight:700;font-size:58px;line-height:1.34;color:#fff;text-shadow:0 4px 0 #04102e,0 0 2px #04102e,0 10px 28px rgba(0,0,0,.8)}
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

const BUILD = { hook: buildHook, plan: buildPlan, defence: buildDefence, leads: buildLeads, shots: buildShots, coach: buildCoach, lean: buildLean, outro: buildOutro };
const IDS = { hook: 'hk', plan: 'pl', defence: 'df', leads: 'ld', shots: 'sh', coach: 'co', lean: 'le', outro: 'ou' };

function buildProject(TL, P) {
  const { facts, spot } = P;
  fs.rmSync(path.join(HF, 'compositions'), { recursive: true, force: true });
  fs.mkdirSync(path.join(HF, 'compositions'), { recursive: true });
  for (const d of ['fonts', 'logos', 'brand', 'photos']) fs.mkdirSync(path.join(HF, 'assets', d), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'assets', 'fonts'))) fs.copyFileSync(path.join(ROOT, 'assets', 'fonts', f), path.join(HF, 'assets', 'fonts', f));
  const ids = new Set([facts.team.id, spot.coach.prev_team_id, facts.next_match.home_id, facts.next_match.away_id, ...facts.mu_2026.matches.map((m) => m.opponent_id)]);
  for (const id of ids) fs.copyFileSync(path.join(ROOT, logo(id)), path.join(HF, logo(id)));
  for (const f of new Set(Object.values(spot.photos))) fs.copyFileSync(path.join(DIR, 'photos', f), path.join(HF, 'assets', 'photos', f));
  fs.copyFileSync(path.join(REPO, 'apps', 'web', 'public', 'brand', 'logo-lockup.webp'), path.join(HF, 'assets', 'brand', 'logo-lockup.webp'));
  fs.copyFileSync(path.join(OUT, 'mix.wav'), path.join(HF, 'assets', 'mix.wav'));
  const hosts = [];
  for (const sc of TL.scenes) {
    const id = IDS[sc.role];
    fs.writeFileSync(path.join(HF, 'compositions', `${id}.html`), BUILD[sc.role](TL, sc, P));
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
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', out, '-vf', 'fps=1,scale=180:-1,tile=10x9', '-frames:v', '1', contact]);
  console.log(`${out}\n${Number(dur).toFixed(1)} s · ${loud} · rendered in ${((Date.now() - t0) / 60000).toFixed(1)} min\ncontact sheet: ${contact}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const P = prepare();
  if (step === 'check') return;
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

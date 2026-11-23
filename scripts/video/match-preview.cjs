// Big-match preview film (vertical, under 60 s, a new picture or effect at least every ~2 s): the stakes, the plans,
// the players to watch, what each side must watch out for, and a comment call. It never predicts the result.
// Inputs: insights/<slug>/facts.json (preview-fetch.cjs, the only source of numbers), insights/<slug>/spot.json (script +
//         shot list), insights/<slug>/photos/ + credits.json (freely licensed photos), insights/<slug>/gen/ (AI
//         atmosphere images: no real people, no crests; labelled on screen).
// usage: node match-preview.cjs <slug> check|stills|film|all
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { ROOT, REPO, readJson, writeJson } = require('./lib.cjs');
const { speak } = require('./tts.cjs');
const { kit, mixdown } = require('./audio.cjs');
const { r3, esc, TLB, E, FONTS, sparks, pitchSVG, scene, BRAND } = require('./hfkit.cjs');

const args = process.argv.slice(2);
const step = args.find((a) => ['check', 'stills', 'film', 'all'].includes(a)) || 'stills';
const slug = args.find((a) => a !== step);
if (!slug) { console.error('usage: node match-preview.cjs <slug> check|stills|film|all'); process.exit(1); }
const DIR = path.join(ROOT, 'insights', slug);
const OUT = path.join(DIR, 'out');
const HF = path.join(DIR, 'hf');
const FINAL = path.join(DIR, 'final');
const HFV = 'hyperframes@0.9.23';
const FPS = 30;
const TEMPO = 1.17;
const BRAND_DUR = 2.6;
const BANNED = ['ทีเด็ด', 'แทง', 'กำไร', 'ตามคู่นี้', 'การันตี', 'ชัวร์', 'แน่นอน', 'ได้เงิน', 'เสียเงิน', 'ราคาบอล', 'ฟันธง', 'ราคาต่อรอง', 'สูงต่ำ', 'ต่อ', 'รอง', 'Elo', 'xG'];
const BANNED_WORDS = (s) => BANNED.filter((w) => (w === 'ต่อ' || w === 'รอง' ? new RegExp(`(^|\\s)${w}(\\s|$)`).test(s) : s.includes(w)));
const TH_MONTH = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
const thDate = (iso) => { const d = new Date(iso); const t = new Date(d.getTime() + 7 * 3600e3); return `${t.getUTCDate()} ${TH_MONTH[t.getUTCMonth()]} ${String(t.getUTCFullYear() + 543).slice(2)}`; };
const LEAGUE_TH = { 39: 'พรีเมียร์ลีก', 48: 'ลีกคัพ', 45: 'เอฟเอ คัพ', 2: 'ยูฟ่า แชมเปียนส์ลีก', 3: 'ยูโรปาลีก' };
const RES_TH = { W: 'ชนะ', D: 'เสมอ', L: 'แพ้' };
const RES_COL = { W: '#22c55e', D: '#94a3b8', L: '#ef4444' };
const COL = { home: { main: '#c8102e', deep: '#4a0410', ring: '#f6c344', nick: 'หงส์แดง' }, away: { main: '#e3261b', deep: '#160404', ring: '#fbe122', nick: 'ปีศาจแดง' } };

// ---------- 1. script + facts ----------
function derive(facts, spot) {
  const H = facts.home, A = facts.away, ko = new Date(facts.fixture.kickoff_utc);
  const part = (o) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', ...o }).format(ko);
  const days = Math.round((Date.parse(facts.fixture.kickoff_utc.slice(0, 10)) - Date.parse(spot.news.coach_start)) / 864e5);
  return {
    gap: H.points - A.points, home_pts: H.points, away_pts: A.points, ko_hh: Number(part({ hour: '2-digit', hour12: false })), ko_mm: Number(part({ minute: '2-digit' })),
    coach_days: days, coach_w: facts.coach?.w, coach_n: facts.coach?.played,
    isak_share_total: H.gf, years: [...new Set(facts.h2h.map((m) => (new Date(m.date).getUTCFullYear() + 543) % 100))],
  };
}

function prepare() {
  const facts = readJson(path.join(DIR, 'facts.json'));
  const spot = readJson(path.join(DIR, 'spot.json'));
  const credits = readJson(path.join(DIR, 'photos', 'credits.json'));
  const D = derive(facts, spot);
  const errors = [];
  const ints = new Set((JSON.stringify(facts).match(/\d+/g) || []).map(Number));
  const derived = new Set(Object.values(D).flat().filter((v) => typeof v === 'number'));
  const ok = (n) => ints.has(n) || derived.has(n);
  const nums = (s) => (String(s).match(/\d+/g) || []).map(Number);
  const segs = spot.segments.map((g, i) => ({ ...g, i }));
  // the facts each claim rests on (fail loudly when the data changes under the script)
  const need = [[facts.away.w === 1 && facts.away.played === 10, 'MU 1 win in 10'], [facts.home.home.w === 1 && facts.home.home.played === 5, 'LIV 1 home win in 5'],
    [facts.h2h[0].winner === facts.away.id && facts.h2h[1].winner === facts.away.id, 'MU won the last two meetings'], [facts.home.formations['4-2-3-1'] === 10 && facts.away.formations['4-2-3-1'] === 10, 'both 4-2-3-1 x10'],
    [facts.coach.w === 0 && facts.coach.played === 3, 'Pochettino 0 wins in 3 v Liverpool'], [facts.home.leaders.goals.name === 'A. Isak' && facts.home.leaders.goals.value === 7 && facts.home.gf === 14, 'Isak 7 of 14'],
    [facts.home.leaders.key_passes.name === 'F. Wirtz' && facts.home.leaders.key_passes.value === 23, 'Wirtz 23 key passes, team high'],
    [facts.away.players.find((p) => p.name === 'Bruno Fernandes')?.goals === 4 && facts.away.players.find((p) => p.name === 'Bruno Fernandes')?.assists === 2, 'Bruno 4+2'],
    [facts.away.leaders.shots_on.name === 'B. Mbeumo' && facts.away.leaders.shots_on.value === 13, 'Mbeumo 13 on target, team high'], [facts.away.clean_sheets === 0, 'MU 0 clean sheets'],
    [facts.away.led_not_won.length === 3, 'MU led and did not win x3'], [facts.home.home.gf === 4 && facts.home.away.gf === 10, 'LIV 4 home goals, 10 away'],
    [['B. Šeško', 'M. Ugarte', 'C. Baleba'].every((n) => facts.away.out.find((x) => x.name === n)), 'MU out: Sesko Ugarte Baleba'],
    [['R. Gravenberch', 'J. Frimpong', 'H. Ekitike'].every((n) => facts.home.out.find((x) => x.name === n)), 'LIV out: Gravenberch Frimpong Ekitike'], [D.gap === 10, 'gap 10 points']];
  for (const [c, what] of need) if (!c) errors.push(`fact no longer holds: ${what}`);
  for (const g of segs) {
    for (const w of BANNED_WORDS(g.segment)) errors.push(`${g.role}: banned word "${w}"`);
    let cur = 0;
    for (const p of g.subs) {
      const ix = g.segment.indexOf(p.say, cur);
      if (ix < 0) errors.push(`${g.role}: subtitle "${p.say}" is not in the voice text (in order)`); else cur = ix + p.say.length;
      for (const h of p.hi || []) if (!p.show.includes(h)) errors.push(`${g.role}: highlight "${h}" is not in "${p.show}"`);
      for (const n of nums(p.show)) if (!ok(n)) errors.push(`${g.role}: "${n}" in "${p.show}" is not a number the facts give`);
    }
    for (const sh of g.shots) {
      if (sh.at && !g.segment.includes(sh.at)) errors.push(`${g.role}: shot at "${sh.at}" is not in the voice text`);
      for (const k of ['kicker', 'title', 'big', 'label', 'sub', 'text']) if (sh[k] != null) {
        for (const w of BANNED_WORDS(sh[k])) errors.push(`${g.role}/${sh.type}: banned word "${w}"`);
        for (const n of nums(sh[k])) if (!ok(n)) errors.push(`${g.role}/${sh.type}: "${n}" in "${sh[k]}" is not a number the facts give`);
      }
      if (sh.photo && !credits.find((c) => c.file === sh.photo && c.downloaded)) errors.push(`photo ${sh.photo} has no credit entry`);
      if (sh.gen && !fs.existsSync(path.join(DIR, 'gen', sh.gen))) errors.push(`gen image ${sh.gen} missing`);
    }
  }
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('derived', JSON.stringify(D));
  return { facts, spot, segs, D, credits };
}

// ---------- 2. voice ----------
async function voice(segs) {
  for (const g of segs) await speak(g.tag + g.segment, path.join(DIR, 'vo'), g.i, `preview ${g.role}`);
}

// ---------- 3. timeline ----------
function timeline({ segs }) {
  let clock = 0;
  const out = [], subs = [], shots = [];
  for (const g of segs) {
    const j = readJson(path.join(DIR, 'vo', `s${g.i}.json`));
    const a = j.alignment, chars = a.characters, text = chars.join('');
    if (text !== j.text) throw new Error(`s${g.i}: alignment text mismatch`);
    const tagEnd = text.indexOf(']') + 1;
    let first = tagEnd; while (!chars[first].trim()) first++;
    const speechStart = a.character_start_times_seconds[first], speechEnd = a.character_end_times_seconds.at(-1);
    const trim = Math.max(0, speechStart - 0.04);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(trim), '-i', path.join(DIR, 'vo', `s${g.i}.mp3`), '-af', `atempo=${TEMPO},aresample=48000`, '-ac', '1', path.join(DIR, 'vo', `s${g.i}_fast.wav`)]);
    const t0 = clock, at = clock + g.lead;
    const toFilm = (t) => at + (t - trim) / TEMPO;
    const charAt = (piece, from = tagEnd) => { const ix = text.indexOf(piece, from); if (ix < 0) throw new Error(`s${g.i}: "${piece}" not found`); return ix; };
    let cursor = tagEnd;
    for (const p of g.subs) {
      const ix = charAt(p.say, cursor), last = ix + p.say.length - 1;
      subs.push({ seg: g.i, show: p.show, hi: p.hi || [], t0: +toFilm(a.character_start_times_seconds[ix]).toFixed(3), t1: +toFilm(a.character_end_times_seconds[last]).toFixed(3) });
      cursor = last + 1;
    }
    const end = toFilm(speechEnd);
    out.push({ i: g.i, role: g.role, file: `vo/s${g.i}_fast.wav`, at: +at.toFixed(3), start: +toFilm(speechStart).toFixed(3), end: +end.toFixed(3) });
    for (const sh of g.shots) {
      const start = sh.after ? end + g.hold : sh.at ? toFilm(a.character_start_times_seconds[charAt(sh.at)]) - 0.1 : t0;
      shots.push({ ...sh, seg: g.i, role: g.role, t0: +start.toFixed(3) });
    }
    clock = end + g.hold;
  }
  const last = shots.at(-1);
  const T = +((last.type === 'brand' ? last.t0 : clock) + BRAND_DUR).toFixed(3);
  shots.forEach((s, k) => { s.k = k; s.t1 = k + 1 < shots.length ? shots[k + 1].t0 : T; s.dur = +(s.t1 - s.t0).toFixed(3); });
  const probe = shots.map((s) => +Math.min(T - 0.05, s.t0 + Math.min(s.dur * 0.7, 1.4)).toFixed(2));
  const TL = { slug, T, fps: FPS, frames: Math.round(T * FPS), tempo: TEMPO, segs: out, subs, shots, probe, logoAt: +(last.t0 + 0.35).toFixed(3) };
  writeJson(path.join(OUT, 'timeline.json'), TL);
  console.log(`${slug} T ${T}s · ${shots.length} shots · longest ${Math.max(...shots.map((s) => s.dur)).toFixed(2)}s`);
  console.log(shots.map((s) => `${String(s.k).padStart(2)} ${s.type.padEnd(7)} ${s.t0.toFixed(2)}  +${s.dur.toFixed(2)}`).join('\n'));
  return TL;
}

// ---------- 4. sound ----------
function sound(TL) {
  const T = TL.T + 0.8;
  const K = kit(T);
  const { mus, sfx, add, kick, noiseHit, snare, bassNote, chord, riser, whoosh, boom, crowd, bell, groove, audioLogo, fadeTail } = K;
  const at = (type) => TL.shots.filter((s) => s.type === type);
  // open: a crowd swell and a boom as the crests collide
  crowd(sfx, 0, 2.2, 0.12, (t) => Math.min(1, t / 0.4) * Math.exp(-Math.max(0, t - 1.2) * 1.5));
  riser(sfx, 0, 0.45, 0.3); boom(sfx, 0.45, 0.65); chord(mus, 0, 1.3, [57, 60, 64], 0.35, 900); bassNote(mus, 0, 1.3, 33, 0.3);
  // the beat from the first word to the brand; it drops out for the turn ("แต่...!")
  const glitch = at('glitch')[0];
  groove(1.2, glitch ? glitch.t0 : TL.logoAt, 0.6);
  if (glitch) {
    riser(sfx, glitch.t0 - 0.6, 0.6, 0.3); boom(sfx, glitch.t0, 0.6);
    for (let k = 0; k < 6; k++) noiseHit(sfx, glitch.t0 + k * 0.07, 0.05, 30, 9000, 2000, 0.25, k % 2 ? 0.5 : -0.5);
    groove(glitch.t1, TL.logoAt, 0.65);
  }
  for (const s of TL.shots) {
    if (s.k === 0 || s.type === 'brand' || s.type === 'glitch') continue;
    const pan = s.fx === 'whipL' ? -0.4 : s.fx === 'whipR' ? 0.4 : 0;
    whoosh(sfx, s.t0 - 0.12, 0.34, 0.32, pan);
    if (s.fx === 'punch' || s.fx === 'flash') kick(sfx, s.t0 + 0.02, 0.4);
    if (['bars', 'player', 'bignum', 'score', 'balls'].includes(s.type)) boom(sfx, s.t0 + (s.type === 'bars' ? 0.85 : 0.3), 0.35);
    if (s.type === 'warn') for (const d of [0.05, 0.45]) { noiseHit(sfx, s.t0 + d, 0.18, 9, 3000, 600, 0.3); bell(sfx, s.t0 + d, 70, 0.4, 0); }
    if (s.type === 'out') for (let n = 0; n < 3; n++) snare(sfx, s.t0 + 0.45 + n * 0.22, 0.4);
    if (s.type === 'flip') for (let n = 0; n < 3; n++) kick(sfx, s.t0 + 0.35 + n * 0.28, 0.3);
    if (s.type === 'grid' || s.type === 'balls') for (let n = 0; n < 10; n++) add(sfx, s.t0 + 0.2 + n * 0.05, (t) => Math.sin(2 * Math.PI * 2200 * t) * Math.exp(-t * 120), 0.05, 0.18);
    if (s.type === 'split') crowd(sfx, s.t0, 2.6, 0.16, (t) => Math.min(1, t / 0.3) * Math.exp(-Math.max(0, t - 1.4) * 1.2));
    if (s.dur > 2.2) kick(sfx, s.t0 + s.dur / 2, 0.25);
  }
  const brand = at('brand')[0];
  chord(mus, brand.t0 - 1.2, 1.2, [57, 60, 64, 69], 0.4, 900); riser(sfx, brand.t0 - 0.9, 0.9, 0.25);
  audioLogo(TL.logoAt, T);
  fadeTail();
  return { mus, sfx };
}

// ---------- 5. shots ----------
const logo = (id) => `assets/logos/teams-${id}.png`;
const plate = (id, src, size, pos = '', ring = '#f6c344') => `<div class="lp" id="${id}" style="${pos}width:${size}px;height:${size}px;box-shadow:0 0 0 ${Math.round(size / 26)}px ${ring},0 0 0 ${Math.round(size / 15)}px rgba(0,0,0,.6),0 ${Math.round(size / 12)}px ${Math.round(size / 4)}px rgba(0,0,0,.6)"><img src="${src}" alt=""></div>`;
const creditLine = (P, sh) => {
  if (sh.photo) { const c = P.credits.find((x) => x.file === sh.photo); return `ภาพ: ${c.author.replace(/^User:/, '')} · ${c.license} · Wikimedia Commons`; }
  if (sh.gen) return 'ภาพประกอบบรรยากาศสร้างด้วย AI';
  return '';
};
const CSS = `
.beat{position:absolute;inset:0;transform-origin:540px 800px}
.bgc{position:absolute;inset:0;background:radial-gradient(110% 70% at 50% 35%,#3a0a12 0%,#1a0508 45%,#0a0204 75%,#050102 100%)}
.ph{position:absolute;inset:0;overflow:hidden}
.ph img{width:100%;height:100%;object-fit:cover}
.shade{position:absolute;inset:0}
.lp{position:absolute;border-radius:50%;background:radial-gradient(circle at 38% 30%,#fff 0%,#f3f4f6 45%,#d6d9df 100%);display:flex;align-items:center;justify-content:center;overflow:hidden}
.lp img{width:66%;height:66%;object-fit:contain}
.kick{position:absolute;left:0;width:1080px;text-align:center}
.kick span{display:inline-block;padding:10px 30px 14px;border-radius:14px;background:linear-gradient(180deg,#ffd166,#f59e0b);color:#1a0d00;font-weight:700;font-size:40px;white-space:nowrap}
.ttl{position:absolute;left:40px;width:1000px;text-align:center;font-weight:700;line-height:1.12;text-shadow:0 6px 0 #1a0204,0 14px 40px rgba(0,0,0,.75)}
.n{font-family:Barlow;font-weight:900;line-height:.92}
.ttl.gold{text-shadow:none}
.cred{position:absolute;left:28px;right:28px;top:1874px;font-weight:600;font-size:21px;color:rgba(240,230,230,.7);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 2px 6px rgba(0,0,0,.9)}
.wflash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}
.rflash{position:absolute;inset:0;background:radial-gradient(circle at 50% 45%,rgba(255,60,60,.7),rgba(200,16,46,.2) 55%,rgba(0,0,0,0) 80%);mix-blend-mode:screen;opacity:0}
.streak{position:absolute;top:0;height:1920px;width:340px;background:linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.55),rgba(255,255,255,0));filter:blur(18px);opacity:0}
.card{position:absolute;border-radius:30px;background:linear-gradient(180deg,rgba(40,8,14,.94),rgba(12,2,4,.96));box-shadow:inset 0 0 0 3px rgba(255,120,120,.25),0 20px 50px rgba(0,0,0,.55)}
.chip{display:inline-block;padding:10px 26px 14px;border-radius:999px;font-weight:700;font-size:36px;white-space:nowrap}`;

/** A full-bleed picture with a fast punch-in that keeps drifting. */
function bgPicture(B, p, sh, dur, { filter = '', shade = 'linear-gradient(180deg,rgba(5,1,2,.25) 0%,rgba(5,1,2,.35) 40%,rgba(5,1,2,.9) 66%,#050102 100%)', pos } = {}) {
  const src = sh.photo ? `assets/photos/${sh.photo}` : `assets/gen/${sh.gen}`;
  B.ft(`#${p}-ph`, { scale: 1.22 }, { scale: 1.08, duration: 0.5, ease: E.out5 }, 0);
  B.ft(`#${p}-phi`, { scale: 1, x: 0 }, { scale: 1.07, x: sh.fx === 'whipR' ? -25 : 25, duration: dur, ease: 'none' }, 0);
  return `<div class="ph" id="${p}-ph"><img id="${p}-phi" src="${src}" style="object-position:${pos || sh.pos || '50% 40%'};${filter ? 'filter:' + filter : ''}" alt=""></div><div class="shade" style="background:${shade}"></div>`;
}
const kicker = (p, text, top) => (text ? `<div class="kick" id="${p}-k" style="top:${top}px"><span>${esc(text)}</span></div>` : '');
const popIn = (B, sel, at, from = { y: 60, opacity: 0, scale: 0.85 }) => B.ft(sel, from, { y: 0, opacity: 1, scale: 1, duration: 0.4, ease: E.pop }, at);
const slam = (B, sel, at) => { B.ft(sel, { scale: 2.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.32, ease: 'power4.in' }, at); };
const shake = (B, sel, at, n = 6, amp = 14) => { for (let k = 0; k < n; k++) B.set(sel, { x: (k % 2 ? -1 : 1) * amp * (1 - k / n), y: (k % 3 - 1) * amp * 0.6 * (1 - k / n) }, at + k * 0.035); B.set(sel, { x: 0, y: 0 }, at + n * 0.035); };
const BALL = (id, size, extra = '') => `<svg id="${id}" width="${size}" height="${size}" viewBox="0 0 100 100" style="${extra}"><circle cx="50" cy="50" r="46" fill="#f8fafc" stroke="#111" stroke-width="4"/><polygon points="50,30 66,42 60,61 40,61 34,42" fill="#111"/><path d="M50 30 L50 6 M66 42 L88 34 M60 61 L74 82 M40 61 L26 82 M34 42 L12 34" stroke="#111" stroke-width="4"/></svg>`;
const ICON = {
  glove: `<svg width="260" height="190" viewBox="0 0 260 190"><rect x="14" y="14" width="232" height="170" fill="none" stroke="#fff" stroke-width="12"/>${Array.from({ length: 7 }, (_, i) => `<line x1="${44 + i * 29}" y1="20" x2="${44 + i * 29}" y2="184" stroke="rgba(255,255,255,.35)" stroke-width="4"/>`).join('')}${Array.from({ length: 4 }, (_, i) => `<line x1="20" y1="${50 + i * 34}" x2="240" y2="${50 + i * 34}" stroke="rgba(255,255,255,.35)" stroke-width="4"/>`).join('')}</svg>`,
  clock: (p) => `<svg width="220" height="220" viewBox="0 0 220 220"><circle cx="110" cy="120" r="88" fill="rgba(0,0,0,.4)" stroke="#fff" stroke-width="12"/><rect x="96" y="8" width="28" height="22" rx="6" fill="#fff"/><g id="${p}-hand" style="transform-origin:110px 120px"><line x1="110" y1="120" x2="110" y2="52" stroke="#fbbf24" stroke-width="10" stroke-linecap="round"/></g><circle cx="110" cy="120" r="10" fill="#fbbf24"/></svg>`,
  home: `<svg width="230" height="210" viewBox="0 0 230 210"><path d="M20 100 L115 18 L210 100" fill="none" stroke="#fff" stroke-width="14" stroke-linejoin="round" stroke-linecap="round"/><path d="M45 92 V196 H185 V92" fill="rgba(0,0,0,.35)" stroke="#fff" stroke-width="12" stroke-linejoin="round"/><rect x="95" y="128" width="40" height="68" fill="#fbbf24"/></svg>`,
};

const SHOTS = {
  clash(B, p, sh, dur, P) {
    const { facts, D } = P, H = facts.home, A = facts.away;
    const sp = sparks(p, 'sp', 30, 7);
    B.ft(`#${p}-h`, { x: -700, rotation: -40 }, { x: 0, rotation: 0, duration: 0.45, ease: 'power4.in' }, 0);
    B.ft(`#${p}-a`, { x: 700, rotation: 40 }, { x: 0, rotation: 0, duration: 0.45, ease: 'power4.in' }, 0);
    B.ft(`#${p}-wf`, { opacity: 0.95 }, { opacity: 0, duration: 0.45, ease: E.out }, 0.45);
    shake(B, `#${p}-beat`, 0.45, 8, 22);
    sp.burst(B, 0.45, 540, 760);
    slam(B, `#${p}-vs`, 0.5);
    B.ft(`#${p}-h`, { x: 0 }, { x: -40, duration: dur - 0.6, ease: 'none' }, 0.6);
    B.ft(`#${p}-a`, { x: 0 }, { x: 40, duration: dur - 0.6, ease: 'none' }, 0.6);
    popIn(B, `#${p}-t`, 0.6); popIn(B, `#${p}-c`, 0.75);
    const hh = String(D.ko_hh).padStart(2, '0'), mm = String(D.ko_mm).padStart(2, '0');
    return {
      css: `.half{position:absolute;top:0;height:1920px;width:1080px}
.hl{background:linear-gradient(160deg,${COL.home.main},${COL.home.deep} 60%);clip-path:polygon(0 0,62% 0,38% 100%,0 100%)}
.hr{background:linear-gradient(200deg,#2a0606,${COL.away.deep} 40%,${COL.away.main} 120%);clip-path:polygon(62% 0,100% 0,100% 100%,38% 100%)}
.vsx{position:absolute;left:0;top:640px;width:1080px;text-align:center;font-size:250px}
.vt{position:absolute;left:0;top:1020px;width:1080px;text-align:center;font-weight:700;font-size:96px;text-shadow:0 6px 0 #1a0204,0 14px 40px rgba(0,0,0,.75)}
.vc{position:absolute;left:0;top:1170px;width:1080px;text-align:center}`,
      html: `<div class="half hl"></div><div class="half hr"></div><div class="streak" style="left:370px;opacity:.5;transform:skewX(-14deg)"></div>
${plate(`${p}-h`, logo(H.id), 330, 'left:90px;top:620px;', COL.home.ring)}${plate(`${p}-a`, logo(A.id), 330, 'left:660px;top:620px;', COL.away.ring)}
<div class="vsx n gold" id="${p}-vs">VS</div>
<div class="vt" id="${p}-t">ลิเวอร์พูล × แมนยู</div>
<div class="vc" id="${p}-c"><span class="chip" style="background:rgba(0,0,0,.6);box-shadow:inset 0 0 0 3px #fbbf24;font-size:44px">พรีเมียร์ลีก · คืนนี้ ${hh}:${mm} น.</span></div>${sp.html}`,
    };
  },
  photo(B, p, sh, dur) {
    const html = bgPicture(B, p, sh, dur, sh.big ? {} : {});
    if (sh.kicker) popIn(B, `#${p}-k`, 0.15);
    if (sh.big) slam(B, `#${p}-big`, 0.2);
    if (sh.title) popIn(B, `#${p}-t`, sh.big ? 0.45 : 0.25);
    const bigTop = 980, tTop = sh.big ? 1270 : 1150;
    return {
      css: `.pbig{position:absolute;left:0;top:${bigTop}px;width:1080px;text-align:center;font-size:${String(sh.big || '').length > 3 ? 230 : 290}px}`,
      html: `${html}${kicker(p, sh.kicker, sh.big ? 900 : 1060)}${sh.big ? `<div class="pbig n gold" id="${p}-big">${esc(sh.big)}</div>` : ''}${sh.title ? `<div class="ttl" id="${p}-t" style="top:${tTop}px;font-size:${sh.big ? 70 : 104}px">${esc(sh.title)}</div>` : ''}`,
    };
  },
  bars(B, p, sh, dur, P) {
    const H = P.facts.home, A = P.facts.away, max = Math.max(H.points, A.points), hMax = 600, base = 1180;
    const html = bgPicture(B, p, sh, dur, { filter: 'blur(3px) brightness(.45)', shade: 'linear-gradient(180deg,rgba(5,1,2,.4),rgba(5,1,2,.75))' });
    const bar = (side, team, x) => {
      const h = Math.round((team.points / max) * hMax);
      B.ft(`#${p}-b${side}`, { scaleY: 0 }, { scaleY: 1, duration: 0.8, ease: E.out }, 0.15);
      B.ft(`#${p}-n${side}`, { textContent: 0 }, { textContent: team.points, duration: 0.8, ease: E.out, snap: { textContent: 1 } }, 0.15);
      B.ft(`#${p}-nw${side}`, { y: h }, { y: 0, duration: 0.8, ease: E.out }, 0.15);
      return `<div class="bar" id="${p}-b${side}" style="left:${x}px;top:${base - h}px;height:${h}px;background:linear-gradient(180deg,${COL[side].main},${COL[side].deep})"></div>
<div class="bn" id="${p}-nw${side}" style="left:${x - 40}px;top:${base - h - 190}px"><div class="n" id="${p}-n${side}">${team.points}</div></div>
${plate(`${p}-l${side}`, logo(team.id), 150, `left:${x + 55}px;top:${base + 30}px;`, COL[side].ring)}`;
    };
    popIn(B, `#${p}-k`, 0.1); popIn(B, `#${p}-t`, 0.95);
    return {
      css: `.bar{position:absolute;width:260px;border-radius:24px 24px 0 0;transform-origin:50% 100%;box-shadow:0 0 60px rgba(200,16,46,.35)}
.bn{position:absolute;width:340px;text-align:center}.bn .n{font-size:180px}`,
      html: `${html}${kicker(p, sh.kicker, 170)}<div class="ttl gold" id="${p}-t" style="top:250px;font-size:110px">${esc(sh.title)}</div>${bar('home', H, 170)}${bar('away', A, 650)}`,
    };
  },
  grid(B, p, sh, dur, P) {
    const team = P.facts[sh.team], ms = team.matches.slice(-10);
    let cells = '';
    ms.forEach((m, n) => {
      const x = 75 + (n % 5) * 190, y = 520 + Math.floor(n / 5) * 270;
      cells += `<div class="gc" id="${p}-c${n}" style="left:${x}px;top:${y}px;box-shadow:inset 0 -10px 0 ${RES_COL[m.res]}"><img src="${logo(m.opponent_id)}" alt=""><div class="sc n">${m.gf}-${m.ga}</div><div class="rs" style="color:${RES_COL[m.res]}">${RES_TH[m.res]}</div></div>`;
      popIn(B, `#${p}-c${n}`, 0.12 + n * 0.05, { y: 40, opacity: 0, scale: 0.6 });
      if (m.res === 'W') { B.ft(`#${p}-c${n}`, { scale: 1 }, { scale: 1.18, duration: 0.3, ease: E.pop }, 0.95); B.ft(`#${p}-c${n}`, { boxShadow: `inset 0 -10px 0 ${RES_COL.W}, 0 0 0 0px rgba(251,191,36,0)` }, { boxShadow: `inset 0 -10px 0 ${RES_COL.W}, 0 0 0 8px rgba(251,191,36,1)`, duration: 0.3 }, 0.95); }
      else B.ft(`#${p}-c${n}`, { opacity: 1 }, { opacity: 0.4, duration: 0.3 }, 0.95);
    });
    popIn(B, `#${p}-t`, 1.0);
    return {
      css: `.gc{position:absolute;width:170px;height:240px;border-radius:22px;background:rgba(20,4,6,.9);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px}
.gc img{width:80px;height:80px;object-fit:contain;background:#fff;border-radius:50%;padding:8px}.gc .sc{font-size:62px}.gc .rs{font-weight:700;font-size:32px}`,
      html: `<div class="bgc"></div>${plate(`${p}-lg`, logo(team.id), 170, 'left:455px;top:250px;', COL[sh.team].ring)}${cells}<div class="ttl gold" id="${p}-t" style="top:1100px;font-size:120px">${esc(sh.title)}</div>`,
    };
  },
  glitch(B, p, sh, dur) {
    const html = bgPicture(B, p, sh, dur, { filter: 'brightness(.5) saturate(1.2)', shade: 'linear-gradient(180deg,rgba(5,1,2,.2),rgba(5,1,2,.6))' });
    slam(B, `#${p}-tx`, 0);
    B.ft(`#${p}-wf`, { opacity: 0.8 }, { opacity: 0, duration: 0.3 }, 0.28);
    shake(B, `#${p}-beat`, 0.3, 10, 26);
    const steps = Math.floor(Math.min(dur, 1.6) / 0.06);
    for (let k = 0; k < steps; k++) {
      const on = k < 10 || k % 5 === 0;
      B.set(`#${p}-r`, { x: on ? ((k * 37) % 30) - 15 : 0, opacity: on ? 0.85 : 0 }, k * 0.06);
      B.set(`#${p}-c`, { x: on ? -(((k * 53) % 30) - 15) : 0, opacity: on ? 0.85 : 0 }, k * 0.06);
      for (let s = 0; s < 3; s++) B.set(`#${p}-s${s}`, { x: on && (k + s) % 3 === 0 ? ((k * 31 + s * 47) % 120) - 60 : 0, opacity: on ? 1 : 0 }, k * 0.06);
    }
    const word = esc(sh.text);
    const bands = [[0, 70], [42, 40], [68, 12]];
    return {
      css: `.gl{position:absolute;left:0;top:640px;width:1080px;text-align:center;font-weight:700;font-size:300px;line-height:1.1}
.gl.r{color:#ff2a4a;mix-blend-mode:screen}.gl.c{color:#22e6ff;mix-blend-mode:screen}`,
      html: `${html}<div class="gl c" id="${p}-c">${word}</div><div class="gl r" id="${p}-r">${word}</div><div class="gl" id="${p}-tx" style="color:#fff;text-shadow:0 10px 40px rgba(0,0,0,.8)">${word}</div>
${bands.map(([a, b], s) => `<div class="gl" id="${p}-s${s}" style="color:#fff;clip-path:inset(${a}% 0 ${b}% 0);opacity:0">${word}</div>`).join('')}`,
    };
  },
  results(B, p, sh, dur, P) {
    const team = P.facts[sh.team], ms = team.matches.filter((m) => m.venue === sh.venue);
    const html = bgPicture(B, p, sh, dur, { filter: 'blur(3px) brightness(.45)', shade: 'linear-gradient(180deg,rgba(5,1,2,.4),rgba(5,1,2,.8))' });
    let chips = '';
    ms.forEach((m, n) => {
      chips += `<div class="rc" id="${p}-c${n}" style="left:${60 + n * 194}px"><img src="${logo(m.opponent_id)}" alt=""><div class="sc n">${m.gf}-${m.ga}</div><div class="rs" style="background:${RES_COL[m.res]}">${RES_TH[m.res]}</div></div>`;
      B.ft(`#${p}-c${n}`, { x: 500, opacity: 0 }, { x: 0, opacity: 1, duration: 0.35, ease: E.out }, 0.15 + n * 0.09);
    });
    popIn(B, `#${p}-ic`, 0.05); popIn(B, `#${p}-t`, 0.7);
    return {
      css: `.rc{position:absolute;top:640px;width:176px;height:300px;border-radius:24px;background:rgba(20,4,6,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;box-shadow:0 20px 40px rgba(0,0,0,.5)}
.rc img{width:92px;height:92px;object-fit:contain;background:#fff;border-radius:50%;padding:10px}.rc .sc{font-size:76px}.rc .rs{font-weight:700;font-size:32px;padding:4px 18px 8px;border-radius:999px;color:#fff}
.ic{position:absolute;left:425px;top:330px}`,
      html: `${html}<div class="ic" id="${p}-ic">${ICON.home}</div>${chips}<div class="ttl gold" id="${p}-t" style="top:1060px;font-size:112px">${esc(sh.title)}</div>`,
    };
  },
  score(B, p, sh, dur, P) {
    const m = P.facts.h2h[sh.h2h], homeSide = m.home_id === P.facts.home.id ? 'home' : 'away', awaySide = homeSide === 'home' ? 'away' : 'home';
    const [hg, ag] = m.score.split('-');
    const html = bgPicture(B, p, sh, dur, { filter: 'blur(4px) brightness(.4)', shade: 'linear-gradient(180deg,rgba(5,1,2,.3),rgba(5,1,2,.8))' });
    const dir = sh.fx === 'whipR' ? 1 : -1;
    B.ft(`#${p}-cd`, { x: dir * 900, rotation: dir * 8 }, { x: 0, rotation: 0, duration: 0.4, ease: E.out }, 0.05);
    popIn(B, `#${p}-k`, 0.1);
    const winSide = m.winner === m.home_id ? 'h' : m.winner ? 'a' : null;
    if (winSide) { B.ft(`#${p}-w`, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.35, ease: E.pop }, 0.6); B.ft(`#${p}-${winSide}`, { scale: 1 }, { scale: 1.12, duration: 0.3, ease: E.pop }, 0.6); }
    B.ft(`#${p}-sc`, { scale: 1.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.3, ease: 'power4.in' }, 0.35);
    return {
      css: `#${p}-cd{position:absolute;left:60px;top:560px;width:960px;height:520px}
.ssc{position:absolute;left:0;top:150px;width:960px;text-align:center;font-size:230px}
.sd{position:absolute;left:0;top:430px;width:960px;text-align:center;font-weight:600;font-size:38px;color:rgba(255,230,230,.85)}
.win{position:absolute;top:350px;width:250px;text-align:center}`,
      html: `${html}${kicker(p, sh.kicker, 420)}<div class="card" id="${p}-cd">
${plate(`${p}-h`, logo(m.home_id), 220, 'left:40px;top:120px;', COL[homeSide].ring)}${plate(`${p}-a`, logo(m.away_id), 220, 'left:700px;top:120px;', COL[awaySide].ring)}
<div class="ssc n" id="${p}-sc">${hg}<span style="opacity:.5">-</span>${ag}</div>
<div class="sd">${esc(thDate(m.date))} · ${esc(LEAGUE_TH[m.league_id] || '')}</div>
${winSide ? `<div class="win" id="${p}-w" style="left:${winSide === 'h' ? 25 : 685}px"><span class="chip" style="background:#22c55e;color:#04140a">ชนะ</span></div>` : ''}</div>`,
    };
  },
  pitch(B, p, sh, dur, P) {
    const { home: H, away: A } = P.facts, W = 680, HH = 525;
    const fpos = (f) => { const lines = [1, ...f.split('-').map(Number)]; const out = []; lines.forEach((cnt, r) => { const y = 0.9 - r * (0.78 / (lines.length - 1)); for (let k = 0; k < cnt; k++) out.push({ x: ((k + 1) / (cnt + 1)) * W, y: y * HH }); }); return out; };
    const hp = fpos('4-2-3-1').map((q) => ({ x: q.x, y: HH + q.y })), ap = fpos('4-2-3-1').map((q) => ({ x: W - q.x, y: HH - q.y }));
    let dots = '';
    hp.forEach((q, n) => { dots += `<div class="pd h" id="${p}-h${n}" style="left:${q.x - 24}px;top:${q.y - 24}px"></div>`; popIn(B, `#${p}-h${n}`, 0.25 + n * 0.035, { scale: 0, opacity: 0, y: 30 }); });
    ap.forEach((q, n) => { dots += `<div class="pd a" id="${p}-a${n}" style="left:${q.x - 24}px;top:${q.y - 24}px"></div>`; popIn(B, `#${p}-a${n}`, 0.25 + n * 0.035, { scale: 0, opacity: 0, y: -30 }); });
    B.ft(`#${p}-pt`, { rotationX: 60, y: 200, opacity: 0 }, { rotationX: 32, y: 0, opacity: 1, duration: 0.5, ease: E.out }, 0);
    B.ft(`#${p}-pt`, { rotationZ: 0 }, { rotationZ: 4, duration: dur, ease: 'none' }, 0);
    popIn(B, `#${p}-k`, 0.1); popIn(B, `#${p}-t`, 0.4); popIn(B, `#${p}-s`, 0.6);
    return {
      css: `.persp{position:absolute;left:200px;top:400px;width:680px;height:1050px;perspective:1500px}
#${p}-pt{position:absolute;inset:0;transform-origin:50% 60%;transform-style:preserve-3d}
.pd{position:absolute;width:48px;height:48px;border-radius:50%}
.pd.h{background:radial-gradient(circle at 40% 35%,#ff5a6e,${COL.home.main});box-shadow:0 0 0 5px #fff,0 8px 16px rgba(0,0,0,.5)}
.pd.a{background:radial-gradient(circle at 40% 35%,#ff6a4a,${COL.away.main});box-shadow:0 0 0 5px #111,0 0 0 9px #fbe122,0 8px 16px rgba(0,0,0,.5)}`,
      html: `<div class="bgc"></div>${kicker(p, sh.kicker, 150)}<div class="ttl gold" id="${p}-t" style="top:225px;font-size:96px">${esc(sh.title)}</div>
<div class="persp"><div id="${p}-pt">${pitchSVG(p)}${dots}</div></div>
${plate(`${p}-la`, logo(A.id), 120, 'left:40px;top:470px;', COL.away.ring)}${plate(`${p}-lh`, logo(H.id), 120, 'left:920px;top:1090px;', COL.home.ring)}
<div class="ttl" id="${p}-s" style="top:340px;font-size:48px">${esc(sh.sub || '')}</div>`,
    };
  },
  flip(B, p, sh, dur, P) {
    const c = P.facts.coach;
    const html = bgPicture(B, p, sh, dur, { filter: 'blur(2px) brightness(.4)', shade: 'linear-gradient(180deg,rgba(5,1,2,.35),rgba(5,1,2,.8))' });
    let cards = '';
    c.matches.forEach((m, n) => {
      cards += `<div class="fc" id="${p}-c${n}" style="left:${60 + n * 330}px"><div class="fl"><img src="${logo(m.team_id)}" alt=""><span>vs</span><img src="${logo(c.opponent_id)}" alt=""></div>
<div class="fs n">${m.gf}-${m.ga}</div><div class="fr" style="background:${RES_COL[m.res]}">${RES_TH[m.res]}</div><div class="fg">${esc(LEAGUE_TH[m.league_id] || m.league)}</div></div>`;
      B.ft(`#${p}-c${n}`, { rotationY: -100, opacity: 0 }, { rotationY: 0, opacity: 1, duration: 0.45, ease: E.out }, 0.3 + n * 0.28);
    });
    popIn(B, `#${p}-k`, 0.05); popIn(B, `#${p}-t`, 1.25);
    return {
      css: `.fc{position:absolute;top:560px;width:300px;height:430px;border-radius:26px;background:linear-gradient(180deg,rgba(40,8,14,.95),rgba(12,2,4,.97));box-shadow:inset 0 0 0 3px rgba(255,120,120,.3),0 20px 50px rgba(0,0,0,.55);transform-origin:50% 50%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
.fl{display:flex;align-items:center;gap:10px}.fl img{width:80px;height:80px;object-fit:contain;background:#fff;border-radius:50%;padding:8px}.fl span{font-weight:700;font-size:30px;color:rgba(255,255,255,.7)}
.fs{font-size:120px}.fr{font-weight:700;font-size:34px;padding:4px 22px 8px;border-radius:999px;color:#fff}.fg{font-weight:600;font-size:30px;color:rgba(255,230,230,.8)}`,
      html: `${html}${kicker(p, sh.kicker, 400)}${cards}<div class="ttl gold" id="${p}-t" style="top:1080px;font-size:110px">${esc(sh.title)}</div>`,
    };
  },
  player(B, p, sh, dur) {
    const side = COL[sh.team];
    const html = bgPicture(B, p, sh, dur, { shade: `linear-gradient(180deg,rgba(5,1,2,0) 0%,rgba(5,1,2,.1) 35%,${side.deep}dd 58%,#050102 78%)` });
    const big = String(sh.big);
    slam(B, `#${p}-big`, 0.22); shake(B, `#${p}-beat`, 0.54, 6, 12);
    B.ft(`#${p}-nm`, { x: sh.fx === 'whipR' ? 300 : -300, opacity: 0 }, { x: 0, opacity: 1, duration: 0.35, ease: E.out }, 0.12);
    popIn(B, `#${p}-lb`, 0.6);
    let ov = '';
    if (sh.overlay === 'passes') {
      const paths = ['M600 1250 C 700 1120, 860 1110, 1010 1170', 'M620 1300 C 760 1240, 900 1250, 1030 1080', 'M580 1180 C 680 1040, 860 1000, 990 1040'];
      ov = `<svg class="ov" width="1080" height="1920">${paths.map((d, n) => `<path id="${p}-ps${n}" d="${d}" fill="none" stroke="#fbbf24" stroke-width="9" stroke-linecap="round" stroke-dasharray="1000" stroke-dashoffset="1000" opacity=".9"/>`).join('')}</svg>`;
      paths.forEach((_, n) => B.ft(`#${p}-ps${n}`, { strokeDashoffset: 1000 }, { strokeDashoffset: 0, duration: 0.6, ease: E.io }, 0.7 + n * 0.18));
    }
    if (sh.overlay === 'shots') {
      let dots = '';
      for (let n = 0; n < 13; n++) { const x = 30 + ((n * 61) % 330), y = 22 + ((n * 37) % 120); dots += `<circle id="${p}-d${n}" cx="${x}" cy="${y}" r="13" fill="#fbbf24" stroke="#1a0d00" stroke-width="3"/>`; B.ft(`#${p}-d${n}`, { opacity: 0, scale: 0 }, { opacity: 1, scale: 1, duration: 0.2, ease: E.pop }, 0.7 + n * 0.05); }
      ov = `<svg class="ov2" width="400" height="180" viewBox="0 0 400 180"><rect x="8" y="8" width="384" height="164" fill="rgba(0,0,0,.35)" stroke="#fff" stroke-width="8"/>${dots}</svg>`;
    }
    return {
      css: `.pnm{position:absolute;left:60px;top:880px}.pnm span{display:inline-block;padding:10px 30px 16px;border-radius:14px;background:${side.main};font-weight:700;font-size:64px;box-shadow:0 10px 30px rgba(0,0,0,.5)}
.pbig{position:absolute;left:40px;top:990px;font-size:${big.length > 2 ? 260 : 330}px}
.plb{position:absolute;left:60px;top:${big.length > 2 ? 1270 : 1310}px;font-weight:700;font-size:56px;text-shadow:0 4px 14px rgba(0,0,0,.8)}
.ov{position:absolute;left:0;top:0;pointer-events:none}.ov2{position:absolute;left:640px;top:1040px;transform-origin:50% 50%}`,
      html: `${html}<div class="pnm" id="${p}-nm"><span>${esc(sh.name)}</span></div><div class="pbig n gold" id="${p}-big">${esc(big)}</div><div class="plb" id="${p}-lb">${esc(sh.label)}</div>${ov}`,
    };
  },
  balls(B, p, sh, dur) {
    let balls = '';
    for (let n = 0; n < sh.total; n++) {
      const x = 95 + (n % 7) * 130, y = 600 + Math.floor(n / 7) * 150;
      balls += `<div class="bw" id="${p}-b${n}" style="left:${x}px;top:${y}px">${BALL(`${p}-bs${n}`, 110)}<div class="bg2" id="${p}-g${n}"></div></div>`;
      popIn(B, `#${p}-b${n}`, 0.03 + n * 0.018, { scale: 0, opacity: 0, y: -60 });
      if (n < sh.gold) B.ft(`#${p}-g${n}`, { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.2, ease: E.pop }, 0.3 + n * 0.05);
    }
    popIn(B, `#${p}-t`, 0.3);
    return {
      css: `.bw{position:absolute;width:110px;height:110px}.bg2{position:absolute;inset:-6px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#fff3c4,#fbbf24 50%,#d97706);box-shadow:0 0 30px rgba(251,191,36,.9);mix-blend-mode:multiply;opacity:0}`,
      html: `<div class="bgc"></div><div class="ttl gold" id="${p}-t" style="top:1000px;font-size:104px">${esc(sh.title)}</div>${balls}`,
    };
  },
  warn(B, p, sh, dur, P) {
    const team = P.facts[sh.team], side = COL[sh.team];
    const stripes = sh.team === 'away' ? 'repeating-linear-gradient(-45deg,#fbe122 0 50px,#111 50px 100px)' : 'repeating-linear-gradient(-45deg,#fff 0 50px,#c8102e 50px 100px)';
    B.ft(`#${p}-band`, { scaleX: 0 }, { scaleX: 1, duration: 0.3, ease: E.out }, 0);
    B.ft(`#${p}-st`, { backgroundPositionX: '0px' }, { backgroundPositionX: '-1400px', duration: dur, ease: 'none' }, 0);
    for (const d of [0.05, 0.45]) B.ft(`#${p}-rf`, { opacity: 0.9 }, { opacity: 0, duration: 0.35 }, d);
    slam(B, `#${p}-t`, 0.15); popIn(B, `#${p}-lg`, 0.1, { scale: 0, opacity: 0, rotation: -40 });
    return {
      css: `#${p}-band{position:absolute;left:0;top:700px;width:1080px;height:300px;transform:rotate(-6deg);transform-origin:50% 50%;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.6)}
#${p}-st{position:absolute;inset:0;background:${stripes};background-size:1414px 300px}
.wt{position:absolute;left:0;top:740px;width:1080px;text-align:center;transform:rotate(-6deg)}
.wt span{display:inline-block;padding:16px 40px 24px;background:#0a0204;font-weight:700;font-size:96px;border-radius:12px;box-shadow:0 0 0 6px ${side.main}}`,
      html: `<div class="bgc"></div><div class="rflash" id="${p}-rf"></div>${plate(`${p}-lg`, logo(team.id), 220, 'left:430px;top:360px;', side.ring)}
<div id="${p}-band"><div id="${p}-st"></div></div><div class="wt" id="${p}-t"><span>${esc(sh.text)}</span></div>`,
    };
  },
  bignum(B, p, sh, dur) {
    const html = sh.photo || sh.gen ? bgPicture(B, p, sh, dur, { filter: 'blur(2px) brightness(.45)', shade: 'linear-gradient(180deg,rgba(5,1,2,.3),rgba(5,1,2,.85))' }) : '<div class="bgc"></div>';
    const icon = sh.icon === 'clock' ? ICON.clock(p) : ICON[sh.icon];
    popIn(B, `#${p}-ic`, 0.05);
    if (sh.icon === 'clock') B.ft(`#${p}-hand`, { rotation: 0 }, { rotation: 270, duration: 0.9, ease: E.io }, 0.1);
    slam(B, `#${p}-big`, 0.25); shake(B, `#${p}-beat`, 0.57, 6, 12);
    popIn(B, `#${p}-lb`, 0.55); popIn(B, `#${p}-sb`, 0.75);
    return {
      css: `.bic{position:absolute;left:0;top:300px;width:1080px;display:flex;justify-content:center}
.bbig{position:absolute;left:0;top:560px;width:1080px;text-align:center;font-size:440px}
.blb{position:absolute;left:40px;width:1000px;top:1010px;text-align:center;font-weight:700;font-size:76px;text-shadow:0 6px 0 #1a0204,0 14px 40px rgba(0,0,0,.75)}
.bsb{position:absolute;left:40px;width:1000px;top:1130px;text-align:center}`,
      html: `${html}<div class="bic" id="${p}-ic">${icon}</div><div class="bbig n gold" id="${p}-big">${esc(sh.big)}</div><div class="blb" id="${p}-lb">${esc(sh.label)}</div>
<div class="bsb" id="${p}-sb"><span class="chip" style="background:rgba(0,0,0,.6);box-shadow:inset 0 0 0 3px rgba(255,255,255,.3);font-size:40px">${esc(sh.sub || '')}</span></div>`,
    };
  },
  out(B, p, sh, dur, P) {
    const team = P.facts[sh.team], side = COL[sh.team];
    let cards = '';
    sh.names.forEach((nm, n) => {
      cards += `<div class="oc" id="${p}-c${n}" style="top:${560 + n * 230}px"><div class="on">${esc(nm)}</div><div class="os" id="${p}-s${n}">ไม่ได้ลง</div></div>`;
      B.ft(`#${p}-c${n}`, { x: -1000 }, { x: 0, duration: 0.35, ease: E.out }, 0.08 + n * 0.12);
      B.ft(`#${p}-s${n}`, { scale: 2.4, opacity: 0, rotation: -24 }, { scale: 1, opacity: 1, rotation: -12, duration: 0.22, ease: 'power4.in' }, 0.45 + n * 0.22);
    });
    popIn(B, `#${p}-t`, 0.05);
    return {
      css: `.oc{position:absolute;left:90px;width:900px;height:190px;border-radius:26px;background:linear-gradient(90deg,${side.deep},rgba(10,2,4,.95));box-shadow:inset 8px 0 0 ${side.main},0 20px 40px rgba(0,0,0,.5)}
.on{position:absolute;left:50px;top:40px;font-weight:700;font-size:84px}
.os{position:absolute;right:36px;top:46px;padding:6px 22px 12px;border:6px solid #ef4444;border-radius:12px;color:#ef4444;font-weight:700;font-size:54px;background:rgba(0,0,0,.4)}`,
      html: `<div class="bgc"></div>${plate(`${p}-lg`, logo(team.id), 150, 'left:465px;top:200px;', side.ring)}<div class="ttl" id="${p}-t" style="top:390px;font-size:76px">${esc(sh.title)}</div>${cards}`,
    };
  },
  split(B, p, sh, dur, P) {
    const { home: H, away: A } = P.facts;
    const html = bgPicture(B, p, sh, dur, { filter: 'brightness(.55)', shade: 'linear-gradient(180deg,rgba(5,1,2,.2),rgba(5,1,2,.7))' });
    B.ft(`#${p}-l`, { x: -600 }, { x: 0, duration: 0.35, ease: E.out }, 0);
    B.ft(`#${p}-r`, { x: 600 }, { x: 0, duration: 0.35, ease: E.out }, 0);
    for (let k = 0; k * 0.5 < dur - 0.5; k++) {
      const s = k % 2 ? 'a' : 'h';
      B.ft(`#${p}-${s}`, { scale: 1 }, { scale: 1.14, duration: 0.18, ease: E.out }, 0.5 + k * 0.5);
      B.ft(`#${p}-${s}`, { scale: 1.14 }, { scale: 1, duration: 0.3, ease: E.io }, 0.68 + k * 0.5);
    }
    slam(B, `#${p}-q`, 0.3); popIn(B, `#${p}-t`, 0.5);
    return {
      css: `.sh{position:absolute;top:0;height:1920px;width:1080px;opacity:.82}
#${p}-l{background:linear-gradient(160deg,${COL.home.main},${COL.home.deep});clip-path:polygon(0 0,58% 0,42% 100%,0 100%)}
#${p}-r{background:linear-gradient(200deg,${COL.away.main},${COL.away.deep});clip-path:polygon(58% 0,100% 0,100% 100%,42% 100%)}
.sq{position:absolute;left:0;top:560px;width:1080px;text-align:center;font-size:300px}`,
      html: `${html}<div class="sh" id="${p}-l"></div><div class="sh" id="${p}-r"></div>
${plate(`${p}-h`, logo(H.id), 280, 'left:80px;top:380px;', COL.home.ring)}${plate(`${p}-a`, logo(A.id), 280, 'left:720px;top:380px;', COL.away.ring)}
<div class="sq n gold" id="${p}-q">?</div><div class="ttl" id="${p}-t" style="top:1080px;font-size:110px">${esc(sh.title)}</div>`,
    };
  },
  comment(B, p, sh, dur, P) {
    const { home: H, away: A } = P.facts;
    const bub = (id, team, side, top, left) => `<div class="cb" id="${id}" style="top:${top}px;left:${left}px">${plate(`${id}-p`, logo(team.id), 110, 'left:24px;top:20px;', COL[side].ring)}<div class="ct">ทีม${COL[side].nick}</div><div class="cl">♥</div></div>`;
    popIn(B, `#${p}-b1`, 0.15, { scale: 0.3, opacity: 0, y: 40 }); popIn(B, `#${p}-b2`, 0.4, { scale: 0.3, opacity: 0, y: 40 });
    popIn(B, `#${p}-t`, 0.05); popIn(B, `#${p}-s`, 0.6);
    for (let k = 0; k * 0.5 < dur - 0.8; k++) B.ft(`#${p}-ar`, { y: 0 }, { y: 26, duration: 0.25, ease: E.io, yoyo: true, repeat: 1 }, 0.8 + k * 0.5);
    return {
      css: `.cb{position:absolute;width:640px;height:150px;border-radius:40px 40px 40px 8px;background:#fff;color:#111;box-shadow:0 20px 50px rgba(0,0,0,.5)}
.ct{position:absolute;left:160px;top:38px;font-weight:700;font-size:58px}.cl{position:absolute;right:36px;top:30px;font-size:70px;color:#ef4444}
.cs{position:absolute;left:0;top:1120px;width:1080px;text-align:center}.cs span{display:inline-block;padding:16px 46px 22px;border-radius:999px;background:linear-gradient(180deg,#ffd166,#f59e0b);color:#1a0d00;font-weight:700;font-size:60px;box-shadow:0 8px 0 #7a3a04}
.car{position:absolute;left:510px;top:1250px}`,
      html: `<div class="bgc"></div><div class="ttl gold" id="${p}-t" style="top:260px;font-size:120px">${esc(sh.title)}</div>
${bub(`${p}-b1`, H, 'home', 560, 80)}${bub(`${p}-b2`, A, 'away', 780, 360)}
<div class="cs" id="${p}-s"><span>${esc(sh.sub)}</span></div><svg class="car" id="${p}-ar" width="60" height="70" viewBox="0 0 60 70"><path d="M30 4 V56 M8 36 L30 62 L52 36" fill="none" stroke="#fbbf24" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    };
  },
  brand(B, p, sh, dur) {
    B.ft(`#${p}-br`, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: E.pop }, 0.3);
    B.ft(`#${p}-sheen`, { x: -300 }, { x: 1100, duration: 0.9, ease: E.io }, 0.8);
    B.ft(`#${p}-rays`, { rotation: 0, opacity: 0 }, { rotation: 40, opacity: 1, duration: dur, ease: 'none' }, 0.2);
    popIn(B, `#${p}-tag`, 0.7); popIn(B, `#${p}-url`, 0.9);
    return {
      css: `.rays{position:absolute;left:-360px;top:0;width:1800px;height:1800px;background:repeating-conic-gradient(from 0deg,rgba(251,191,36,.2) 0deg 5deg,rgba(251,191,36,0) 5deg 15deg);-webkit-mask:radial-gradient(closest-side,#000 0%,rgba(0,0,0,.6) 40%,transparent 75%);mask:radial-gradient(closest-side,#000 0%,rgba(0,0,0,.6) 40%,transparent 75%)}
.brand{position:absolute;left:120px;top:660px;width:840px;height:250px;border-radius:44px;background:linear-gradient(180deg,#fff,#eef3fb);box-shadow:0 0 0 6px rgba(251,191,36,.95),0 0 0 12px #3a2203,0 30px 80px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;overflow:hidden}
.brand img{width:760px}.brand .sheen{position:absolute;top:-20px;bottom:-20px;width:220px;left:0;background:linear-gradient(100deg,rgba(255,255,255,0),rgba(255,255,255,.85),rgba(255,255,255,0));transform:skewX(-18deg)}
.btag{position:absolute;left:0;top:980px;width:1080px;text-align:center;font-weight:700;font-size:58px}
.burl{position:absolute;left:0;top:1100px;width:1080px;text-align:center}.burl span{display:inline-block;padding:16px 44px 20px;border-radius:26px;background:#1a0508;box-shadow:inset 0 0 0 5px #fbbf24;font-family:Barlow;font-weight:800;font-size:64px}`,
      html: `<div class="bgc"></div><div class="rays" id="${p}-rays"></div><div class="brand" id="${p}-br"><img src="${BRAND('logo-lockup.webp')}" alt=""><div class="sheen" id="${p}-sheen"></div></div>
<div class="btag" id="${p}-tag">อ่านเกมด้วยข้อมูลจริง</div><div class="burl" id="${p}-url"><span>khemthit<b style="color:#fbbf24">football</b>.com</span></div>`,
    };
  },
};

function buildShot(sh, P) {
  const p = `s${sh.k}`, B = TLB(), dur = sh.dur;
  B.set(`#${p}-wf`, { opacity: 0 }, 0);
  const body = SHOTS[sh.type](B, p, sh, dur, P);
  // the cut: every shot enters with an effect, and a long shot gets a second beat halfway
  const fx = sh.fx || 'cut';
  if (fx === 'whipL' || fx === 'whipR') {
    const d = fx === 'whipL' ? -1 : 1;
    B.ft(`#${p}-stage`, { x: d * 700, skewX: d * -14, opacity: 0.3 }, { x: 0, skewX: 0, opacity: 1, duration: 0.26, ease: E.out5 }, 0);
    B.ft(`#${p}-stk`, { x: d * 900, opacity: 0.9 }, { x: -d * 900, opacity: 0, duration: 0.3, ease: E.out }, 0);
  } else if (fx === 'punch') B.ft(`#${p}-stage`, { scale: 1.35, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.28, ease: E.out5 }, 0);
  else if (fx === 'flash') { B.ft(`#${p}-wf`, { opacity: 0.85 }, { opacity: 0, duration: 0.35, ease: E.out }, 0); B.ft(`#${p}-stage`, { scale: 1.08 }, { scale: 1, duration: 0.4, ease: E.out }, 0); }
  if (dur > 2.2 && sh.type !== 'clash' && sh.type !== 'glitch') {
    const m = r3(Math.max(1.1, dur / 2));
    B.ft(`#${p}-drift`, { scale: 1 }, { scale: 1.05, duration: 0.12, ease: E.out }, m);
    B.ft(`#${p}-drift`, { scale: 1.05 }, { scale: 1, duration: 0.35, ease: E.io }, m + 0.12);
    B.ft(`#${p}-wf`, { opacity: 0.18 }, { opacity: 0, duration: 0.25 }, m);
  }
  const cred = creditLine(P, sh);
  const html = `<div class="stage" id="${p}-stage"><div class="beat" id="${p}-drift"><div class="beat" id="${p}-beat">${body.html}</div></div></div>
<div class="streak" id="${p}-stk" style="left:370px"></div><div class="wflash" id="${p}-wf"></div><div class="vig"></div>${cred ? `<div class="cred">${esc(cred)}</div>` : ''}`;
  return scene(p, CSS + body.css, html, B.js());
}

// captions (same look as the insight films)
function buildCaptions(TL) {
  const p = 'cap', B = TLB();
  let html = '';
  const all = TL.subs;
  all.forEach((s, i) => {
    const end = i + 1 < all.length ? Math.min(all[i + 1].t0 - 0.08, s.t1 + 0.5) : s.t1 + 0.5;
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
    html += `<div class="grp" id="${p}-g${i}"><div class="tx">${o}</div></div>`;
    const t0 = Math.max(0.05, s.t0 - 0.06);
    B.set(`#${p}-g${i}`, { visibility: 'visible' }, t0);
    B.ft(`#${p}-g${i}`, { y: 26, scale: 0.94, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.2, ease: E.out }, t0);
    B.ft(`#${p}-g${i}`, { opacity: 1 }, { opacity: 0, duration: 0.1, ease: E.in }, end - 0.1);
    B.set(`#${p}-g${i}`, { visibility: 'hidden' }, end);
  });
  return `<template>
<style>${FONTS}
#root{position:absolute;inset:0;font-family:Plex,sans-serif;pointer-events:none}
.cbg{position:absolute;left:0;top:1440px;width:1080px;height:320px;background:radial-gradient(60% 50% at 50% 50%,rgba(10,2,4,.78),rgba(10,2,4,0))}
.grp{position:absolute;left:60px;top:1480px;width:960px;text-align:center;visibility:hidden}
.grp .tx{font-weight:700;font-size:60px;line-height:1.32;color:#fff;text-shadow:0 4px 0 #1a0204,0 0 2px #1a0204,0 10px 28px rgba(0,0,0,.85)}
.grp .hi{display:inline-block}
</style>
<div id="root" data-composition-id="${p}" data-width="1080" data-height="1920"><div class="cbg"></div>${html}</div>
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
  const { facts, spot } = P;
  fs.rmSync(path.join(HF, 'compositions'), { recursive: true, force: true });
  fs.mkdirSync(path.join(HF, 'compositions'), { recursive: true });
  for (const d of ['fonts', 'logos', 'brand', 'photos', 'gen']) fs.mkdirSync(path.join(HF, 'assets', d), { recursive: true });
  for (const f of fs.readdirSync(path.join(ROOT, 'assets', 'fonts'))) fs.copyFileSync(path.join(ROOT, 'assets', 'fonts', f), path.join(HF, 'assets', 'fonts', f));
  const ids = new Set([facts.home.id, facts.away.id, ...facts.home.matches.map((m) => m.opponent_id), ...facts.away.matches.map((m) => m.opponent_id), ...(facts.coach?.matches || []).map((m) => m.team_id)]);
  for (const id of ids) fs.copyFileSync(path.join(ROOT, logo(id)), path.join(HF, logo(id)));
  for (const sh of TL.shots) {
    if (sh.photo) fs.copyFileSync(path.join(DIR, 'photos', sh.photo), path.join(HF, 'assets', 'photos', sh.photo));
    if (sh.gen) execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', path.join(DIR, 'gen', sh.gen), '-q:v', '3', path.join(HF, 'assets', 'gen', sh.gen)]);
  }
  fs.copyFileSync(path.join(REPO, 'apps', 'web', 'public', 'brand', 'logo-lockup.webp'), path.join(HF, 'assets', 'brand', 'logo-lockup.webp'));
  fs.copyFileSync(path.join(OUT, 'mix.wav'), path.join(HF, 'assets', 'mix.wav'));
  const hosts = TL.shots.map((sh) => {
    fs.writeFileSync(path.join(HF, 'compositions', `s${sh.k}.html`), buildShot(sh, P));
    return { id: `s${sh.k}`, start: r3(sh.t0), dur: r3(sh.dur) };
  });
  fs.writeFileSync(path.join(HF, 'compositions', 'cap.html'), buildCaptions(TL));
  const index = `<!doctype html>
<html lang="th">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>${esc(spot.title)}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1080px; height: 1920px; overflow: hidden; background: #050102; }
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
  fs.writeFileSync(path.join(HF, 'meta.json'), JSON.stringify({ id: `preview-${slug}`, name: `preview ${slug}` }, null, 2));
  fs.writeFileSync(path.join(HF, 'package.json'), JSON.stringify({ name: `preview-${slug}`, private: true, type: 'module', scripts: { dev: `npx --yes ${HFV} preview`, check: `npx --yes ${HFV} check`, render: `npx --yes ${HFV} render` } }, null, 2));
  console.log(`hf project: ${path.relative(ROOT, HF)} · ${hosts.length} shots · total ${TL.T}s`);
}

// ---------- 6. stills + film ----------
const npx = (a) => spawnSync('npx', ['--yes', HFV, ...a], { cwd: HF, encoding: 'utf8', shell: true, maxBuffer: 64 << 20 });

function stills(TL) {
  const chk = npx(['check']);
  console.log((chk.stdout || '').split('\n').filter((l) => /error|warn|✓|✗|pass|fail/i.test(l)).slice(0, 30).join('\n'));
  const snap = path.join(OUT, 'snaps');
  fs.rmSync(snap, { recursive: true, force: true });
  const r = npx(['snapshot', '.', '--at', TL.probe.join(','), '--no-end', '-o', snap, '--timeout', '180000']);
  if (r.status) { console.error(r.stdout, r.stderr); process.exit(1); }
  const files = fs.readdirSync(snap).filter((f) => /\.(png|jpe?g)$/.test(f)).sort();
  console.log(`stills: ${path.relative(ROOT, snap)} (${files.length})`);
}

function film() {
  fs.mkdirSync(FINAL, { recursive: true });
  const out = path.join(FINAL, `${slug}.mp4`);
  const t0 = Date.now();
  const r = spawnSync('npx', ['--yes', HFV, 'render', '.', '-o', out, '--quality', 'looks'], { cwd: HF, stdio: 'inherit', shell: true });
  if (r.status) process.exit(r.status);
  const dur = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout.trim();
  const loud = spawnSync('ffmpeg', ['-hide_banner', '-i', out, '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.split('\n').filter((l) => /^\s+(I|Peak):/.test(l)).slice(-2).map((l) => l.trim()).join(' · ');
  const contact = path.join(FINAL, 'contact.png');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', out, '-vf', 'fps=2,scale=150:-1,tile=12x10', '-frames:v', '1', contact]);
  console.log(`${out}\n${Number(dur).toFixed(1)} s · ${loud} · rendered in ${((Date.now() - t0) / 60000).toFixed(1)} min\ncontact sheet: ${contact}`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const P = prepare();
  if (step === 'check') return;
  if (step === 'stills' || step === 'all') {
    await voice(P.segs);
    const TL = timeline(P);
    const { mus, sfx } = sound(TL);
    mixdown(DIR, OUT, TL, mus, sfx, slug);
    buildProject(TL, P);
    stills(TL);
  }
  if (step === 'film' || step === 'all') film();
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

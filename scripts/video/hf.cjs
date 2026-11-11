// HyperFrames build of the day's spotlight film (H.E.A.R.T.: hook, emotion, attention, reveal, take action).
// Reads days/<date>/clips.json + out/c*/timeline.json + out/c*/mix.wav (run prepare, tts, timeline, audio first)
// and writes a HyperFrames project to days/<date>/hf/: index.html (scene hosts, one audio track),
// compositions/c0..cN.html (GSAP scenes), outro.html (call to action + brand), captions.html (every subtitle).
// usage: node hf.cjs [YYYY-MM-DD]   then in days/<date>/hf: npx hyperframes check | snapshot | preview | render
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ROOT, REPO, dateArg, dayDir, readJson } = require('./lib.cjs');

const date = dateArg();
const DAY = dayDir(date);
const HF = path.join(DAY, 'hf');
const clips = readJson(path.join(DAY, 'clips.json'));
const TLs = clips.map((c) => readJson(path.join(DAY, 'out', c.key, 'timeline.json')));
const FPS = 30;
const N = clips.length - 1; // matches

// ---------- helpers ----------
const r3 = (x) => Math.round(x * 1000) / 1000;
const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const asset = (p) => p.replace(/^assets\//, 'assets/'); // logos stay under assets/logos
const BRAND = (f) => `assets/brand/${f}`;

/** A GSAP timeline written as code: every tween at an absolute time; a later tween of a property already tweened never renders early. */
function TLB() {
  const L = [], seen = {};
  const props = (o) => Object.keys(o).filter((k) => !['duration', 'ease', 'immediateRender', 'repeat', 'yoyo', 'stagger'].includes(k));
  return {
    L,
    ft(sel, from, to, at) {
      const key = props(from).map((p) => sel + '|' + p);
      const again = key.some((k) => seen[k]); key.forEach((k) => (seen[k] = 1));
      const t = again ? { ...to, immediateRender: false } : to;
      L.push(`tl.fromTo(${JSON.stringify(sel)},${JSON.stringify(from)},${JSON.stringify(t)},${r3(Math.max(0, at))});`);
    },
    set(sel, v, at) { Object.keys(v).forEach((k) => (seen[sel + '|' + k] = 1)); L.push(`tl.set(${JSON.stringify(sel)},${JSON.stringify(v)},${r3(Math.max(0, at))});`); },
    js() { return L.join('\n'); },
  };
}
const E = { pop: 'back.out(1.7)', spring: 'elastic.out(1,0.6)', out: 'power3.out', out5: 'expo.out', io: 'power2.inOut', in: 'power2.in' };

const FONTS = `
@font-face{font-family:Plex;font-weight:600;src:url(assets/fonts/ibm-plex-sans-thai-thai-600-normal.woff2) format('woff2');unicode-range:U+0E00-0E7F}
@font-face{font-family:Plex;font-weight:700;src:url(assets/fonts/ibm-plex-sans-thai-thai-700-normal.woff2) format('woff2');unicode-range:U+0E00-0E7F}
@font-face{font-family:Plex;font-weight:600;src:url(assets/fonts/ibm-plex-sans-thai-latin-600-normal.woff2) format('woff2');unicode-range:U+0000-024F,U+2000-206F}
@font-face{font-family:Plex;font-weight:700;src:url(assets/fonts/ibm-plex-sans-thai-latin-700-normal.woff2) format('woff2');unicode-range:U+0000-024F,U+2000-206F}
@font-face{font-family:Barlow;font-weight:800;src:url(assets/fonts/barlow-condensed-latin-800-normal.woff2) format('woff2')}
@font-face{font-family:Barlow;font-weight:900;src:url(assets/fonts/barlow-condensed-latin-900-normal.woff2) format('woff2')}`;

// shared look (the incumbent spot.html theme: deep navy, gold/orange, white logo plates)
const BASE = `
.stage{position:absolute;inset:0;transform-origin:540px 860px}
.bg{position:absolute;inset:0;background:radial-gradient(120% 70% at 50% 38%,#10306e 0%,#0a1b45 38%,#050d24 70%,#02060f 100%)}
.beam{position:absolute;top:-300px;width:520px;height:2300px;transform-origin:50% 0;mix-blend-mode:screen;filter:blur(28px)}
.beam.b{background:linear-gradient(180deg,rgba(90,150,255,.5),rgba(60,110,255,.1) 55%,rgba(0,0,0,0) 80%)}
.beam.g{background:linear-gradient(180deg,rgba(255,196,80,.5),rgba(255,160,40,.1) 55%,rgba(0,0,0,0) 80%)}
.ember{position:absolute;border-radius:50%}
.plate{position:absolute;left:0;top:0;width:340px;height:340px;margin:-170px 0 0 -170px}
.plate .halo{position:absolute;inset:-90px;border-radius:50%;background:radial-gradient(closest-side,rgba(255,190,60,.75),rgba(255,140,20,.25) 55%,rgba(255,140,20,0));mix-blend-mode:screen;opacity:0}
.plate .face{position:absolute;inset:0;border-radius:50%;background:linear-gradient(160deg,#fff 0%,#eef3fb 45%,#cfd9ea 100%);box-shadow:0 0 0 9px #f6b72a,0 0 0 15px #8a4b06,0 18px 0 12px #5a2f02,0 40px 80px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;overflow:hidden}
.plate.league .face{box-shadow:0 0 0 8px #5b8cff,0 0 0 14px #1e3a8a,0 16px 0 10px #0f1f52,0 40px 80px rgba(0,0,0,.6)}
.plate img{width:64%;height:64%;object-fit:contain}
.pill{display:inline-block;padding:16px 46px 20px;border-radius:999px;background:linear-gradient(180deg,#ffd166,#f59e0b 60%,#d9730a);color:#1a0d00;font-weight:700;font-size:60px;line-height:1.1;white-space:nowrap;box-shadow:0 8px 0 #7a3a04,0 20px 50px rgba(245,158,11,.45)}
.gold{background:linear-gradient(180deg,#fff7d6,#fbbf24 55%,#f08a12);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;filter:drop-shadow(0 6px 0 #6b3303) drop-shadow(0 16px 30px rgba(0,0,0,.6))}
.flash{position:absolute;inset:0;background:radial-gradient(circle at 50% 45%,#fff6d8,#ffcc66 40%,rgba(255,170,40,0) 75%);mix-blend-mode:screen;opacity:0}
.vig{position:absolute;inset:0;background:radial-gradient(130% 85% at 50% 45%,rgba(0,0,0,0) 55%,rgba(0,0,0,.55) 100%)}
.dark{position:absolute;inset:0;background:#02060f;opacity:0}
.spark{position:absolute;left:0;top:0;border-radius:50%;background:#ffd27a;box-shadow:0 0 12px #ffb340}`;

function ambient(p, dur, seed) {
  const rnd = mulberry(seed);
  let html = `<div class="bg"></div>`;
  const tl = [];
  [['b', -60, -14], ['g', 240, 10], ['b', 560, -8], ['g', 820, 16]].forEach(([c, x, a], i) => {
    html += `<div class="beam ${c}" id="${p}-bm${i}" style="left:${x}px"></div>`;
    const cyc = 2.4 + i * 0.4, rep = Math.max(0, Math.floor(dur / cyc) - 1);
    tl.push([`#${p}-bm${i}`, { rotation: a - 8, opacity: 0.35 }, { rotation: a + 8, opacity: 0.6, duration: cyc, ease: 'sine.inOut', repeat: rep, yoyo: true }, 0]);
  });
  for (let i = 0; i < 26; i++) {
    const v = 30 + rnd() * 70, x = rnd() * 1080, y = rnd() * (1920 + v * dur), r = 2 + rnd() * 4, gold = rnd() < 0.7;
    html += `<div class="ember" id="${p}-e${i}" style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px;width:${(r * 2).toFixed(1)}px;height:${(r * 2).toFixed(1)}px;background:${gold ? 'rgba(255,190,80,.6)' : 'rgba(130,180,255,.55)'};box-shadow:0 0 ${(r * 3).toFixed(0)}px ${gold ? 'rgba(255,170,60,.8)' : 'rgba(120,170,255,.8)'}"></div>`;
    tl.push([`#${p}-e${i}`, { y: 0 }, { y: -v * dur, duration: dur, ease: 'none' }, 0]);
  }
  return { html, tl };
}

function sparks(p, name, n, seed) {
  const rnd = mulberry(seed);
  const list = [];
  let html = '';
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, d = 220 + rnd() * 520, r = 4 + rnd() * 8, life = 0.6 + rnd() * 0.7;
    html += `<div class="spark" id="${p}-${name}${i}" style="width:${r.toFixed(0)}px;height:${r.toFixed(0)}px;margin:${(-r / 2).toFixed(0)}px 0 0 ${(-r / 2).toFixed(0)}px;opacity:0"></div>`;
    list.push({ id: `#${p}-${name}${i}`, dx: Math.cos(a) * d, dy: Math.sin(a) * d * 0.8 + 90, life });
  }
  return { html, burst: (B, at, cx, cy) => list.forEach((s) => B.set(s.id, { opacity: 0, x: cx, y: cy, scale: 1.4 }, 0) || B.ft(s.id, { x: cx, y: cy, opacity: 1, scale: 1.4 }, { x: cx + s.dx, y: cy + s.dy, opacity: 0, scale: 0.4, duration: s.life, ease: 'expo.out' }, at)) };
}

function pitchSVG(p, opts = {}) {
  const L = 'fill="none" stroke="rgba(235,245,255,.72)" stroke-width="4"';
  let s = `<svg viewBox="0 0 680 1050" width="680" height="1050" style="position:absolute;inset:0;overflow:visible">
<defs><linearGradient id="${p}-edge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fbbf24"/><stop offset="1" stop-color="#3b82f6"/></linearGradient></defs>
<rect x="-26" y="-26" width="732" height="1102" rx="22" fill="#07142f" stroke="url(#${p}-edge)" stroke-width="6" opacity=".95"/>`;
  for (let i = 0; i < 12; i++) s += `<rect x="0" y="${i * 87.5}" width="680" height="87.5" fill="${i % 2 ? '#0d4a45' : '#0b403c'}"/>`;
  s += `<rect x="20" y="20" width="640" height="1010" ${L}/><line x1="20" y1="525" x2="660" y2="525" ${L}/><circle cx="340" cy="525" r="92" ${L}/><circle cx="340" cy="525" r="5" fill="#fff"/>`;
  for (const top of [true, false]) {
    const y0 = top ? 20 : 1030, sg = top ? 1 : -1;
    s += `<rect x="138" y="${top ? 20 : 865}" width="404" height="165" ${L}/><rect x="248" y="${top ? 20 : 975}" width="184" height="55" ${L}/><circle cx="340" cy="${y0 + sg * 110}" r="5" fill="#fff"/><path d="M 266 ${y0 + sg * 165} A 92 92 0 0 ${top ? 0 : 1} 414 ${y0 + sg * 165}" ${L}/><rect x="304" y="${top ? 2 : 1030}" width="72" height="18" fill="rgba(255,255,255,.18)" stroke="#fff" stroke-width="3"/>`;
  }
  s += opts.inner || '';
  return s + '</svg>';
}

// a cubic bezier's end point and heading (for the arrowheads)
function bezEnd(d) {
  const n = d.match(/-?\d+(\.\d+)?/g).map(Number);
  const [x2, y2, x3, y3] = n.slice(-4);
  return { x: x3, y: y3, ang: Math.atan2(y3 - y2, x3 - x2) * 180 / Math.PI + 90 };
}

function scene(id, css, body, js) {
  return `<template>
<style>${FONTS}
#root{position:absolute;inset:0;overflow:hidden;background:#02060f;font-family:Plex,sans-serif;color:#fff}
${BASE}
${css}
</style>
<div id="root" data-composition-id="${id}" data-width="1080" data-height="1920">
${body}
</div>
<script>
(function(){
const tl=gsap.timeline({paused:true});
${js}
window.__timelines["${id}"]=tl;
})();
</script>
</template>
`;
}

const nameSize = (n, big = 62) => (n.length > 16 ? Math.round(big * 0.66) : n.length > 12 ? Math.round(big * 0.78) : n.length > 9 ? Math.round(big * 0.88) : big);

// ---------- c0: cover -> hook -> opening list ----------
function buildOpening(TL) {
  const p = 'c0', M = TL.match, C = TL.cover || 0, T = TL.T, subs = TL.subs.map((s) => ({ ...s, t0: s.t0 + C, t1: s.t1 + C }));
  const at = (i) => subs[Math.min(i, subs.length - 1)].t0;
  const H = M.hook, hp = H ? H.phrases : 0;
  const hookMatch = H ? clips.find((c) => c.src === H.match) : null;
  const B = TLB();
  const amb = ambient(p, T, 9);
  amb.tl.forEach((a) => B.ft(...a));
  const pairs = M.groups.flatMap((g) => g.rows);
  B.set(`#${p}-stage`, { scale: 1, x: 0 }, 0);
  B.set(`#${p}-flash`, { opacity: 0 }, 0);

  // cover (thumbnail frame, complete from frame 0)
  const n = pairs.length, cols = n <= 2 ? 1 : 2, rows = Math.ceil(n / cols);
  const room = 620, gap = 26, cardH = Math.min(n <= 2 ? 280 : 240, (room - (rows - 1) * gap) / rows), pl = Math.round(cardH * 0.7), cardW = cols === 1 ? 780 : 470;
  const cover = `<div id="${p}-cover" class="cover">
  <div class="cv" id="${p}-cv"><div class="cb" style="left:-120px;transform:rotate(-16deg)"></div><div class="cb g" style="left:310px;transform:rotate(6deg)"></div><div class="cb g" style="left:420px;transform:rotate(-6deg)"></div><div class="cb" style="left:760px;transform:rotate(16deg)"></div>
  <div class="cglow"></div>
  <div id="${p}-cvLogo" class="cvLogo"><img src="${BRAND('logo-lockup.webp')}" alt=""><div class="sheen" id="${p}-sheen"></div></div>
  <div class="cvH1"><div class="pill" style="font-size:80px;padding:16px 54px 20px">คู่น่าจับตาวันนี้</div></div>
  <div class="cvH2">${esc(M.date_th).replace(/(\d+ \S+)/, '<b>$1</b>')}</div>
  <div class="cvGrid" style="top:770px;height:${room}px;gap:${gap}px 30px">${pairs.map((m) => `<div class="cvp" style="width:${cardW}px;height:${cardH}px;gap:${Math.round(pl * 0.18)}px"><div class="cpl" style="width:${pl}px;height:${pl}px"><img src="${asset(m.home.logo)}" alt=""></div><div class="cvs" style="font-size:${Math.round(pl * 0.38)}px">VS</div><div class="cpl" style="width:${pl}px;height:${pl}px"><img src="${asset(m.away.logo)}" alt=""></div></div>`).join('')}</div>
  <div class="cvTitle"><img src="${BRAND('compass-picks-title.webp')}" alt=""></div></div></div>`;
  if (C) {
    B.ft(`#${p}-sheen`, { x: -300 }, { x: 1100, duration: 0.65, ease: E.io }, 0.15);
    B.ft(`#${p}-cv`, { scale: 1 }, { scale: 1.03, duration: C - 0.22, ease: 'none' }, 0);
    B.ft(`#${p}-cover`, { opacity: 1 }, { opacity: 0, duration: 0.34, ease: E.io }, C - 0.22);
    B.ft(`#${p}-cv`, { scale: 1.03 }, { scale: 1.3, duration: 0.34, ease: E.io }, C - 0.22);
    B.set(`#${p}-cover`, { visibility: 'hidden' }, C + 0.13);
  }

  // hook (H.E.A.R.T. "H"): the day's strongest fact, before the title
  let hook = '';
  if (H && hookMatch) {
    const hm = hookMatch, side = H.side, other = side === 'away' ? 'home' : 'away';
    const statHTML = esc(H.stat).replace(/(\d+)/g, '<span class="hnum gold">$1</span>');
    const [rHome, rAway] = side === 'away' ? [H.rank[0], H.rank[1]] : [H.rank[1], H.rank[0]];
    const arrowD = side === 'away' ? 'M 760 0 C 640 -90 440 -90 330 -10' : 'M 320 0 C 440 -90 640 -90 750 -10';
    const ae = bezEnd(arrowD);
    hook = `<div id="${p}-hook" class="hook">
  <div class="htitle" id="${p}-ht"><span class="gold">${esc(subs[0].show)}</span></div>
  <div class="hko" id="${p}-hko">${esc(hm.kickoff_th.split(' · ')[0])} (เวลาไทย) · <img src="${asset(hm.league_logo)}" alt="">${esc(hm.league)}</div>
  <div class="plate" id="${p}-hH"><div class="halo" id="${p}-hHh"></div><div class="face" id="${p}-hHf"><img src="${asset(hm.home.logo)}" alt=""></div></div>
  <div class="plate" id="${p}-hA"><div class="halo" id="${p}-hAh"></div><div class="face" id="${p}-hAf"><img src="${asset(hm.away.logo)}" alt=""></div></div>
  <div class="hrank" id="${p}-hrH" style="left:${300 - 160}px">${esc(hm.home.name)}<b class="${side === 'home' ? 'top' : ''}">อันดับ ${rHome}</b></div>
  <div class="hrank" id="${p}-hrA" style="left:${780 - 160}px">${esc(hm.away.name)}<b class="${side === 'away' ? 'top' : ''}">อันดับ ${rAway}</b></div>
  <svg class="harrow" viewBox="0 -200 1080 300" width="1080" height="300" style="top:420px"><path id="${p}-har" d="${arrowD}" pathLength="1" fill="none" stroke="#fbbf24" stroke-width="14" stroke-linecap="round" stroke-dasharray="1 1"/><polygon id="${p}-hah" points="0,-26 22,14 -22,14" fill="#fbbf24" transform="translate(${ae.x} ${ae.y}) rotate(${ae.ang.toFixed(1)})"/></svg>
  <div class="hstat" id="${p}-hs"><div class="hline">${statHTML}</div><div class="hsub">${esc(H.statSub)}</div></div>
  <div class="hq" id="${p}-hq"><img src="${BRAND('compass-mark.webp')}" alt="" id="${p}-hqc"><span class="gold" id="${p}-hqm">?</span></div>
</div>`;
    const sel = side === 'away' ? 'hA' : 'hH', oth = side === 'away' ? 'hH' : 'hA';
    const X = { hH: 300, hA: 780 };
    const h0 = at(0) - 0.25, hEnd = at(hp) - 0.2;
    B.ft(`#${p}-ht`, { y: -80, opacity: 0, scale: 0.8 }, { y: 0, opacity: 1, scale: 1, duration: 0.5, ease: E.pop }, h0);
    B.ft(`#${p}-${sel}`, { x: X[sel] + (side === 'away' ? 640 : -640), y: 620, scale: 0.6, opacity: 0 }, { x: X[sel], y: 620, scale: 1.0, opacity: 1, duration: 0.7, ease: E.pop }, h0 + 0.05);
    B.ft(`#${p}-${oth}`, { x: X[oth] + (side === 'away' ? -640 : 640), y: 640, scale: 0.5, opacity: 0 }, { x: X[oth], y: 640, scale: 0.78, opacity: 1, duration: 0.7, ease: E.pop }, h0 + 0.15);
    B.ft(`#${p}-${sel}h`, { opacity: 0 }, { opacity: 0.9, duration: 0.5, ease: E.out }, h0 + 0.4);
    B.ft(`#${p}-${oth}f`, { filter: 'brightness(1) saturate(1)' }, { filter: 'brightness(0.6) saturate(0.5)', duration: 0.5, ease: E.out }, h0 + 0.5);
    B.ft(`#${p}-hrH`, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: E.out }, h0 + 0.55);
    B.ft(`#${p}-hrA`, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: E.out }, h0 + 0.65);
    // the stat lands on its phrase
    B.ft(`#${p}-hs`, { scale: 2.2, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.2)' }, at(1) - 0.05);
    B.ft(`#${p}-stage`, { scale: 1.04 }, { scale: 1, duration: 0.5, ease: E.out }, at(1) + 0.1);
    // "today, away at ..." : the arrow from the picked side to the other
    B.ft(`#${p}-hko`, { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4, ease: E.out }, at(2) - 0.1);
    B.ft(`#${p}-har`, { attr: { 'stroke-dashoffset': 1 } }, { attr: { 'stroke-dashoffset': 0 }, duration: 0.6, ease: E.out }, at(2));
    B.ft(`#${p}-hah`, { opacity: 0 }, { opacity: 1, duration: 0.15 }, at(2) + 0.5);
    B.ft(`#${p}-${oth}`, { rotation: 0 }, { rotation: 6, duration: 0.08, ease: 'sine.inOut', repeat: 5, yoyo: true }, at(2) + 0.55);
    // the question
    B.ft(`#${p}-hs`, { opacity: 1, y: 0 }, { opacity: 0, y: -60, duration: 0.3, ease: E.in }, at(3) - 0.15);
    B.ft(`#${p}-hq`, { scale: 0.3, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.6, ease: E.pop }, at(3) - 0.05);
    B.ft(`#${p}-hqc`, { rotation: -540 }, { rotation: 0, duration: 1.2, ease: E.out5 }, at(3) - 0.05);
    B.ft(`#${p}-hqm`, { scale: 1 }, { scale: 1.15, duration: 0.25, ease: 'sine.inOut', repeat: 3, yoyo: true }, at(3) + 0.5);
    B.ft(`#${p}-hook`, { opacity: 1, scale: 1 }, { opacity: 0, scale: 1.25, duration: 0.35, ease: E.in }, hEnd);
    B.set(`#${p}-hook`, { visibility: 'hidden' }, hEnd + 0.36);
  }

  // opening list
  const T0 = at(hp);
  let y = 430;
  const tops = { g: [], r: [] };
  M.groups.forEach((g, gi) => { if (gi) y += 18; tops.g.push(y); y += 58; tops.r.push(g.rows.map(() => { const v = y; y += 140; return v; })); });
  const listScale = Math.min(1, (1385 - 430) / (y - 10 - 430));
  let list = '';
  M.groups.forEach((g, gi) => {
    list += `<div class="ghead" id="${p}-g${gi}" style="top:${tops.g[gi]}px"><div class="lg"><img src="${asset(g.logo)}" alt=""></div><div class="nm">${esc(g.league)}</div><div class="ln" id="${p}-gl${gi}"></div></div>`;
    g.rows.forEach((r, ri) => {
      const fs = (nm) => (nm.length > 14 ? 28 : 34);
      list += `<div class="rowc" id="${p}-r${gi}_${ri}" style="top:${tops.r[gi][ri]}px"><div class="in" id="${p}-ri${gi}_${ri}">
        <div class="tm"><div class="d" id="${p}-rd${gi}_${ri}a"><img src="${asset(r.home.logo)}" alt=""></div><div class="n" style="font-size:${fs(r.home.name)}px">${esc(r.home.name)}</div></div>
        <div class="mid"><div class="vs" id="${p}-rv${gi}_${ri}">VS</div><div class="ko">${esc(r.kickoff.split(' · ')[0].replace('เตะ ', ''))}</div></div>
        <div class="tm r"><div class="n" style="font-size:${fs(r.away.name)}px">${esc(r.away.name)}</div><div class="d" id="${p}-rd${gi}_${ri}b"><img src="${asset(r.away.logo)}" alt=""></div></div></div></div>`;
    });
  });
  B.ft(`#${p}-open`, { opacity: 0 }, { opacity: 1, duration: 0.3 }, T0 - 0.25);
  B.ft(`#${p}-head`, { y: -140, scale: 0.8, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.6, ease: E.pop }, T0 - 0.1);
  B.ft(`#${p}-date`, { y: 50, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: E.pop }, at(hp + 1) - 0.05);
  B.ft(`#${p}-flash`, { opacity: 0.55 }, { opacity: 0, duration: 0.5, ease: E.out }, T0 + 0.02);
  B.ft(`#${p}-pitch`, { rotationX: 72, rotationZ: -60, scale: 0.6, opacity: 0 }, { rotationX: 62, rotationZ: -30, scale: 0.95, opacity: 0.5, duration: T - T0, ease: 'power1.out' }, T0 - 0.3);
  M.groups.forEach((g, gi) => {
    B.ft(`#${p}-g${gi}`, { x: -120, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, ease: E.pop }, at(g.at) - 0.05);
    B.ft(`#${p}-gl${gi}`, { scaleX: 0 }, { scaleX: 1, duration: 0.7, ease: E.out }, at(g.at) + 0.1);
    g.rows.forEach((r, ri) => {
      const k = `${gi}_${ri}`, t = at(r.at) - 0.05, sd = (gi + ri) % 2;
      B.ft(`#${p}-r${k}`, { opacity: 0 }, { opacity: 1, duration: 0.25 }, t);
      B.ft(`#${p}-ri${k}`, { x: sd ? -260 : 260, rotationY: sd ? 40 : -40 }, { x: 0, rotationY: 0, duration: 0.6, ease: E.pop }, t);
      B.ft(`#${p}-rd${k}a`, { scale: 0 }, { scale: 1, duration: 0.5, ease: E.spring }, t + 0.12);
      B.ft(`#${p}-rd${k}b`, { scale: 0 }, { scale: 1, duration: 0.5, ease: E.spring }, t + 0.22);
      B.ft(`#${p}-rv${k}`, { scale: 2 }, { scale: 1, duration: 0.45, ease: 'back.out(2.5)' }, t + 0.25);
    });
  });
  // exit into match 1
  const X = TL.exitAt + C;
  B.ft(`#${p}-stage`, { scale: 1 }, { scale: 1.12, duration: T - X, ease: E.in }, X);
  B.ft(`#${p}-dark`, { opacity: 0 }, { opacity: 1, duration: T - X, ease: E.in }, X);

  const css = `
.cover{position:absolute;inset:0;z-index:26;overflow:hidden;background:radial-gradient(110% 60% at 50% 46%,#123378 0%,#0a1c4a 42%,#050c22 75%,#02050f 100%)}
.cover .cv{position:absolute;inset:0;transform-origin:540px 900px}
.cglow{position:absolute;left:540px;top:1060px;width:1300px;height:900px;margin:-450px 0 0 -650px;border-radius:50%;background:radial-gradient(closest-side,rgba(251,191,36,.22),rgba(251,191,36,0))}
.cb{position:absolute;top:-300px;width:460px;height:2300px;transform-origin:50% 0;mix-blend-mode:screen;filter:blur(30px);background:linear-gradient(180deg,rgba(120,170,255,.42),rgba(60,110,255,.08) 55%,rgba(0,0,0,0) 80%)}
.cb.g{background:linear-gradient(180deg,rgba(255,200,90,.4),rgba(255,160,40,.08) 55%,rgba(0,0,0,0) 80%)}
.cvLogo{position:absolute;left:130px;top:150px;width:820px;height:250px;border-radius:44px;background:linear-gradient(180deg,#fff,#eef3fb);box-shadow:0 0 0 6px rgba(251,191,36,.95),0 0 0 12px #3a2203,0 30px 80px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;overflow:hidden}
.cvLogo img{width:740px;height:auto;display:block}
.cvLogo .sheen{position:absolute;top:-20px;bottom:-20px;width:220px;left:0;background:linear-gradient(100deg,rgba(255,255,255,0),rgba(255,255,255,.85),rgba(255,255,255,0));transform:skewX(-18deg)}
.cvH1{position:absolute;left:0;top:470px;width:1080px;text-align:center}
.cvH2{position:absolute;left:0;top:628px;width:1080px;text-align:center;font-weight:700;font-size:62px;line-height:1.3;white-space:nowrap;text-shadow:0 5px 0 #04102e,0 12px 30px rgba(0,0,0,.7)}
.cvH2 b,.date b{color:#fbbf24}
.cvGrid{position:absolute;left:40px;width:1000px;display:flex;flex-wrap:wrap;justify-content:center;align-content:center}
.cvp{display:flex;align-items:center;justify-content:center;border-radius:36px;background:linear-gradient(180deg,rgba(16,36,86,.92),rgba(5,12,34,.96));box-shadow:inset 0 0 0 3px rgba(251,191,36,.6),0 24px 60px rgba(0,0,0,.55)}
.cpl{border-radius:50%;background:linear-gradient(160deg,#fff 0%,#eef3fb 45%,#cfd9ea 100%);box-shadow:0 0 0 6px #f6b72a,0 0 0 10px #3a2203,0 14px 30px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;flex:none}
.cpl img{width:68%;height:68%;object-fit:contain}
.cvs{font-family:Barlow;font-weight:900;color:#fbbf24;text-shadow:0 4px 0 #3a2203}
.cvTitle{position:absolute;left:240px;top:1430px;width:600px}
.cvTitle img{display:block;width:600px;filter:drop-shadow(0 16px 30px rgba(0,0,0,.6))}
.hook{position:absolute;inset:0;z-index:9;transform-origin:540px 800px}
.htitle{position:absolute;left:0;top:210px;width:1080px;text-align:center;font-weight:700;font-size:92px;line-height:1.25}
.hko{position:absolute;left:0;top:345px;width:1080px;text-align:center;font-weight:600;font-size:40px;color:#cfe0ff;display:flex;justify-content:center;align-items:center;gap:14px;white-space:nowrap}
.hko img{width:52px;height:52px;object-fit:contain;background:#fff;border-radius:50%;padding:6px}
.hrank{position:absolute;top:840px;width:320px;text-align:center;font-family:Barlow;font-weight:800;font-size:40px;text-transform:uppercase;line-height:1.1;text-shadow:0 4px 0 #0a1840}
.hrank b{display:block;margin-top:10px;font-family:Plex;font-weight:700;font-size:44px;color:#9fb3e0}
.hrank b.top{color:#ffc53d;text-shadow:0 0 24px rgba(255,170,40,.7)}
.harrow{position:absolute;left:0;overflow:visible}
.hstat{position:absolute;left:0;top:990px;width:1080px;text-align:center}
.hline{font-weight:700;font-size:88px;line-height:1;white-space:nowrap}
.hnum{display:inline-block;font-family:Barlow;font-weight:900;font-size:230px;line-height:.9;margin:0 14px;vertical-align:-30px}
.hsub{margin-top:24px;font-weight:700;font-size:62px;color:#e8eefc}
.hq{position:absolute;left:0;top:1000px;width:1080px;display:flex;justify-content:center;align-items:center;gap:20px}
.hq img{width:260px;height:260px}
.hq span{display:inline-block;font-family:Barlow;font-weight:900;font-size:300px;line-height:1}
.open{position:absolute;inset:0;z-index:8}
#${p}-world{position:absolute;inset:0;perspective:1500px;perspective-origin:540px 900px}
#${p}-pitch{position:absolute;left:200px;top:500px;width:680px;height:1050px}
.head{position:absolute;left:0;width:1080px;top:170px;text-align:center}
.date{position:absolute;left:0;width:1080px;top:300px;text-align:center;font-weight:700;font-size:60px;line-height:1.2;text-shadow:0 4px 0 #04102e,0 10px 30px rgba(0,0,0,.7)}
.list{position:absolute;inset:0;transform-origin:540px 430px}
.ghead{position:absolute;left:60px;width:960px;height:52px;display:flex;align-items:center;gap:16px}
.ghead .lg{width:52px;height:52px;border-radius:50%;background:linear-gradient(160deg,#fff,#dfe7f4);box-shadow:0 0 0 4px #5b8cff;display:flex;align-items:center;justify-content:center}
.ghead .lg img{width:70%;height:70%;object-fit:contain}
.ghead .nm{font-weight:700;font-size:38px;color:#dbe6ff;white-space:nowrap;text-shadow:0 4px 18px rgba(0,0,0,.7)}
.ghead .ln{flex:1;height:4px;border-radius:2px;background:linear-gradient(90deg,rgba(251,191,36,.9),rgba(251,191,36,0));transform-origin:0 50%}
.rowc{position:absolute;left:60px;width:960px;height:126px;perspective:1200px}
.rowc .in{position:absolute;inset:0;border-radius:26px;background:linear-gradient(180deg,rgba(16,36,86,.92),rgba(6,14,38,.95));box-shadow:inset 0 0 0 2px rgba(120,160,255,.35),0 20px 50px rgba(0,0,0,.5);display:grid;grid-template-columns:385px 190px 385px;align-items:center}
.tm{display:flex;align-items:center;gap:16px;padding-left:18px}
.tm.r{justify-content:flex-end;padding:0 18px 0 0}
.tm .d{flex:none;width:92px;height:92px;border-radius:50%;background:linear-gradient(160deg,#fff,#e3eaf6);box-shadow:0 0 0 5px #f6b72a,0 0 0 9px #8a4b06;display:flex;align-items:center;justify-content:center}
.tm .d img{width:70%;height:70%;object-fit:contain}
.tm .n{font-family:Barlow;font-weight:800;text-transform:uppercase;white-space:nowrap;line-height:1}
.tm.r .n{text-align:right}
.mid{text-align:center}
.mid .vs{display:inline-block;font-family:Barlow;font-weight:900;font-style:italic;font-size:60px;line-height:1;color:#fbbf24;text-shadow:0 4px 0 #7a3a04}
.mid .ko{margin-top:4px;font-weight:600;font-size:28px;color:#9fb3e0;white-space:nowrap}`;
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  <div class="open" id="${p}-open">
    <div id="${p}-world"><div id="${p}-pitch">${pitchSVG(p)}</div></div>
    <div class="head" id="${p}-head"><div class="pill" style="font-size:66px">คู่น่าจับตาวันนี้</div></div>
    <div class="date" id="${p}-date">${esc(M.date_th).replace(/(\d+ \S+)/, '<b>$1</b>')}</div>
    <div class="list" style="transform:scale(${listScale.toFixed(3)})">${list}</div>
  </div>
  ${hook}
</div>
<div class="flash" id="${p}-flash"></div><div class="vig"></div><div class="dark" id="${p}-dark"></div>
${cover}`;
  return scene(p, css, body, B.js());
}

// ---------- c1..cN: one match ----------
function buildMatch(TL, idx) {
  const p = TL.key, M = TL.match, T = TL.T, subs = TL.subs;
  const [, S1, S2, S3raw] = TL.scenes; const R = TL.reveal;
  const last = idx === N, S3 = last ? S3raw : T + 100;
  const END = last ? S3 + 0.25 : T; // the last match hands over to the outro scene
  const seg1 = subs.filter((s) => s.seg === 1), seg0 = subs.filter((s) => s.seg === 0);
  const pt = (i) => seg1[Math.min(i, seg1.length - 1)].t0;
  if (M.pick.type !== 'team') throw new Error(`${p}: hf.cjs draws team picks only (got ${M.pick.type})`);
  const st = M.stats, tactic = st.tactic || 'attack-away', side = M.pick.side;
  const B = TLB();
  const amb = ambient(p, END, 7 + idx);
  amb.tl.forEach((a) => B.ft(...a));
  const sp = sparks(p, 's', 44, 100 + idx), sp2 = sparks(p, 'k', 30, 200 + idx);
  B.set(`#${p}-stage`, { scale: 1, x: 0 }, 0);
  B.set(`#${p}-flash`, { opacity: 0 }, 0);

  // pitch + tactics
  const GOLD = '#fbbf24', BLUE = '#7cc4ff';
  const arrows = tactic === 'open'
    ? [['M 200 300 C 180 480 230 650 270 840', GOLD], ['M 470 280 C 500 470 440 640 410 860', GOLD], ['M 260 760 C 230 600 300 420 300 230', BLUE], ['M 520 800 C 560 600 500 420 450 210', BLUE]]
    : [['M 170 230 C 140 420 210 620 250 800', GOLD], ['M 340 180 C 360 420 320 640 340 860', GOLD], ['M 520 250 C 560 450 480 640 430 810', GOLD]];
  let tac = `<g ${tactic === 'attack-home' ? 'transform="translate(0 1050) scale(1 -1)"' : ''}>
<rect id="${p}-zt" x="20" y="20" width="640" height="505" fill="#fbbf24" opacity="0"/><rect id="${p}-zb" x="20" y="525" width="640" height="505" fill="#60a5fa" opacity="0"/>`;
  arrows.forEach(([d, c], i) => {
    const e = bezEnd(d);
    tac += `<g id="${p}-ar${i}" opacity="0"><path d="${d}" pathLength="1" fill="none" stroke="${c}" stroke-width="34" stroke-linecap="round" opacity=".25" stroke-dasharray="1 1" id="${p}-ag${i}"/><path d="${d}" pathLength="1" fill="none" stroke="${c}" stroke-width="14" stroke-linecap="round" stroke-dasharray="1 1" id="${p}-ap${i}"/><polygon id="${p}-ah${i}" points="0,-26 22,14 -22,14" fill="${c}" transform="translate(${e.x} ${e.y}) rotate(${e.ang.toFixed(1)})" opacity="0"/></g>`;
  });
  tac += `<g id="${p}-wall" opacity="0"><rect x="60" y="770" width="560" height="16" rx="8" fill="#bfe3ff"/><rect x="60" y="760" width="560" height="36" rx="18" fill="#7cc4ff" opacity=".35"/>${[0, 1, 2, 3].map((i) => `<circle cx="${130 + i * 140}" cy="778" r="24" fill="#0b1d4a" stroke="#bfe3ff" stroke-width="7"/>`).join('')}</g></g>`;

  // plates: [x, y, scale] per phase (intro, analysis, drumroll, reveal)
  const P = {
    L: [[540, 545, 0.62], [540, 268, 0.36], [540, 250, 0.3], [540, 250, 0.3]],
    H: [[290, 935, 1], [170, 268, 0.42], [215, 820, 0.7], side === 'home' ? [540, 700, 1.4] : [880, 470, 0.55]],
    A: [[790, 935, 1], [910, 268, 0.42], [865, 820, 0.7], side === 'away' ? [540, 700, 1.4] : [200, 470, 0.55]],
  };
  const sel = side === 'home' ? 'H' : 'A', oth = side === 'home' ? 'A' : 'H';
  const ent = { L: [0.3, 0, -520], H: [0.62, -640, 0], A: [0.78, 640, 0] };
  for (const k of ['L', 'H', 'A']) {
    const [t0, dx, dy] = ent[k], q = P[k];
    B.ft(`#${p}-p${k}`, { x: q[0][0] + dx, y: q[0][1] + dy, scale: q[0][2] * 0.4, opacity: 0 }, { x: q[0][0], y: q[0][1], scale: q[0][2], opacity: 1, duration: 0.8, ease: E.pop }, t0);
    B.ft(`#${p}-p${k}d`, { rotationY: k === 'L' ? 200 : (k === 'H' ? -95 : 95) }, { rotationY: 0, duration: 1.0, ease: E.out }, t0);
    B.ft(`#${p}-p${k}`, { x: q[0][0], y: q[0][1], scale: q[0][2] }, { x: q[1][0], y: q[1][1], scale: q[1][2], duration: 0.7, ease: E.io }, S1 - 0.05);
    B.ft(`#${p}-p${k}`, { x: q[1][0], y: q[1][1], scale: q[1][2] }, { x: q[2][0], y: q[2][1], scale: q[2][2], duration: 0.7, ease: E.io }, S2 - 0.05);
    B.ft(`#${p}-p${k}`, { x: q[2][0], y: q[2][1], scale: q[2][2] }, { x: q[3][0], y: q[3][1], scale: q[3][2], duration: 0.6, ease: E.pop }, R);
  }
  B.ft(`#${p}-p${sel}h`, { opacity: 0 }, { opacity: 0.95, duration: 0.4, ease: E.out }, R);
  B.ft(`#${p}-p${oth}f`, { filter: 'brightness(1) saturate(1)' }, { filter: 'brightness(0.45) saturate(0.4)', duration: 0.5, ease: E.out }, R);
  B.set(`#${p}-p${sel}`, { zIndex: 9 }, R);
  B.ft(`#${p}-spot`, { opacity: 0, scaleX: 0.7 }, { opacity: 0.9, scaleX: 1, duration: 0.5, ease: E.out }, R);

  // intro text (E: the chip names the tension of the match)
  B.ft(`#${p}-head`, { y: -160, scale: 0.8, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.6, ease: E.pop }, 0.12);
  if (seg0[1]) B.ft(`#${p}-emo`, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2.2)' }, seg0[1].t0 - 0.05);
  B.ft(`#${p}-lname`, { y: 30, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: E.out }, 0.75);
  B.ft(`#${p}-nH`, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: E.pop }, 1.05);
  B.ft(`#${p}-nA`, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: E.pop }, 1.1);
  B.ft(`#${p}-vs`, { scale: 2.6, rotation: -12, opacity: 0 }, { scale: 1, rotation: 0, opacity: 1, duration: 0.5, ease: 'back.out(2.4)' }, 1.2);
  B.ft(`#${p}-meta`, { y: 40, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: E.out }, 1.5);
  B.ft(`#${p}-flash`, { opacity: 0.45 }, { opacity: 0, duration: 0.35, ease: E.out }, 1.2);
  for (const id of ['head', 'emo', 'lname', 'nH', 'nA', 'vs', 'meta']) B.ft(`#${p}-${id}`, { opacity: 1 }, { opacity: 0, duration: 0.3, ease: E.in }, S1 - 0.2);
  sp2.burst(B, 1.2, 540, 935);

  // pitch camera
  B.ft(`#${p}-pitch`, { y: 160, rotationX: 70, rotationZ: -70, scale: 0.55, opacity: 0 }, { y: 40, rotationX: 60, rotationZ: -38, scale: 0.92, opacity: 1, duration: 1.3, ease: E.out5 }, 0);
  B.ft(`#${p}-pitch`, { y: 40, rotationX: 60, rotationZ: -38, scale: 0.92 }, { y: 0, rotationX: 46, rotationZ: 0, scale: 1, duration: 0.9, ease: E.io }, S1 - 0.05);
  B.ft(`#${p}-pitch`, { y: 0, rotationX: 46, rotationZ: 0, scale: 1 }, { y: 10, rotationX: 64, rotationZ: 26, scale: 0.9, duration: 0.9, ease: E.io }, S2 - 0.05);
  B.ft(`#${p}-pitch`, { rotationZ: 26 }, { rotationZ: 26 + (END - S2) * 5, duration: END - S2 - 0.9, ease: 'none' }, S2 + 0.85);
  // tactics (A: the arrows draw as the first reason is spoken)
  arrows.forEach((_, i) => {
    const t0 = pt(0) + i * 0.14;
    B.ft(`#${p}-ar${i}`, { opacity: 0 }, { opacity: 1, duration: 0.1 }, t0);
    for (const k of ['ap', 'ag']) B.ft(`#${p}-${k}${i}`, { attr: { 'stroke-dashoffset': 1 } }, { attr: { 'stroke-dashoffset': 0 }, duration: 0.75, ease: E.out5 }, t0);
    B.ft(`#${p}-ah${i}`, { opacity: 0 }, { opacity: 1, duration: 0.15 }, t0 + 0.55);
    B.ft(`#${p}-ar${i}`, { opacity: 1 }, { opacity: 0, duration: 0.35 }, S2 - 0.1);
  });
  if (tactic !== 'open') {
    B.ft(`#${p}-zt`, { opacity: 0 }, { opacity: 0.16, duration: 0.5, ease: E.out }, pt(0));
    B.ft(`#${p}-zt`, { opacity: 0.16 }, { opacity: 0, duration: 0.35 }, S2 - 0.1);
    if (st.defend !== undefined) {
      const td = pt(st.defend);
      B.ft(`#${p}-wall`, { opacity: 0, y: 120 }, { opacity: 1, y: 0, duration: 0.6, ease: E.spring }, td);
      B.ft(`#${p}-zb`, { opacity: 0 }, { opacity: 0.14, duration: 0.4 }, td);
      B.ft(`#${p}-wall`, { opacity: 1 }, { opacity: 0, duration: 0.35 }, S2 - 0.1);
      B.ft(`#${p}-zb`, { opacity: 0.14 }, { opacity: 0, duration: 0.35 }, S2 - 0.1);
    }
  }

  // reasons card + the big number of each reason (A: one number at a time, as it is spoken)
  const hl = (t, h) => (h ? esc(t).split(esc(h)).join('<b>' + esc(h) + '</b>') : esc(t));
  const logoOf = (s) => asset(s === 'home' ? M.home.logo : M.away.logo);
  const mark = '<div class="mk"><svg viewBox="0 0 40 40" width="44" height="44"><path d="M9 21 L17 29 L32 12" fill="none" stroke="#2a1400" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>';
  const card = `<div class="title">${esc(st.title || 'เหตุผลจากข้อมูล')}</div>` + st.rows.map((r, i) => `<div class="rrow${r.team ? '' : ' why'}" id="${p}-row${i}">${r.team ? `<img src="${logoOf(r.team)}" alt="">` : mark}<div class="tx">${hl(r.text, r.hi)}</div></div>`).join('');
  const cardAt = Math.max(S1 + 0.05, Math.min(...st.rows.map((r) => pt(r.at))) - 0.2);
  B.ft(`#${p}-card`, { y: 260, scale: 0.92, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.6, ease: E.pop }, cardAt);
  B.ft(`#${p}-card`, { opacity: 1 }, { opacity: 0, duration: 0.35, ease: E.in }, S2 - 0.15);
  st.rows.forEach((r, i) => {
    const t0 = pt(r.at) + st.rows.filter((x, j) => j < i && x.at === r.at).length * 0.18;
    B.ft(`#${p}-row${i}`, { x: i % 2 ? 80 : -80, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: E.pop }, t0);
  });
  const bigs = st.rows.map((r, i) => ({ ...r, i, t0: pt(r.at) })).filter((r) => r.big);
  let bigHTML = '';
  bigs.forEach((b, k) => {
    const tEnd = k + 1 < bigs.length ? bigs[k + 1].t0 - 0.05 : S2 - 0.15;
    bigHTML += `<div class="big" id="${p}-big${k}"><div class="bn gold">${esc(b.big)}</div><div class="bl">${b.team ? `<img src="${logoOf(b.team)}" alt="">` : ''}${esc(b.bigLabel || '')}</div></div>`;
    B.ft(`#${p}-big${k}`, { scale: 1.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.45, ease: 'back.out(2)' }, b.t0 + 0.05);
    B.ft(`#${p}-big${k}`, { opacity: 1 }, { opacity: 0, duration: 0.25, ease: E.in }, tEnd - 0.25);
    B.ft(`#${p}-stage`, { scale: 1.025 }, { scale: 1, duration: 0.45, ease: E.out }, b.t0 + 0.1);
  });
  B.ft(`#${p}-shade`, { opacity: 0 }, { opacity: 0.5, duration: 0.4 }, bigs.length ? bigs[0].t0 : S2);
  B.ft(`#${p}-shade`, { opacity: 0.5 }, { opacity: 0, duration: 0.3 }, S2 - 0.15);

  // drumroll (compass) -> R: the reveal
  B.ft(`#${p}-cmp`, { scale: 0, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: E.pop }, S2 + 0.05);
  B.ft(`#${p}-cmpi`, { rotation: 0 }, { rotation: 900 + (R - S2) * 60, duration: R - S2, ease: 'power2.out' }, S2 + 0.05);
  const rp = Math.max(0, Math.floor((R - S2) / 0.42) - 1);
  B.ft(`#${p}-cmpr`, { scale: 1, opacity: 1 }, { scale: 1.3, opacity: 0, duration: 0.42, ease: 'none', repeat: rp }, S2 + 0.1);
  B.ft(`#${p}-cmp`, { scale: 1 }, { scale: 1.8, opacity: 0, duration: 0.3, ease: E.out }, R - 0.05);
  B.ft(`#${p}-flash`, { opacity: 0.85 }, { opacity: 0, duration: 0.6, ease: E.out }, R);
  B.ft(`#${p}-stage`, { scale: 1.07, x: -10 }, { scale: 1, x: 0, duration: 0.6, ease: E.spring }, R);
  sp.burst(B, R, 540, 700);
  B.ft(`#${p}-pick`, { y: 120, scale: 0.9, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.55, ease: E.pop }, R + 0.12);
  B.ft(`#${p}-pline`, { scale: 2.2, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(2.2)' }, R + 0.3);
  if (!last) {
    const X = TL.exitAt;
    B.ft(`#${p}-stage`, { scale: 1 }, { scale: 1.12, duration: T - X, ease: E.in }, X);
    B.ft(`#${p}-dark`, { opacity: 0 }, { opacity: 1, duration: T - X, ease: E.in }, X);
  } else {
    B.ft(`#${p}-dark`, { opacity: 0 }, { opacity: 1, duration: 0.3, ease: E.in }, S3 - 0.1);
  }

  // pick text: the team, then the pick in football words (facts pick.fan, lib.cjs fanPick), never the betting line
  // (owner 2026-11-11: TikTok removed a film that showed "+0.25")
  if (!M.pick.fan) throw new Error(`${p}: facts.json has no pick.fan; run fetch.cjs again`);
  const pickName = M.pick.fan.team, fanText = M.pick.fan.text;
  const progress = Array.from({ length: N }, (_, i) => `<i class="${i < idx ? 'on' : ''}"></i>`).join('');
  const css = `
#${p}-world{position:absolute;inset:0;perspective:1500px;perspective-origin:540px 700px}
#${p}-pitch{position:absolute;left:200px;top:335px;width:680px;height:1050px}
.spotc{position:absolute;left:90px;top:-200px;width:900px;height:1200px;background:linear-gradient(180deg,rgba(255,225,150,0),rgba(255,215,120,.35) 60%,rgba(255,200,90,0));clip-path:polygon(42% 0,58% 0,100% 100%,0 100%);filter:blur(18px);mix-blend-mode:screen;transform-origin:50% 0}
.tname{position:absolute;top:1135px;width:460px;text-align:center;font-family:Barlow;font-weight:800;letter-spacing:1px;text-transform:uppercase;line-height:1;white-space:nowrap;text-shadow:0 4px 0 #0a1840,0 10px 30px rgba(0,0,0,.6)}
.vsx{position:absolute;left:390px;top:850px;width:300px;text-align:center;font-family:Barlow;font-weight:900;font-style:italic;font-size:150px;line-height:160px;color:#ffd166;text-shadow:0 6px 0 #7a3a04,0 14px 24px rgba(0,0,0,.7)}
.mhead{position:absolute;left:0;width:1080px;text-align:center;top:190px}
.prog{display:flex;justify-content:center;gap:12px;margin-top:18px}
.prog i{display:block;width:44px;height:10px;border-radius:5px;background:rgba(255,255,255,.2)}
.prog i.on{background:#fbbf24;box-shadow:0 0 14px rgba(251,191,36,.7)}
.emo{position:absolute;left:0;width:1080px;top:345px;text-align:center}
.emo span{display:inline-block;padding:10px 34px 14px;border-radius:18px;background:rgba(6,14,38,.85);box-shadow:inset 0 0 0 3px #fbbf24,0 12px 30px rgba(0,0,0,.5);font-weight:700;font-size:46px;color:#ffd166;white-space:nowrap}
.lname{position:absolute;left:90px;top:668px;width:900px;text-align:center;font-weight:700;font-size:44px;color:#cfe0ff;text-shadow:0 4px 18px rgba(0,0,0,.7)}
.meta{position:absolute;left:90px;top:1250px;width:900px;text-align:center;font-weight:600;font-size:40px;color:#e8eefc;text-shadow:0 3px 0 #04102e,0 0 18px #04102e}
.meta b{color:#fbbf24}.meta span{display:block;margin-top:8px;font-size:32px;color:#93a8d6}
.shade{position:absolute;left:0;top:380px;width:1080px;height:560px;background:radial-gradient(60% 50% at 50% 50%,rgba(2,6,20,.85),rgba(2,6,20,0));opacity:0}
.big{position:absolute;left:0;top:470px;width:1080px;text-align:center}
.big .bn{font-family:Barlow;font-weight:900;font-size:250px;line-height:1;white-space:nowrap}
.big .bl{display:flex;justify-content:center;align-items:center;gap:16px;margin-top:6px;font-weight:700;font-size:46px;color:#fff;text-shadow:0 4px 0 #04102e,0 0 20px #04102e}
.big .bl img{width:64px;height:64px;object-fit:contain;background:#eef3fb;border-radius:50%;padding:7px;box-shadow:0 0 0 3px #f6b72a}
.card{position:absolute;left:70px;top:930px;width:940px;border-radius:34px;padding:22px 40px 24px;background:linear-gradient(180deg,rgba(14,32,78,.97),rgba(6,14,38,.98));box-shadow:inset 0 0 0 2px rgba(120,160,255,.35),0 30px 80px rgba(0,0,0,.55)}
.card .title{font-weight:700;font-size:40px;color:#fbbf24;text-align:center;margin-bottom:10px}
.rrow{display:flex;align-items:center;gap:22px;min-height:100px;padding:6px 0}
.rrow+.rrow{border-top:2px solid rgba(120,160,255,.16)}
.rrow img{flex:none;width:76px;height:76px;object-fit:contain;background:#eef3fb;border-radius:50%;padding:9px;box-shadow:0 0 0 4px #f6b72a}
.rrow .mk{flex:none;width:76px;height:76px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,#ffd166,#f59e0b);box-shadow:0 0 24px rgba(251,191,36,.55)}
.rrow .tx{flex:1;font-weight:700;font-size:42px;line-height:1.22;color:#e8eefc}
.rrow .tx b{color:#fbbf24}
.cmp{position:absolute;left:425px;top:705px;width:230px;height:230px}
.cmp img{width:100%;height:100%}
.cmp .ring{position:absolute;inset:-40px;border-radius:50%;box-shadow:0 0 0 6px rgba(251,191,36,.9),0 0 60px rgba(251,191,36,.7)}
.pick{position:absolute;left:90px;top:965px;width:900px;text-align:center;padding:14px 20px 18px;border-radius:34px;background:linear-gradient(180deg,rgba(6,14,38,.82),rgba(4,10,28,.92));box-shadow:inset 0 0 0 2px rgba(251,191,36,.45),0 24px 60px rgba(0,0,0,.5)}
.pick .k{display:inline-flex;align-items:center;gap:14px;font-weight:700;font-size:40px;color:#fbbf24}
.pick .k img{width:62px;height:62px}
.pick .nm{margin-top:4px;font-family:Barlow;font-weight:900;line-height:1.02;letter-spacing:1px;text-transform:uppercase;white-space:nowrap}
.pick .ln{display:inline-block;font-weight:700;line-height:1.2;white-space:nowrap}
.pick .note{margin-top:10px;font-weight:600;font-size:30px;color:#9fb3e0}`;
  const plate = (k, logo, league) => `<div class="plate${league ? ' league' : ''}" id="${p}-p${k}"><div class="halo" id="${p}-p${k}h"></div><div id="${p}-p${k}d" style="position:absolute;inset:0;transform-style:preserve-3d"><div class="face" id="${p}-p${k}f"><img src="${asset(logo)}" alt=""></div></div></div>`;
  const nmFs = (n) => nameSize(n, 62);
  const pkFs = Math.min(118, Math.floor(900 / (pickName.length * 0.5)));
  const fanFs = Math.min(120, Math.floor(860 / (fanText.replace(/[ัิ-ฺ็-๎]/g, '').length * 0.55)));
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  <div id="${p}-world"><div id="${p}-pitch">${pitchSVG(p, { inner: tac })}</div></div>
  <div class="spotc" id="${p}-spot" style="opacity:0"></div>
  ${plate('L', M.league_logo, true)}${plate('H', M.home.logo)}${plate('A', M.away.logo)}
  <div class="tname" id="${p}-nH" style="left:60px;font-size:${nmFs(M.home.name)}px">${esc(M.home.name)}</div>
  <div class="tname" id="${p}-nA" style="left:560px;font-size:${nmFs(M.away.name)}px">${esc(M.away.name)}</div>
  <div class="vsx" id="${p}-vs">VS</div>
  <div class="mhead" id="${p}-head"><div class="pill">${esc(M.head || `คู่ที่ ${idx}`)}</div><div class="prog">${progress}</div></div>
  ${seg0[1] ? `<div class="emo" id="${p}-emo"><span>${esc(seg0[1].show)}</span></div>` : ''}
  <div class="lname" id="${p}-lname">${esc(M.league)}</div>
  <div class="meta" id="${p}-meta"><b>${esc(M.kickoff_th)}</b> (เวลาไทย)<span>${esc(M.venue || '')}</span></div>
  <div class="shade" id="${p}-shade"></div>
  ${bigHTML}
  <div class="card" id="${p}-card">${card}</div>
  <div class="cmp" id="${p}-cmp"><div class="ring" id="${p}-cmpr"></div><img id="${p}-cmpi" src="${BRAND('compass-mark.webp')}" alt=""></div>
  <div class="pick" id="${p}-pick"><div class="k"><img src="${BRAND('compass-mark.webp')}" alt="">เข็มทิศเกม</div><div class="nm gold" style="font-size:${pkFs}px">${esc(pickName)}</div><div id="${p}-pline"><span class="ln gold" style="font-size:${fanFs}px">${esc(fanText)}</span></div><div class="note">มุมมองจากข้อมูล ไม่ใช่ผลที่แน่นอน</div></div>
  ${sp.html}${sp2.html}
</div>
<div class="flash" id="${p}-flash"></div><div class="vig"></div><div class="dark" id="${p}-dark"></div>`;
  return { html: scene(p, css, body, B.js()), END };
}

// ---------- outro (T: take action, then the brand alone) ----------
function buildOutro(TL, from) {
  const p = 'outro', T = TL.T - from;
  const subs = TL.subs.filter((s) => s.seg === 3).map((s) => ({ ...s, t0: s.t0 - from, t1: s.t1 - from }));
  const at = (i) => subs[Math.min(i, subs.length - 1)].t0;
  const B = TLB();
  const amb = ambient(p, T, 77);
  amb.tl.forEach((a) => B.ft(...a));
  const sp = sparks(p, 's', 40, 333);
  B.set(`#${p}-flash`, { opacity: 0 }, 0);
  B.ft(`#${p}-flash`, { opacity: 0.5 }, { opacity: 0, duration: 0.5 }, 0.05);
  B.ft(`#${p}-logo`, { y: -120, scale: 0.8, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.6, ease: E.pop }, 0.1);
  B.ft(`#${p}-sheen`, { x: -300 }, { x: 1100, duration: 0.8, ease: E.io }, 0.5);
  B.ft(`#${p}-l1`, { x: -100, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: E.pop }, at(0) - 0.05);
  B.ft(`#${p}-l2`, { x: 100, opacity: 0 }, { x: 0, opacity: 1, duration: 0.45, ease: E.pop }, at(1) - 0.05);
  B.ft(`#${p}-url`, { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(2.2)' }, at(2) - 0.05);
  B.ft(`#${p}-urlsh`, { x: -400 }, { x: 900, duration: 0.7, ease: E.io }, at(2) + 0.3);
  B.ft(`#${p}-fol`, { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: E.pop }, at(3) - 0.05);
  B.ft(`#${p}-folb`, { scale: 1 }, { scale: 1.08, duration: 0.22, ease: 'sine.inOut', repeat: 3, yoyo: true }, at(3) + 0.35);
  B.ft(`#${p}-com`, { y: 80, opacity: 0 }, { y: 0, opacity: 1, duration: 0.45, ease: E.pop }, at(4) - 0.05);
  B.ft(`#${p}-comq`, { scale: 0.6, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.4, ease: 'back.out(2.2)' }, at(5) - 0.05);
  // the brand alone: nothing else on screen
  const tb = at(6) - 0.15;
  B.ft(`#${p}-cta`, { opacity: 1, scale: 1 }, { opacity: 0, scale: 0.9, duration: 0.3, ease: E.in }, tb - 0.1);
  B.set(`#${p}-cta`, { visibility: 'hidden' }, tb + 0.21);
  B.ft(`#${p}-rays`, { opacity: 0, scale: 0.8, rotation: 0 }, { opacity: 0.9, scale: 1, rotation: (T - tb) * 14, duration: T - tb, ease: 'none' }, tb);
  B.ft(`#${p}-brandin`, { y: 120, rotationX: 70, scale: 0.6, opacity: 0 }, { y: 0, rotationX: 0, scale: 1, opacity: 1, duration: 0.9, ease: E.pop }, tb + 0.1);
  B.ft(`#${p}-bsheen`, { backgroundPosition: '120% 0' }, { backgroundPosition: '-60% 0', duration: 0.9, ease: E.io }, tb + 0.6);
  B.ft(`#${p}-flash`, { opacity: 0.6 }, { opacity: 0, duration: 0.5, ease: E.out }, tb + 0.35);
  sp.burst(B, tb + 0.35, 540, 900);
  const css = `
.ologo{position:absolute;left:180px;top:240px;width:720px;height:220px;border-radius:40px;background:linear-gradient(180deg,#fff,#eef3fb);box-shadow:0 0 0 6px rgba(251,191,36,.95),0 0 0 12px #3a2203,0 30px 80px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;overflow:hidden}
.ologo img{width:650px;height:auto}
.ologo .sheen{position:absolute;top:-20px;bottom:-20px;width:220px;left:0;background:linear-gradient(100deg,rgba(255,255,255,0),rgba(255,255,255,.85),rgba(255,255,255,0));transform:skewX(-18deg)}
.cta{position:absolute;inset:0;transform-origin:540px 800px}
.oline{position:absolute;left:120px;width:840px;display:flex;align-items:center;gap:22px;font-weight:700;font-size:50px;white-space:nowrap}
.oline .mk{flex:none;width:68px;height:68px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,#ffd166,#f59e0b);box-shadow:0 0 24px rgba(251,191,36,.55)}
.url{position:absolute;left:0;top:780px;width:1080px;text-align:center}
.url .u{position:relative;display:inline-block;padding:22px 50px 26px;border-radius:28px;background:#0b1d4a;box-shadow:inset 0 0 0 5px #fbbf24,0 20px 50px rgba(0,0,0,.5);font-family:Barlow;font-weight:800;font-size:76px;color:#fff;overflow:hidden;white-space:nowrap}
.url .u b{color:#fbbf24}
.url .sh{position:absolute;top:0;bottom:0;width:160px;left:0;background:linear-gradient(100deg,rgba(255,255,255,0),rgba(255,255,255,.35),rgba(255,255,255,0))}
.fol{position:absolute;left:0;top:990px;width:1080px;text-align:center}
.fol .b{display:inline-flex;align-items:center;gap:18px;padding:18px 56px 22px;border-radius:999px;background:linear-gradient(180deg,#ffd166,#f59e0b 60%,#d9730a);color:#1a0d00;font-weight:700;font-size:58px;box-shadow:0 8px 0 #7a3a04,0 20px 50px rgba(245,158,11,.45);white-space:nowrap}
.com{position:absolute;left:150px;top:1185px;width:780px;padding:22px 34px 26px;border-radius:30px 30px 30px 6px;background:#fff;color:#0b1324;font-weight:700;font-size:46px;line-height:1.3;box-shadow:0 20px 50px rgba(0,0,0,.5)}
.com span{display:inline-block;color:#d9730a}
.rays{position:absolute;left:-360px;top:0;width:1800px;height:1800px;background:repeating-conic-gradient(from 0deg,rgba(251,191,36,.22) 0deg 5deg,rgba(251,191,36,0) 5deg 15deg);-webkit-mask:radial-gradient(closest-side,#000 0%,rgba(0,0,0,.6) 40%,transparent 75%);mask:radial-gradient(closest-side,#000 0%,rgba(0,0,0,.6) 40%,transparent 75%);mix-blend-mode:screen}
.brand{position:absolute;left:90px;top:640px;width:900px;perspective:1200px}
.brand .in{position:relative}
.brand img{display:block;width:900px;filter:drop-shadow(0 24px 40px rgba(0,0,0,.6))}
.brand .sheen{position:absolute;inset:0;-webkit-mask:url(${BRAND('compass-picks-title.webp')}) center/contain no-repeat;mask:url(${BRAND('compass-picks-title.webp')}) center/contain no-repeat;background:linear-gradient(105deg,rgba(255,255,255,0) 40%,rgba(255,255,255,.95) 50%,rgba(255,255,255,0) 60%);background-size:300% 100%;mix-blend-mode:screen}
.tag{position:absolute;left:0;top:1160px;width:1080px;text-align:center;font-weight:700;font-size:64px;text-shadow:0 4px 0 #04102e,0 10px 30px rgba(0,0,0,.7)}`;
  const body = `<div class="stage" id="${p}-stage">${amb.html}
  <div class="rays" id="${p}-rays" style="opacity:0"></div>
  <div class="cta" id="${p}-cta">
    <div class="ologo" id="${p}-logo"><img src="${BRAND('logo-lockup.webp')}" alt=""><div class="sheen" id="${p}-sheen"></div></div>
    <div class="oline" id="${p}-l1" style="top:530px"><div class="mk"><svg viewBox="0 0 40 40" width="40" height="40"><path d="M9 21 L17 29 L32 12" fill="none" stroke="#2a1400" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>อ่านเหตุผลเต็มทุกคู่</div>
    <div class="oline" id="${p}-l2" style="top:630px"><div class="mk"><svg viewBox="0 0 40 40" width="40" height="40"><path d="M9 21 L17 29 L32 12" fill="none" stroke="#2a1400" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg></div>ผลงานย้อนหลังทุกคู่ วัดผลจริง</div>
    <div class="url" id="${p}-url"><div class="u">khemthit<b>football</b>.com<div class="sh" id="${p}-urlsh"></div></div></div>
    <div class="fol" id="${p}-fol"><div class="b" id="${p}-folb">กดติดตาม เข็มทิศฟุตบอล</div></div>
    <div class="com" id="${p}-com">คอมเมนต์บอกเรา <span id="${p}-comq">คู่ไหนที่คุณรอดู?</span></div>
  </div>
  <div class="brand"><div class="in" id="${p}-brandin"><img src="${BRAND('compass-picks-title.webp')}" alt=""><div class="sheen" id="${p}-bsheen"></div></div></div>
  ${sp.html}
</div>
<div class="flash" id="${p}-flash"></div><div class="vig"></div>`;
  return scene(p, css, body, B.js());
}

// ---------- captions: every subtitle phrase on the film clock ----------
function buildCaptions(starts) {
  const p = 'cap', B = TLB();
  let html = '';
  const all = [];
  TLs.forEach((TL, ci) => { const off = starts[ci] + (TL.cover || 0); TL.subs.forEach((s) => all.push({ ...s, t0: s.t0 + off, t1: s.t1 + off })); });
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
.cbg{position:absolute;left:0;top:1370px;width:1080px;height:340px;background:radial-gradient(60% 50% at 50% 50%,rgba(2,6,20,.7),rgba(2,6,20,0))}
.grp{position:absolute;left:60px;top:1410px;width:960px;text-align:center;visibility:hidden;overflow:visible}
.grp .tx{font-weight:700;font-size:62px;line-height:1.34;color:#fff;text-shadow:0 4px 0 #04102e,0 0 2px #04102e,0 10px 28px rgba(0,0,0,.8)}
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

// ---------- assemble ----------
fs.mkdirSync(path.join(HF, 'compositions'), { recursive: true });
for (const d of ['fonts', 'logos', 'brand']) fs.mkdirSync(path.join(HF, 'assets', d), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, 'assets', 'fonts'))) fs.copyFileSync(path.join(ROOT, 'assets', 'fonts', f), path.join(HF, 'assets', 'fonts', f));
const logos = new Set();
clips.forEach((c) => { if (c.type === 'opening') c.groups.forEach((g) => { logos.add(g.logo); g.rows.forEach((r) => { logos.add(r.home.logo); logos.add(r.away.logo); }); }); else { logos.add(c.league_logo); logos.add(c.home.logo); logos.add(c.away.logo); } });
for (const l of logos) fs.copyFileSync(path.join(ROOT, l), path.join(HF, l));
for (const f of ['logo-lockup.webp', 'compass-mark.webp', 'compass-picks-title.webp']) fs.copyFileSync(path.join(REPO, 'apps', 'web', 'public', 'brand', f), path.join(HF, 'assets', 'brand', f));

// the film clock: each clip lasts a whole number of frames (as join.cjs)
const durs = TLs.map((t) => t.frames / FPS);
const starts = []; let acc = 0; for (const d of durs) { starts.push(r3(acc)); acc += d; }
const TOTAL = r3(acc);

// one audio track: every clip's mix (audio.cjs) trimmed to its frames, in order
{
  const ins = [], filt = [];
  TLs.forEach((t, i) => { ins.push('-i', path.join(DAY, 'out', t.key, 'mix.wav')); filt.push(`[${i}:a]atrim=0:${(t.frames / FPS).toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`); });
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...ins, '-filter_complex', filt.join(';') + ';' + TLs.map((_, i) => `[a${i}]`).join('') + `concat=n=${TLs.length}:v=0:a=1[a]`, '-map', '[a]', '-ar', '48000', path.join(HF, 'assets', 'mix.wav')]);
}

const hosts = [];
fs.writeFileSync(path.join(HF, 'compositions', 'c0.html'), buildOpening(TLs[0]));
hosts.push({ id: 'c0', start: starts[0], dur: durs[0], z: 1 });
let outroFrom = null;
TLs.slice(1).forEach((TL, i) => {
  const { html, END } = buildMatch(TL, i + 1);
  fs.writeFileSync(path.join(HF, 'compositions', `${TL.key}.html`), html);
  hosts.push({ id: TL.key, start: starts[i + 1], dur: r3(Math.min(END, durs[i + 1])), z: 1 });
  if (i + 1 === N) outroFrom = TL.scenes[3] - 0.1;
});
const lastTL = TLs[N];
fs.writeFileSync(path.join(HF, 'compositions', 'outro.html'), buildOutro(lastTL, outroFrom));
hosts.push({ id: 'outro', start: r3(starts[N] + outroFrom), dur: r3(durs[N] - outroFrom), z: 2 });
fs.writeFileSync(path.join(HF, 'compositions', 'captions.html'), buildCaptions(starts));

const index = `<!doctype html>
<html lang="th">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=1080, height=1920" />
    <title>คู่น่าจับตาวันนี้ ${date}</title>
    <script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: 1080px; height: 1920px; overflow: hidden; background: #02060f; }
      #root { position: relative; width: 100%; height: 100%; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${TOTAL}" data-width="1080" data-height="1920" data-fps="${FPS}">
${hosts.map((h, i) => `      <div id="${h.id}" data-composition-id="${h.id}" data-composition-src="compositions/${h.id}.html" data-start="${h.start}" data-duration="${h.dur}" data-track-index="${h.z}" data-track-kind="graphics" data-width="1080" data-height="1920" style="z-index:${h.z}"></div>`).join('\n')}
      <div id="cap" data-composition-id="cap" data-composition-src="compositions/captions.html" data-start="0" data-duration="${TOTAL}" data-track-index="5" data-track-kind="captions" data-width="1080" data-height="1920" style="z-index:10"></div>
      <audio id="mix" class="clip" src="assets/mix.wav" data-start="0" data-duration="${TOTAL}" data-track-index="8" data-volume="1"></audio>
    </div>
    <script>
      window.__timelines["main"] = gsap.timeline({ paused: true });
    </script>
  </body>
</html>
`;
fs.writeFileSync(path.join(HF, 'index.html'), index);
fs.writeFileSync(path.join(HF, 'hyperframes.json'), JSON.stringify({ $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json', registry: 'https://raw.githubusercontent.com/heygen-com/hyperframes/main/registry', paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' }, media: { autoProxy: true }, authoringSkill: 'hyperframes' }, null, 2));
fs.writeFileSync(path.join(HF, 'meta.json'), JSON.stringify({ id: `spotlight-${date}`, name: `คู่น่าจับตาวันนี้ ${date}` }, null, 2));
fs.writeFileSync(path.join(HF, 'package.json'), JSON.stringify({ name: `spotlight-${date}`, private: true, type: 'module', scripts: { dev: 'npx --yes hyperframes@0.9.23 preview', check: 'npx --yes hyperframes@0.9.23 check', render: 'npx --yes hyperframes@0.9.23 render' } }, null, 2));
console.log(`days/${date}/hf: ${hosts.map((h) => `${h.id}@${h.start}+${h.dur}`).join(' ')} cap · total ${TOTAL}s`);

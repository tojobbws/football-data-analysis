// Shared HyperFrames scene kit (helpers copied from hf.cjs: GSAP timeline builder, fonts, the incumbent navy/gold look,
// ambient beams + embers, spark bursts, the scene wrapper). Used by insight.cjs.
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

module.exports = { r3, esc, mulberry, TLB, E, FONTS, BASE, ambient, sparks, pitchSVG, scene, nameSize, BRAND };

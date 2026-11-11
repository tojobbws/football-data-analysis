// The cover: film 0 -> C s of a page (recap.html, opening.html), the thumbnail frame of the film.
// The site logo on a white plate, a gold title, the date, every team of the list in pick pairs (real logos only)
// and the เข็มทิศเกม title. Every frame is complete from frame 0; it only breathes, then zooms out into the page.
// usage: const cover = makeCover({ C, title, dateHTML, pairs: [{ home: { logo }, away: { logo } }], before: <element> });
//        cover(t) on every seek (t = film time); C = 0 -> no cover.
(function () {
  const CSS = `
#cover{position:absolute;inset:0;z-index:26;overflow:hidden;background:radial-gradient(110% 60% at 50% 46%,#123378 0%,#0a1c4a 42%,#050c22 75%,#02050f 100%);font-family:Plex,sans-serif;color:#fff}
#cover .cv{position:absolute;inset:0;transform-origin:540px 900px}
#cover .glow{position:absolute;left:540px;top:1060px;width:1300px;height:900px;margin:-450px 0 0 -650px;border-radius:50%;background:radial-gradient(closest-side,rgba(251,191,36,.22),rgba(251,191,36,0))}
#cover .cb{position:absolute;top:-300px;width:460px;height:2300px;transform-origin:50% 0;mix-blend-mode:screen;filter:blur(30px);background:linear-gradient(180deg,rgba(120,170,255,.42),rgba(60,110,255,.08) 55%,rgba(0,0,0,0) 80%)}
#cover .cb.g{background:linear-gradient(180deg,rgba(255,200,90,.4),rgba(255,160,40,.08) 55%,rgba(0,0,0,0) 80%)}
#cvLogo{position:absolute;left:540px;top:150px;width:820px;height:250px;margin-left:-410px;border-radius:44px;background:linear-gradient(180deg,#ffffff,#eef3fb);box-shadow:0 0 0 6px rgba(251,191,36,.95),0 0 0 12px #3a2203,0 30px 80px rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;overflow:hidden}
#cvLogo img{width:740px;height:auto;display:block}
#cvLogo .sheen{position:absolute;top:-20px;bottom:-20px;width:220px;left:0;background:linear-gradient(100deg,rgba(255,255,255,0),rgba(255,255,255,.85),rgba(255,255,255,0));transform:translateX(-300px) skewX(-18deg)}
#cvH1{position:absolute;left:0;top:470px;width:1080px;text-align:center}
#cvH1 .pill{display:inline-block;padding:16px 54px 20px;border-radius:999px;background:linear-gradient(180deg,#ffd166,#f59e0b 60%,#d9730a);color:#1a0d00;font-weight:700;font-size:80px;line-height:1.12;white-space:nowrap;box-shadow:0 8px 0 #7a3a04,0 22px 60px rgba(245,158,11,.45)}
#cvH2{position:absolute;left:0;top:628px;width:1080px;text-align:center;font-weight:700;font-size:62px;line-height:1.3;white-space:nowrap;text-shadow:0 5px 0 #04102e,0 12px 30px rgba(0,0,0,.7)}
#cvH2 b{color:#fbbf24}
#cvGrid{position:absolute;left:40px;width:1000px;display:flex;flex-wrap:wrap;justify-content:center;align-content:center}
.cvp{display:flex;align-items:center;justify-content:center;border-radius:36px;background:linear-gradient(180deg,rgba(16,36,86,.92),rgba(5,12,34,.96));box-shadow:inset 0 0 0 3px rgba(251,191,36,.6),0 24px 60px rgba(0,0,0,.55)}
.cvp .pl{border-radius:50%;background:radial-gradient(circle at 38% 30%,#fff 0%,#eef3fb 45%,#cfd9ea 100%);box-shadow:0 0 0 6px #f6b72a,0 0 0 10px #3a2203,0 14px 30px rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;flex:none}
.cvp .pl img{width:68%;height:68%;object-fit:contain}
.cvp .vs{font-family:Barlow;font-weight:900;color:#fbbf24;text-shadow:0 4px 0 #3a2203}
#cvTitle{position:absolute;left:540px;top:1430px;width:600px;margin-left:-300px}
#cvTitle img{display:block;width:600px;filter:drop-shadow(0 16px 30px rgba(0,0,0,.6))}`;
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const prog = (t, a, b) => clamp((t - a) / (b - a));
  const io = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  const lerp = (a, b, u) => a + (b - a) * u;
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');

  window.makeCover = function ({ C, title, dateHTML, pairs, before }) {
    if (!C) return () => {};
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    const root = document.createElement('div'); root.id = 'cover';
    root.innerHTML = `<div class="cv">
      <div class="cb" style="left:-120px;transform:rotate(-16deg)"></div><div class="cb g" style="left:310px;transform:rotate(6deg)"></div><div class="cb g" style="left:420px;transform:rotate(-6deg)"></div><div class="cb" style="left:760px;transform:rotate(16deg)"></div>
      <div class="glow"></div>
      <div id="cvLogo"><img src="brand/logo-lockup.webp"><div class="sheen"></div></div>
      <div id="cvH1"><div class="pill">${esc(title)}</div></div>
      <div id="cvH2">${dateHTML}</div>
      <div id="cvGrid"></div>
      <div id="cvTitle"><img src="brand/compass-picks-title.webp"></div></div>`;
    before.parentNode.insertBefore(root, before);
    // one card per match: one column for 1-2 matches, two columns from 3; the cards shrink to fit the room
    const n = pairs.length, cols = n <= 2 ? 1 : 2, rows = Math.ceil(n / cols);
    const top = 770, room = 620, gap = 26, cardH = Math.min(n <= 2 ? 280 : 240, (room - (rows - 1) * gap) / rows), pl = Math.round(cardH * 0.7), cardW = cols === 1 ? 780 : 470;
    const g = root.querySelector('#cvGrid'); g.style.top = top + 'px'; g.style.height = room + 'px'; g.style.gap = `${gap}px 30px`;
    g.innerHTML = pairs.map((m) => `<div class="cvp" style="width:${cardW}px;height:${cardH}px;gap:${Math.round(pl * 0.18)}px"><div class="pl" style="width:${pl}px;height:${pl}px"><img src="${m.home.logo}"></div><div class="vs" style="font-size:${Math.round(pl * 0.38)}px">VS</div><div class="pl" style="width:${pl}px;height:${pl}px"><img src="${m.away.logo}"></div></div>`).join('');
    const cv = root.querySelector('.cv'), sheen = root.querySelector('#cvLogo .sheen'), cards = [...root.querySelectorAll('.cvp')];
    return function cover(t) {
      const x = io(prog(t, C - 0.22, C + 0.12));
      root.style.visibility = x >= 1 ? 'hidden' : 'visible';
      root.style.opacity = 1 - x;
      cv.style.transform = `scale(${(1 + 0.03 * prog(t, 0, C)) * (1 + 0.25 * x)})`;
      sheen.style.transform = `translateX(${lerp(-300, 1100, io(prog(t, 0.15, 0.8)))}px) skewX(-18deg)`;
      cards.forEach((p, i) => { p.style.transform = `translateY(${Math.sin(t * 3 + i * 1.3) * 4}px)`; });
    };
  };
})();

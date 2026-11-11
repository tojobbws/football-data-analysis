// Merge the day's facts (from fetch.cjs) with the written script (spot.json) into clips.json:
// c0 = opening, c1..cN = one clip per match in spot.matches order; the last clip carries the brand outro.
// Checks that every subtitle phrase is a verbatim, in-order piece of its voice segment.
// usage: node prepare.cjs [YYYY-MM-DD]
const path = require('path');
const { dateArg, dayDir, readJson, writeJson } = require('./lib.cjs');

const date = dateArg();
const dir = dayDir(date);
const facts = readJson(path.join(dir, 'facts.json'));
const spot = readJson(path.join(dir, 'spot.json'));
const byKey = (k) => { const m = facts.matches.find((x) => x.key === k); if (!m) throw new Error(`unknown match ${k}`); return JSON.parse(JSON.stringify(m)); };
const errors = [];
const BANNED = ['ทีเด็ด', 'แทง', 'กำไร', 'ตามคู่นี้', 'การันตี', 'ชัวร์', 'แน่นอน'];

function check(where, segments, subs) {
  segments.forEach((seg, i) => {
    for (const w of BANNED) if (seg.includes(w)) errors.push(`${where} s${i}: banned word "${w}"`);
    let cur = 0;
    for (const p of subs[i] || []) {
      const ix = seg.indexOf(p.say, cur);
      if (ix < 0) errors.push(`${where} s${i}: subtitle "${p.say}" is not in the voice text (in order)`);
      else cur = ix + p.say.length;
      for (const h of p.hi || []) if (!p.show.includes(h)) errors.push(`${where} s${i}: highlight "${h}" is not in "${p.show}"`);
    }
  });
}

const clips = [];
const o = spot.opening;
const opening = { key: 'c0', type: 'opening', page: 'opening.html', date_th: o.date_th || facts.date_th, hook: o.hook, segments: [o.segment], subs: [o.subs], groups: o.groups.map((g) => ({ ...g, rows: g.rows.map((r) => { const m = byKey(r.match); return { ...r, home: m.home, away: m.away, kickoff: m.kickoff_th }; }) })) };
check('opening', opening.segments, opening.subs);
clips.push(opening);
spot.matches.forEach((s, i) => {
  const m = byKey(s.match);
  const last = i === spot.matches.length - 1;
  const c = { ...m, key: `c${i + 1}`, src: s.match, head: s.head || `คู่ที่ ${i + 1}`, stats: s.stats, segments: [...s.segments], subs: [...s.subs] };
  if (c.segments.length !== 3) errors.push(`${c.key}: a match needs 3 voice segments (intro, analysis, pick)`);
  if (last) { c.segments.push(spot.outro.segment); c.subs.push(spot.outro.subs); }
  check(c.key, c.segments, c.subs);
  clips.push(c);
});
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
writeJson(path.join(dir, 'clips.json'), clips);
console.log(`days/${date}/clips.json: ${clips.map((c) => c.key + (c.src ? `=${c.src}` : '')).join(' ')}`);

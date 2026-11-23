// Pack the intro film's facts into data.js (window.DATA) and copy the pictures it draws into intro/assets.
// Inputs: night.json (the 7 Nov list), record.json (every featured pick), script.json + vo/*.json (voice timing).
const fs = require('fs'); const path = require('path');
const { readJson } = require('../lib.cjs');
const H = __dirname, V = path.resolve(H, '..');
const cp = (from, to) => { fs.mkdirSync(path.dirname(path.join(H, to)), { recursive: true }); fs.copyFileSync(path.join(V, from), path.join(H, to)); return to; };
const night = readJson(path.join(H, 'night.json'));
const rec = readJson(path.join(H, 'record.json'));
const script = readJson(path.join(H, 'script.json'));
const logos = new Set();
const L = (p) => { if (!p) return null; logos.add(p); return p; };
// the list as it stood at 14:30 on 7 Nov (pick time): leagues in page order, the five picks of that pick day flagged
const picks1107 = new Set(rec.days.find((d) => d.date === '2026-11-07').matches.map((m) => String(m.fixture_id)));
const leagues = [];
for (const m of night.matches) {
  let lg = leagues[leagues.length - 1];
  if (!lg || lg.name !== m.league) { lg = { name: m.league, country: m.country, logo: L(m.league_logo), matches: [] }; leagues.push(lg); }
  lg.matches.push({ id: String(m.id), time: m.time, home: m.home, away: m.away, hl: L(m.home_logo), al: L(m.away_logo), done: m.done_at_pick, score: m.done_at_pick ? m.score : null, pick: picks1107.has(String(m.id)) });
}
const hero = rec.days.find((d) => d.date === '2026-11-07').matches.find((m) => m.home === 'Parma');
L(hero.home_logo); L(hero.away_logo);
// every settled featured pick, oldest first, for the record wall
const settled = rec.days.flatMap((d) => d.matches.map((m) => ({ ...m, date: d.date }))).filter((m) => ['WIN', 'HALF_WIN', 'LOSS', 'HALF_LOSS', 'PUSH', 'VOID'].includes(m.status))
  .map((m) => ({ id: String(m.fixture_id), date: m.date, home: m.home, away: m.away, logo: L(m.pick_logo), hl: L(m.home_logo), al: L(m.away_logo), pick: m.pick, result: ['WIN', 'HALF_WIN'].includes(m.status) ? 'win' : ['LOSS', 'HALF_LOSS'].includes(m.status) ? 'loss' : 'push', score: m.score }));
for (const p of logos) cp(p, p);
for (const f of ['compass-mark.webp', 'compass-picks-title.webp', 'logo-lockup.webp', 'result-win.webp', 'result-loss.webp', 'result-push.webp'])
  fs.copyFileSync(path.join(V, '..', '..', 'apps', 'web', 'public', 'brand', f), path.join(H, 'assets', f));
for (const f of fs.readdirSync(path.join(V, 'assets', 'fonts')).filter((f) => f.startsWith('ibm-plex'))) cp(path.join('assets', 'fonts', f), path.join('assets', 'fonts', f));
// voice: when each line and each on-screen row starts (row i starts at the spoken word given in KEYS)
const KEYS = [['วันนี้', 'ดูคู่'], ['คัด', 'ให้ทุกวัน'], ['อ่าน', 'โบโล'], ['แล้ว', 'ก่อนเตะ'], ['จบเกม', 'ตรวจ'], ['ถูก', 'ไม่ลบ'], ['ดู', 'กด']];
const vo = script.lines.map((l, i) => {
  const j = readJson(path.join(H, 'vo', `s${i}.json`)); const a = j.alignment; const txt = a.characters.join('');
  const at = (k) => { const ix = txt.indexOf(k, txt.indexOf(']') + 1); if (ix < 0) throw new Error(`s${i}: no "${k}"`); return a.character_start_times_seconds[ix]; };
  return { id: l.id, file: `vo/s${i}.mp3`, screen: l.screen, rows: KEYS[i].map(at), end: a.character_end_times_seconds.at(-1) };
});
const data = { night: { date: '2026-11-07', count: night.count, label: 'วันเสาร์ที่ 7 พฤศจิกายน', leagues }, hero: { home: hero.home, away: hero.away, hl: hero.home_logo, al: hero.away_logo, league: hero.league, kickoff: '00:00', saved: '14:30', savedDate: '7 พ.ย.', pick: hero.pick, team: 'Bologna', score: hero.score, result: 'win', form: ['W', 'L', 'W', 'W', 'W'] },
  record: { since: rec.count.first_day, settled, fetched_at: rec.fetched_at }, vo };
fs.writeFileSync(path.join(H, 'data.js'), 'window.DATA=' + JSON.stringify(data) + ';\n');
console.log('leagues', leagues.length, 'matches', night.count, 'logos', logos.size, 'settled', settled.length, 'hero', hero.pick, hero.score);
console.log(vo.map((v) => `${v.id} rows ${v.rows.map((x) => x.toFixed(2)).join('/')} end ${v.end.toFixed(2)}`).join('\n'));

// The 2026-11-07 football-day list as the home page groups it (06:00 -> 06:00 Thai), in its pre-kickoff state:
// leagues in page order, kickoff times, teams, logos, featured flags. Matched to the live page's rows (home-1107.json).
const path = require('path'); const fs = require('fs');
const { Client } = require('pg');
const { writeJson, logo, readJson } = require('../lib.cjs');
const slug = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
(async () => {
  const page = readJson(path.join(__dirname, 'assets', 'real', 'home-1107.json'));
  const hrefs = page.rows.filter((r) => r.y > 250).map((r) => ({ href: r.href, y: r.y, featured: /0\.961893/.test(r.ring) }));
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const rows = (await c.query(`select f.id, f.kickoff_at, f.goals_home, f.goals_away, f.status_short, l.id lid, l.name league, l.logo_url llogo, l.country, h.id hid, h.name home, h.logo_url hlogo, a.id aid, a.name away, a.logo_url alogo
    from fixtures f join leagues l on l.id = f.league_id join teams h on h.id = f.home_team_id join teams a on a.id = f.away_team_id
    where f.kickoff_at >= '2026-11-06T12:00:00Z' and f.kickoff_at < '2026-11-07T23:00:00Z'`)).rows;
  const byHref = {};
  for (const r of rows) { const th = new Date(new Date(r.kickoff_at).getTime() + 7 * 3600e3).toISOString().slice(0, 10); byHref[`/matches/${slug(r.home)}-vs-${slug(r.away)}-${th}`] = r; const ut = new Date(r.kickoff_at).toISOString().slice(0, 10); byHref[`/matches/${slug(r.home)}-vs-${slug(r.away)}-${ut}`] ||= r; }
  const out = []; const miss = [];
  for (const h of hrefs) {
    const r = byHref[h.href]; if (!r) { miss.push(h.href); continue; }
    const t = new Date(new Date(r.kickoff_at).getTime() + 7 * 3600e3);
    out.push({ id: r.id, league: r.league, country: r.country, league_logo: await logo(r.llogo, `leagues-${r.lid}.png`), time: t.toISOString().slice(11, 16), done_at_pick: new Date(r.kickoff_at) < new Date('2026-11-07T07:30:13Z'), score: [r.goals_home, r.goals_away], home: r.home, away: r.away,
      home_logo: await logo(r.hlogo, `teams-${r.hid}.png`), away_logo: await logo(r.alogo, `teams-${r.aid}.png`), featured: h.featured, page_y: h.y });
  }
  writeJson(path.join(__dirname, 'night.json'), { date: '2026-11-07', count: out.length, matches: out });
  console.log('matched', out.length, 'of', hrefs.length, 'featured', out.filter((m) => m.featured).map((m) => `${m.time} ${m.home}-${m.away}`).join(' | '));
  if (miss.length) console.log('missing', miss.slice(0, 10));
  await c.end();
})();

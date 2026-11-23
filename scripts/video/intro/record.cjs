// The intro film's facts: every featured day's list (same list version and newest-round pick as /performance and
// recap-fetch.cjs), with settled results, the all-time count, and candidate hero matches. Writes intro/record.json.
const path = require('path');
const { Client } = require('pg');
const { writeJson, fanPick, RESULT_WORD, logo } = require('../lib.cjs');
const VERSIONS = ['featured-v2', 'featured-ai-v1', 'featured-ai-v2', 'featured-ai-v3', 'featured-ai-v4'];
const listVersion = (vs) => ['featured-ai-v4', 'featured-ai-v3', 'featured-ai-v2', 'featured-ai-v1', 'featured-v2'].find((v) => vs.includes(v)) || null;
(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (s, p) => (await c.query(s, p)).rows;
  const sel = await q(`select football_date::text d, fixture_id, rank, version from featured_selections where version = any($1) and rank is not null order by football_date`, [VERSIONS]);
  const byDay = {};
  for (const r of sel) (byDay[r.d] ||= []).push(r);
  const days = [];
  for (const [d, rs] of Object.entries(byDay)) {
    const v = listVersion(rs.map((r) => r.version));
    const ms = [];
    for (const r of rs.filter((x) => x.version === v)) {
      const [f] = await q(`select f.id, f.kickoff_at, f.status_short, f.goals_home, f.goals_away, l.name league, h.id hid, h.name home, h.logo_url hlogo, a.id aid, a.name away, a.logo_url alogo
        from fixtures f join leagues l on l.id = f.league_id join teams h on h.id = f.home_team_id join teams a on a.id = f.away_team_id where f.id = $1`, [r.fixture_id]);
      const [p] = await q(`select id, publish_round, kind, market, selection, line, status, published_at from analysis_predictions where fixture_id = $1 order by published_at desc, id desc limit 1`, [r.fixture_id]);
      if (!p || p.kind !== 'SIGNAL') continue;
      const fan = fanPick({ market: p.market, side: p.selection, line: p.line, home: f.home, away: f.away });
      const side = String(p.selection).toLowerCase();
      const hl = await logo(f.hlogo, `teams-${f.hid}.png`), al = await logo(f.alogo, `teams-${f.aid}.png`);
      ms.push({ rank: r.rank, fixture_id: f.id, league: f.league, home: f.home, away: f.away, home_logo: hl, away_logo: al, side, pick_logo: side === 'home' ? hl : side === 'away' ? al : null, kickoff_at: f.kickoff_at, status_short: f.status_short, score: [f.goals_home, f.goals_away], market: p.market, pick: fan.label, status: p.status, result: RESULT_WORD[p.status] || p.status, published_at: p.published_at, round: p.publish_round });
    }
    days.push({ date: d, version: v, matches: ms });
  }
  const all = days.flatMap((d) => d.matches);
  const n = (ss) => all.filter((m) => ss.includes(m.status)).length;
  const count = { picks: all.length, shown_right: n(['WIN', 'HALF_WIN']), shown_wrong: n(['LOSS', 'HALF_LOSS']), push: n(['PUSH']), void: n(['VOID']), pending: all.length - n(['WIN', 'HALF_WIN', 'LOSS', 'HALF_LOSS', 'PUSH', 'VOID']), first_day: days[0] && days[0].date, last_day: days[days.length - 1] && days[days.length - 1].date };
  writeJson(path.join(__dirname, 'record.json'), { fetched_at: new Date().toISOString(), count, days });
  console.log(JSON.stringify(count));
  for (const d of days.slice(-12)) console.log(d.date, d.version, d.matches.map((m) => `${m.home}-${m.away} ${m.score.join('-')} [${m.market} ${m.pick}] ${m.result}`).join(' | '));
  await c.end();
})();

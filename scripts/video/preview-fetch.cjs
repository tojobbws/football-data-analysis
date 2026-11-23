// Big-match preview film facts: both sides' league season, home/away splits, formations, players, injuries, the last
// meetings and the incoming coach's record against the opponent. Read-only from the production DB. The facts file is
// the only source of numbers for the film script (match-preview.cjs rejects any other number).
// usage: node preview-fetch.cjs <fixtureId> [--coach "Pochettino"] [--coach-side away]
const path = require('path');
const { Client } = require('pg');
const { ROOT, writeJson, logo } = require('./lib.cjs');

const args = process.argv.slice(2);
const FX = Number(args[0]);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const COACH = opt('--coach'), COACH_SIDE = opt('--coach-side') || 'away';
const DONE = ['FT', 'AET', 'PEN'];
const res = (f, a) => (f > a ? 'W' : f === a ? 'D' : 'L');

(async () => {
  if (!FX) throw new Error('usage: node preview-fetch.cjs <fixtureId>');
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('set default_transaction_read_only = on');
  const q = async (s, p) => (await c.query(s, p)).rows;
  const [fx] = await q(`select f.*, v.name venue from fixtures f left join venues v on v.id = f.venue_id where f.id = $1`, [FX]);
  if (!fx) throw new Error(`fixture ${FX} not found`);
  const teams = await q(`select id, name, logo_url from teams where id = any($1)`, [[fx.home_team_id, fx.away_team_id]]);
  const T = Object.fromEntries(teams.map((t) => [t.id, t]));

  async function side(id) {
    const ms = await q(`select f.id, f.kickoff_at, f.home_team_id h, f.away_team_id a, f.ft_home fh, f.ft_away fa, o.name opp, o.id opp_id,
        (select formation from fixture_lineups l where l.fixture_id = f.id and l.team_id = $1) formation,
        (select coach_name from fixture_lineups l where l.fixture_id = f.id and l.team_id = $1) coach
      from fixtures f join teams o on o.id = case when f.home_team_id = $1 then f.away_team_id else f.home_team_id end
      where f.league_id = $2 and f.season = $3 and (f.home_team_id = $1 or f.away_team_id = $1) and f.status_short = any($4) and f.ft_home is not null and f.kickoff_at < $5
      order by f.kickoff_at`, [id, fx.league_id, fx.season, DONE, fx.kickoff_at]);
    const ev = await q(`select fixture_id, elapsed, extra, team_id, player_name from fixture_events where fixture_id = any($1) and type = 'Goal' and detail <> 'Missed Penalty'`, [ms.map((m) => m.id)]);
    const matches = ms.map((m) => {
      const home = m.h === id, gf = home ? m.fh : m.fa, ga = home ? m.fa : m.fh;
      let es = ev.filter((e) => e.fixture_id === m.id);
      const adds = (x) => x.filter((e) => e.team_id === id).length === gf && x.filter((e) => e.team_id !== id).length === ga;
      if (!adds(es) && adds(es.filter((e) => e.player_name))) es = es.filter((e) => e.player_name);
      const ok = adds(es);
      // led at some point but did not win: needs the running score, so only for a match whose events add up
      let led = false, run = 0;
      if (ok) for (const e of [...es].sort((x, y) => x.elapsed - y.elapsed || (x.extra || 0) - (y.extra || 0))) { run += e.team_id === id ? 1 : -1; if (run > 0) led = true; }
      return { led_not_won: ok ? led && gf <= ga : null, fixture_id: Number(m.id), date: m.kickoff_at.toISOString().slice(0, 10), venue: home ? 'home' : 'away', opponent: m.opp, opponent_id: m.opp_id, gf, ga, res: res(gf, ga),
        formation: m.formation, coach: m.coach, timeline_ok: ok,
        late_for: ok ? es.filter((e) => e.team_id === id && e.elapsed > 75).length : null, late_against: ok ? es.filter((e) => e.team_id !== id && e.elapsed > 75).length : null };
    });
    const sum = (list) => ({ played: list.length, w: list.filter((m) => m.res === 'W').length, d: list.filter((m) => m.res === 'D').length, l: list.filter((m) => m.res === 'L').length,
      gf: list.reduce((s, m) => s + m.gf, 0), ga: list.reduce((s, m) => s + m.ga, 0), clean_sheets: list.filter((m) => m.ga === 0).length, results: list.map((m) => `${m.gf}-${m.ga}`) });
    const formations = {};
    for (const m of matches) formations[m.formation || '?'] = (formations[m.formation || '?'] || 0) + 1;
    const coaches = {};
    for (const m of matches) coaches[m.coach || '?'] = (coaches[m.coach || '?'] || 0) + 1;
    const okM = matches.filter((m) => m.timeline_ok);
    const [st] = await q(`select rank, points, played, win, draw, lose, goals_for, goals_against, source_updated_at from standings where league_id = $1 and season = $2 and team_id = $3`, [fx.league_id, fx.season, id]);
    const players = await q(`select p.name, s.position, s.appearances, s.minutes, s.goals, s.assists, s.shots_on, s.passes_key from player_season_stats s join players p on p.id = s.player_id
      where s.team_id = $1 and s.league_id = $2 and s.season = $3 and coalesce(s.minutes, 0) > 0 order by coalesce(s.goals, 0) + coalesce(s.assists, 0) desc, s.minutes desc limit 12`, [id, fx.league_id, fx.season]);
    const lead = (k) => { const top = [...players].sort((a, b) => (b[k] || 0) - (a[k] || 0))[0]; return { name: top.name, value: top[k] }; };
    const inj = await q(`select player_name, type, reason from injuries where fixture_id = $1 and team_id = $2 order by type desc, player_name`, [FX, id]);
    const all = sum(matches);
    return {
      id, name: T[id].name, logo: await logo(T[id].logo_url, `teams-${id}.png`),
      standing: st, ...all, points: all.w * 3 + all.d,
      home: sum(matches.filter((m) => m.venue === 'home')), away: sum(matches.filter((m) => m.venue === 'away')),
      last5: matches.slice(-5).map((m) => m.res).join(''), formations, coaches,
      led_not_won: okM.filter((m) => m.led_not_won).map((m) => `${m.opponent} ${m.gf}-${m.ga}`),
      late: { matches_checked: okM.length, of: matches.length, scored_after_75: okM.reduce((s, m) => s + m.late_for, 0), conceded_after_75: okM.reduce((s, m) => s + m.late_against, 0) },
      players, leaders: { goals: lead('goals'), assists: lead('assists'), key_passes: lead('passes_key'), shots_on: lead('shots_on') },
      out: inj.filter((x) => x.type === 'Missing Fixture').map((x) => ({ name: x.player_name, reason: x.reason })),
      doubtful: inj.filter((x) => x.type !== 'Missing Fixture').map((x) => ({ name: x.player_name, reason: x.reason })),
      matches,
    };
  }

  const home = await side(fx.home_team_id), away = await side(fx.away_team_id);
  const h2h = (await q(`select f.id, f.kickoff_at, f.league_id, f.home_team_id h, f.ft_home fh, f.ft_away fa from fixtures f
    where ((home_team_id = $1 and away_team_id = $2) or (home_team_id = $2 and away_team_id = $1)) and status_short = any($3) and kickoff_at < $4 order by kickoff_at desc limit 6`,
  [fx.home_team_id, fx.away_team_id, DONE, fx.kickoff_at])).map((m) => ({ fixture_id: Number(m.id), date: m.kickoff_at.toISOString().slice(0, 10), league_id: m.league_id,
    home: T[m.h].name, home_id: m.h, away_id: m.h === fx.home_team_id ? fx.away_team_id : fx.home_team_id, score: `${m.fh}-${m.fa}`,
    winner: m.fh === m.fa ? null : (m.fh > m.fa ? m.h : (m.h === fx.home_team_id ? fx.away_team_id : fx.home_team_id)) }));

  let coach = null;
  if (COACH) {
    const opp = COACH_SIDE === 'away' ? fx.home_team_id : fx.away_team_id;
    const rows = await q(`select f.id, f.kickoff_at, f.league_id, lg.name league, l.team_id, t.name team, f.home_team_id h, f.ft_home fh, f.ft_away fa from fixture_lineups l
      join fixtures f on f.id = l.fixture_id join teams t on t.id = l.team_id join leagues lg on lg.id = f.league_id
      where l.coach_name ilike $1 and (f.home_team_id = $2 or f.away_team_id = $2) and l.team_id <> $2 and f.status_short = any($3) order by f.kickoff_at`, [`%${COACH}%`, opp, DONE]);
    const list = rows.map((m) => { const home = m.h === m.team_id, gf = home ? m.fh : m.fa, ga = home ? m.fa : m.fh;
      return { fixture_id: Number(m.id), date: m.kickoff_at.toISOString().slice(0, 10), league: m.league, league_id: m.league_id, team: m.team, team_id: m.team_id, venue: home ? 'home' : 'away', gf, ga, res: res(gf, ga) }; });
    coach = { name: COACH, side: COACH_SIDE, opponent_id: opp, note: 'only matches whose lineup carries this coach name in the DB', played: list.length,
      w: list.filter((m) => m.res === 'W').length, d: list.filter((m) => m.res === 'D').length, l: list.filter((m) => m.res === 'L').length, matches: list };
  }
  await c.end();

  const facts = {
    topic: 'match-preview', fixture: { id: FX, league_id: fx.league_id, season: fx.season, round: fx.round, kickoff_utc: fx.kickoff_at.toISOString(), venue: fx.venue, status: fx.status_short },
    fetched_at: new Date().toISOString(), source: 'fixtures, fixture_lineups, fixture_events, standings, player_season_stats, injuries (API-Football), production DB, read-only',
    home, away, h2h, coach,
  };
  const slug = `${fx.home_team_id}-${fx.away_team_id}-${fx.kickoff_at.toISOString().slice(0, 10)}-preview`;
  writeJson(path.join(ROOT, 'insights', slug, 'facts.json'), facts);
  for (const s of [home, away]) {
    console.log(`${s.name}: ${s.played} ${s.w}-${s.d}-${s.l} ${s.gf}:${s.ga} pts ${s.points} (table ${s.standing?.points} rank ${s.standing?.rank}) · home ${s.home.w}-${s.home.d}-${s.home.l} ${s.home.gf}:${s.home.ga} · away ${s.away.w}-${s.away.d}-${s.away.l} ${s.away.gf}:${s.away.ga} · CS ${s.clean_sheets} · form ${JSON.stringify(s.formations)} · coach ${JSON.stringify(s.coaches)}`);
    console.log(`   late (${s.late.matches_checked}/${s.late.of} checked): for ${s.late.scored_after_75} against ${s.late.conceded_after_75} · leaders ${JSON.stringify(s.leaders)}`);
    console.log(`   out: ${s.out.map((x) => x.name).join(', ')} · doubtful: ${s.doubtful.map((x) => x.name).join(', ')}`);
  }
  console.log('h2h', h2h.map((m) => `${m.date} ${m.home} ${m.score}`).join(' | '));
  if (coach) console.log(`coach ${coach.name}: ${coach.played} ${coach.w}-${coach.d}-${coach.l}`, coach.matches.map((m) => `${m.date} ${m.team} ${m.gf}-${m.ga} ${m.league}`).join(' | '));
  console.log(`-> insights/${slug}/facts.json`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

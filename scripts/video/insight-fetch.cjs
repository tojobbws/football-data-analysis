// "ข้อมูลที่เว็บอื่นไม่บอก" facts: the league table as it would stand if every match had ended at minute 75.
// Reads finished fixtures and their goal events from production (read-only), rebuilds the score at 75' of
// every match, and writes insights/<league>-<season>-late75/facts.json, the only source for the film script.
// A goal at minute 76 or later (90+x included) is a late goal; 75' itself is still inside the cut.
// usage: node insight-fetch.cjs [leagueId=39] [season=2026]
const path = require('path');
const { Client } = require('pg');
const { ROOT, writeJson, MONTHS_FULL, logo } = require('./lib.cjs');

const CUT = 75;
const [LEAGUE, SEASON] = [Number(process.argv[2] || 39), Number(process.argv[3] || 2026)];
const DONE = ['FT', 'AET', 'PEN'];
const pts = (f, a) => (f > a ? 3 : f === a ? 1 : 0);
const minute = (e) => `${e.elapsed}${e.extra ? '+' + e.extra : ''}`;

/** Position in a table: points, goal difference, goals for, then name (stable, no shared places). */
function rankBy(rows, P, GD, GF) {
  const s = [...rows].sort((a, b) => b[P] - a[P] || b[GD] - a[GD] || b[GF] - a[GF] || a.name.localeCompare(b.name));
  s.forEach((r, i) => { r[P === 'pts' ? 'rank' : 'rank75'] = i + 1; });
}

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query('set default_transaction_read_only = on');
  const q = async (s, p) => (await c.query(s, p)).rows;
  const [lg] = await q(`select id, name, logo_url from leagues where id = $1`, [LEAGUE]);
  if (!lg) throw new Error(`league ${LEAGUE} not found`);
  const fx = await q(`select id, round, kickoff_at, home_team_id h, away_team_id a, ft_home fh, ft_away fa from fixtures
    where league_id = $1 and season = $2 and status_short = any($3) and ft_home is not null order by kickoff_at`, [LEAGUE, SEASON, DONE]);
  if (!fx.length) throw new Error('no finished fixtures');
  const ev = await q(`select fixture_id, seq, elapsed, extra, team_id, player_name, detail from fixture_events
    where fixture_id = any($1) and type = 'Goal' and detail <> 'Missed Penalty' order by fixture_id, elapsed, coalesce(extra, 0), seq`, [fx.map((f) => f.id)]);
  const teamRows = await q(`select id, name, logo_url from teams where id = any($1)`, [[...new Set(fx.flatMap((f) => [f.h, f.a]))]]);
  const standings = await q(`select team_id, rank, points, played from standings where league_id = $1 and season = $2`, [LEAGUE, SEASON]);
  await c.end();

  const byF = {};
  for (const e of ev) (byF[e.fixture_id] ||= []).push(e);
  const T = {};
  for (const t of teamRows) T[t.id] = { id: t.id, name: t.name, logo_url: t.logo_url, gp: 0, pts: 0, gf: 0, ga: 0, pts75: 0, gf75: 0, ga75: 0, lateF: 0, lateA: 0, ledAt: 0, ledWon: 0, droppedFromLead: 0, swings: [] };
  const skipped = [];
  let goals = 0, late = 0, counted = 0, changed = 0;
  const adds = (es, f) => es.filter((e) => e.team_id === f.h).length === f.fh && es.filter((e) => e.team_id === f.a).length === f.fa && es.length === f.fh + f.fa;
  for (const f of fx) {
    // own goals carry the benefiting team (checked: 99 of 100 PL matches add up this way). The final score is the
    // source of truth: the score at 75' is the final score minus the goals after 75'. A goal event with no player
    // (2026-08-31 Villa-Arsenal: a 55' "goal" beside a cancelled penalty) is dropped when that makes the match add up.
    let es = byF[f.id] || [];
    if (!adds(es, f) && adds(es.filter((e) => e.player_name), f)) es = es.filter((e) => e.player_name);
    const clean = adds(es, f);
    if (!clean) skipped.push({ fixture_id: Number(f.id), round: f.round, home: T[f.h].name, away: T[f.a].name, score: `${f.fh}-${f.fa}`, events: `${es.filter((e) => e.team_id === f.h).length}-${es.filter((e) => e.team_id === f.a).length}` });
    const lateEv = es.filter((e) => e.elapsed > CUT);
    const h75 = f.fh - lateEv.filter((e) => e.team_id === f.h).length, a75 = f.fa - lateEv.filter((e) => e.team_id === f.a).length;
    if (h75 < 0 || a75 < 0) throw new Error(`fixture ${f.id}: late goals exceed the final score`);
    counted++;
    const H = T[f.h], A = T[f.a];
    // "led at some point" needs the whole running score: only for a match whose events add up
    let h = 0, a = 0, hLed = false, aLed = false;
    if (clean) for (const e of es) { e.team_id === f.h ? h++ : a++; if (h > a) hLed = true; if (a > h) aLed = true; }
    const lateGoals = lateEv.map((e) => ({ minute: minute(e), side: e.team_id === f.h ? 'home' : 'away', player: e.player_name, kind: e.detail === 'Normal Goal' ? null : e.detail }));
    goals += f.fh + f.fa; late += lateGoals.length;
    for (const [me, op, gf, ga, gf75, ga75, led, side] of [[H, A, f.fh, f.fa, h75, a75, hLed, 'home'], [A, H, f.fa, f.fh, a75, h75, aLed, 'away']]) {
      me.gp++; me.gf += gf; me.ga += ga; me.pts += pts(gf, ga);
      me.gf75 += gf75; me.ga75 += ga75; me.pts75 += pts(gf75, ga75);
      me.lateF += gf - gf75; me.lateA += ga - ga75;
      if (led) { me.ledAt++; me.droppedFromLead += 3 - pts(gf, ga); if (gf > ga) me.ledWon++; }
      const d = pts(gf, ga) - pts(gf75, ga75);
      if (d) me.swings.push({ fixture_id: Number(f.id), round: f.round, date: f.kickoff_at.toISOString().slice(0, 10), venue: side, opponent: op.name, opponent_id: op.id,
        at75: `${gf75}-${ga75}`, final: `${gf}-${ga}`, points: d, late_goals: lateGoals.map((g) => ({ ...g, for: g.side === side })) });
    }
    if (Math.sign(f.fh - f.fa) !== Math.sign(h75 - a75)) changed++;
  }
  const rows = Object.values(T).filter((r) => r.gp);
  for (const r of rows) { r.gd = r.gf - r.ga; r.gd75 = r.gf75 - r.ga75; r.delta = r.pts - r.pts75; }
  rankBy(rows, 'pts', 'gd', 'gf');
  rankBy(rows, 'pts75', 'gd75', 'gf75');
  // the real table must agree with the stored standings (same points; the place can differ on tie-breaks)
  const warn = [];
  for (const r of rows) {
    const s = standings.find((x) => x.team_id === r.id);
    r.standings_rank = s ? s.rank : null;
    if (!s) warn.push(`${r.name}: no standings row`);
    else if (s.points !== r.pts || s.played !== r.gp) warn.push(`${r.name}: standings ${s.points} pts / ${s.played} played, rebuilt ${r.pts} / ${r.gp}`);
  }
  for (const r of rows) r.logo = await logo(r.logo_url, `teams-${r.id}.png`);
  const leagueLogo = await logo(lg.logo_url, `leagues-${lg.id}.png`);
  const last = fx.at(-1).kickoff_at;
  const th = new Date(last.getTime() + 7 * 3600e3);
  const rounds = Math.max(...fx.map((f) => Number((f.round || '').match(/(\d+)\s*$/)?.[1] || 0)));
  const facts = {
    topic: 'late75', cut: CUT, league: { id: lg.id, name: lg.name, logo: leagueLogo }, season: SEASON,
    through: last.toISOString().slice(0, 10), through_th: `ถึงวันที่ ${th.getUTCDate()} ${MONTHS_FULL[th.getUTCMonth()]} ${th.getUTCFullYear() + 543}`, rounds,
    fetched_at: new Date().toISOString(), source: 'fixtures + fixture_events (API-Football), production DB, read-only',
    matches: { finished: fx.length, counted, skipped }, goals: { total: goals, late, late_share_pct: Math.round((late / goals) * 1000) / 10 }, results_changed_after_cut: changed,
    teams: rows.sort((a, b) => a.rank - b.rank).map(({ logo_url, ...r }) => r),
    warnings: warn,
  };
  const dir = path.join(ROOT, 'insights', `${lg.id}-${SEASON}-late75`);
  writeJson(path.join(dir, 'facts.json'), facts);

  console.log(`${lg.name} ${SEASON}, ${facts.through_th} (${rounds} rounds): ${counted}/${fx.length} matches, ${goals} goals, ${late} after ${CUT}' (${facts.goals.late_share_pct}%), ${changed} results changed after ${CUT}'`);
  for (const s of skipped) console.log(`  WARN events do not add up, kept on the final score: ${s.fixture_id} ${s.home} ${s.score} ${s.away} (events ${s.events})`);
  for (const w of warn) console.log('  WARN', w);
  console.log('\n  real                       pts | at 75′ pts  pos  | +/-  led  dropped');
  for (const r of facts.teams) console.log(`  ${String(r.rank).padStart(2)} ${r.name.padEnd(22)} ${String(r.pts).padStart(3)} | ${String(r.pts75).padStart(9)} ${String(r.rank75).padStart(4)}  | ${(r.delta > 0 ? '+' : '') + r.delta}`.padEnd(58) + `${String(r.ledAt).padStart(4)} ${String(r.droppedFromLead).padStart(7)}`);
  for (const r of facts.teams.filter((x) => x.swings.length)) {
    console.log(`\n  ${r.name} (${r.delta > 0 ? '+' : ''}${r.delta})`);
    for (const s of r.swings) console.log(`    ${s.date} ${s.venue === 'home' ? 'vs' : '@'} ${s.opponent}: 75′ ${s.at75} → FT ${s.final} (${s.points > 0 ? '+' : ''}${s.points}) · ${s.late_goals.map((g) => `${g.minute}′ ${g.for ? '' : '(opp) '}${g.player}${g.kind ? ' ' + g.kind : ''}`).join(', ')}`);
  }
  console.log(`\n-> ${path.relative(ROOT, path.join(dir, 'facts.json'))}`);
})().catch((e) => { console.error(e.message); process.exit(1); });

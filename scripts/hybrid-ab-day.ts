/**
 * A/B dry-run of the Hybrid AI on one football day, as of each match's own EARLY decision time. Writes NOTHING to the database.
 *
 *   A1, A2  the input as hybrid-ai-v1 builds it, minus the post-match snapshots (standings, injuries, lineups), run twice:
 *           the gap between A1 and A2 is the AI's own noise, so a B difference smaller than that means nothing
 *   B       A plus `extra_context`, every field computed as of the decision time:
 *             line_movement  the main AH and O/U lines and the de-margined sides at the opening vs now
 *             season_splits  the league season's home record of the home team and away record of the away team
 *             schedule       each team's next fixture after this one (days, competition; tracked leagues only)
 *
 *   npx tsx scripts/hybrid-ab-day.ts --date 2026-10-28 [--out reports/hybrid-ab-2026-10-28.json]
 *   (--date is the football day, 06:00 -> 06:00 Thai time)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { buildHybridInput, createOpenAIHybridDecider, HYBRID_MAX_ATTEMPTS, validateHybridOutput, type HybridSource } from '@fp/ai';
import { closingLineValue, hybridMarket, hybridOptions, settle, type HybridMarket, type HybridSide } from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({ options: { date: { type: 'string' }, out: { type: 'string' } } });
if (!values.date || !/^\d{4}-\d{2}-\d{2}$/.test(values.date)) throw new Error('--date YYYY-MM-DD (the football day) is required');
const OUT = values.out ?? `reports/hybrid-ab-${values.date}.json`;
loadDotEnvFile();
const env = loadEnv();
if (!env.OPENAI_API_KEY || !env.OPENAI_MODEL) throw new Error('OPENAI_API_KEY and OPENAI_MODEL are needed (the live engine uses them)');
const db = createPgDb(env.DATABASE_URL!, { max: 6 });
const repo = new Repository(db);
const decider = createOpenAIHybridDecider({ apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL });

const from = new Date(`${values.date}T06:00:00+07:00`);
const to = new Date(from.getTime() + 86_400_000);
type Row = Record<string, unknown>;
type Result = Record<string, unknown>;

// the latest EARLY decision of every fixture of the day: its decided_at is the as-of time, its legacy block the rules' pick
const rows = (
  await db.query<Row>(
    `select distinct on (d.fixture_id) d.fixture_id, d.decided_at, d.side, d.market, d.selection, d.line, d.odds, d.status as live_status, d.legacy,
            f.league_id, f.season, f.kickoff_at, f.home_team_id, f.away_team_id, f.status_short,
            coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga
       from hybrid_decisions d join fixtures f on f.id = d.fixture_id
      where d.publish_round = 'EARLY' and f.kickoff_at >= $1 and f.kickoff_at < $2
        and f.status_short in ('FT','AET','PEN') and coalesce(f.ft_home, f.goals_home) is not null
      order by d.fixture_id, d.decided_at desc`,
    [from.toISOString(), to.toISOString()],
  )
).rows;

const r2 = (x: number) => Math.round(x * 100) / 100;
const pts = (a: number, b: number) => Math.round((a - b) * 1000) / 10; // percentage points, 1 decimal

function marketMove(open: HybridMarket, now: HybridMarket) {
  const prob = (m: HybridMarket['ah'] | HybridMarket['ou'], sel: string) => m.options.find((o) => o.selection === sel)?.marketProbability ?? null;
  const side = (o: HybridMarket['ah'] | HybridMarket['ou'], n: HybridMarket['ah'] | HybridMarket['ou'], sel: string, name: string) => {
    const a = prob(o, sel);
    const b = prob(n, sel);
    return o.line !== null && n.line !== null && a !== null && b !== null ? { [`opening_${name}`]: a, [`now_${name}`]: b, [`${name}_change_pts`]: pts(b, a) } : null;
  };
  const ah = side(open.ah, now.ah, 'HOME', 'home_prob');
  const ou = side(open.ou, now.ou, 'OVER', 'over_prob');
  return {
    asian_handicap: ah && open.ah.line !== null && now.ah.line !== null ? { opening_home_line: open.ah.line, now_home_line: now.ah.line, home_line_change: r2(now.ah.line - open.ah.line), ...ah } : null,
    over_under: ou && open.ou.line !== null && now.ou.line !== null ? { opening_total: open.ou.line, now_total: now.ou.line, total_change: r2(now.ou.line - open.ou.line), ...ou } : null,
  };
}

async function extraContext(r: Row, header: { home: string; away: string }, now: Date, marketNow: HybridMarket) {
  const id = Number(r.fixture_id);
  const kickoff = new Date(r.kickoff_at as string);
  // opening = the first snapshots we hold for the fixture, read an hour after the first one so several books are in
  const first = (await db.query<{ t: string | null }>(`select min(collected_at) as t from odds_history where fixture_id = $1 and market in ('ASIAN_HANDICAP','OVER_UNDER')`, [id])).rows[0]?.t;
  let movement: Record<string, unknown> = { note: 'no earlier snapshots held' };
  if (first) {
    const openAt = new Date(new Date(first).getTime() + 3_600_000);
    const hours = (now.getTime() - openAt.getTime()) / 3_600_000;
    if (hours >= 3) {
      const open = hybridMarket(await repo.latestQuotes(id, openAt), openAt);
      movement = { hours_between_opening_and_now: r2(hours), hours_before_kickoff_at_opening: r2((kickoff.getTime() - openAt.getTime()) / 3_600_000), ...marketMove(open, marketNow) };
    } else movement = { note: 'less than 3 hours of history' };
  }

  const split = async (teamId: number, venue: 'home' | 'away') => {
    const own = venue === 'home' ? 'home_team_id' : 'away_team_id';
    const gf = venue === 'home' ? 'coalesce(ft_home, goals_home)' : 'coalesce(ft_away, goals_away)';
    const ga = venue === 'home' ? 'coalesce(ft_away, goals_away)' : 'coalesce(ft_home, goals_home)';
    const res = await db.query<Row>(
      `select count(*)::int n, round(avg(${gf})::numeric, 2) gf, round(avg(${ga})::numeric, 2) ga,
              round(avg(case when ${gf} > ${ga} then 3 when ${gf} = ${ga} then 1 else 0 end)::numeric, 2) ppg
         from fixtures where ${own} = $1 and league_id = $2 and season = $3 and status_short in ('FT','AET','PEN')
          and kickoff_at < $4 and coalesce(ft_home, goals_home) is not null`,
      [teamId, r.league_id, r.season, now.toISOString()],
    );
    const x = res.rows[0]!;
    return Number(x.n) > 0 ? { matches: Number(x.n), goals_for_per_match: Number(x.gf), goals_against_per_match: Number(x.ga), points_per_match: Number(x.ppg) } : null;
  };
  const next = async (teamId: number) => {
    const res = await db.query<Row>(
      `select f.kickoff_at, l.name from fixtures f join leagues l on l.id = f.league_id
        where (f.home_team_id = $1 or f.away_team_id = $1) and f.kickoff_at > $2 and f.status_short in ('NS','TBD') order by f.kickoff_at limit 1`,
      [teamId, kickoff.toISOString()],
    );
    const x = res.rows[0];
    return x ? { days_after_this_match: r2((new Date(x.kickoff_at as string).getTime() - kickoff.getTime()) / 86_400_000), competition: String(x.name) } : null;
  };
  const [homeSplit, awaySplit, homeNext, awayNext] = await Promise.all([split(Number(r.home_team_id), 'home'), split(Number(r.away_team_id), 'away'), next(Number(r.home_team_id)), next(Number(r.away_team_id))]);
  return {
    field_notes: {
      line_movement: 'Main-line market at the opening vs at the decision time. Probabilities are the de-margined sides; *_change_pts > 0 means the market moved toward the home side (AH) or Over (O/U). Lines are the home team handicap and the total.',
      season_splits: `This league season before the match: ${header.home} at home and ${header.away} away.`,
      schedule: 'Next fixture of each team after this one in the leagues we track (cups outside them are not seen).',
    },
    line_movement: movement,
    season_splits: { home_team_at_home: homeSplit, away_team_away: awaySplit },
    schedule: { home_team_next: homeNext, away_team_next: awayNext },
  };
}

async function decide(input: ReturnType<typeof buildHybridInput>, options: ReturnType<typeof hybridOptions>, r: Row) {
  const violations: string[] = [];
  let tokens = 0;
  for (let attempt = 1; attempt <= HYBRID_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await decider.decide(input);
    } catch (err) {
      return { status: 'ERROR', error: String(err).slice(0, 160) };
    }
    const u = res.usage as { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    tokens += (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.output_tokens ?? u.completion_tokens ?? 0);
    if (res.refusal || res.output === null) {
      violations.push(`attempt ${attempt}: ${res.refusal ? 'refusal' : 'unparseable'}`);
      if (res.refusal) break;
      continue;
    }
    const v = validateHybridOutput(res.output, input, options);
    if (!v.ok || !v.decision) {
      violations.push(...v.violations.map((x) => `attempt ${attempt}: ${x}`));
      continue;
    }
    const o = v.decision.option;
    if (!o) return { status: 'OK', side: v.decision.side, confidence: v.decision.confidence, tokens };
    return { status: 'OK', side: v.decision.side, confidence: v.decision.confidence, tokens, ...(await outcomeOf(r, { market: o.market, selection: o.selection, line: o.line, odds: o.odds })) };
  }
  return { status: 'INVALID', violations, tokens };
}

async function outcomeOf(r: Row, o: { market: string; selection: string; line: number; odds: number }) {
  const sel = o.market === 'ASIAN_HANDICAP' ? ({ market: 'ASIAN_HANDICAP', selection: o.selection as 'HOME' | 'AWAY', line: o.line } as const) : ({ market: 'OVER_UNDER', selection: o.selection as 'OVER' | 'UNDER', line: o.line } as const);
  const outcome = settle(sel, Number(r.gh), Number(r.ga));
  const profit = { WIN: o.odds - 1, HALF_WIN: (o.odds - 1) / 2, PUSH: 0, HALF_LOSS: -0.5, LOSS: -1 }[outcome];
  const closing = closingLineValue(o.odds, await repo.closingOdds(Number(r.fixture_id), o.market, o.selection, o.line));
  return { pick: o, outcome, profit, clv: closing?.clv ?? null };
}

async function run(r: Row): Promise<Result> {
  const id = Number(r.fixture_id);
  const now = new Date(r.decided_at as string);
  const f = { id, leagueId: Number(r.league_id), kickoffAt: new Date(r.kickoff_at as string), homeTeamId: Number(r.home_team_id), awayTeamId: Number(r.away_team_id) };
  const header = (await repo.fixtureHeader(id))!;
  const market = hybridMarket(await repo.latestQuotes(id, now), now);
  const options = hybridOptions(market);
  const base = { fixtureId: id, match: `${header.home} vs ${header.away}`, league: header.league, final: `${r.gh}-${r.ga}` };

  const live = r.side && r.side !== 'NO_PICK' && r.market ? { side: r.side, ...(await outcomeOf(r, { market: String(r.market), selection: String(r.selection), line: Number(r.line), odds: Number(r.odds) })) } : { side: r.side ?? null };
  const legacy = r.legacy as { outcome?: string; pick?: { market: string; selection: string; line: number | null; odds: number | null } | null } | null;
  const rules = legacy?.pick ? { ...(await outcomeOf(r, { market: legacy.pick.market, selection: legacy.pick.selection, line: Number(legacy.pick.line), odds: Number(legacy.pick.odds) })) } : null;
  if (!options.length) return { ...base, status: 'NO_OPTIONS', live, rules };

  const [recentHome, recentAway, dcRows] = await Promise.all([repo.teamRecentMatches(f.homeTeamId, now, 10), repo.teamRecentMatches(f.awayTeamId, now, 10), repo.latestProbabilities(id, 'dixon-coles-v0.2', now)]);
  const noRank = (ms: typeof recentHome) => ms.map((m) => ({ ...m, opponentRank: null, opponentTableSize: null }));
  const dcOf = (m: string, s: string, line: number | null) => dcRows.find((p) => p.market === m && p.selection === s && (line === null ? p.line === null : p.line !== null && Math.abs(p.line - line) < 1e-9))?.probability;
  const legacyOptions: Partial<Record<HybridSide, number>> = {};
  for (const o of options) {
    const p = dcOf(o.market, o.selection, o.line);
    if (p !== undefined) legacyOptions[o.side] = p;
  }
  const [h, d, a] = (['HOME', 'DRAW', 'AWAY'] as const).map((s) => dcOf('MATCH_WINNER', s, null));
  const src: HybridSource = {
    fixture: { id, home: header.home, away: header.away, league: header.league, kickoffAt: f.kickoffAt },
    predictionAt: now,
    publishRound: 'EARLY',
    recent: { home: noRank(recentHome), away: noRank(recentAway) },
    standings: { home: null, away: null },
    injuries: [],
    lineup: null,
    market,
    legacy: dcRows.length ? { options: legacyOptions, x12: h !== undefined && d !== undefined && a !== undefined ? { home: h, draw: d, away: a } : null } : null,
  };
  const inputA = buildHybridInput(src);
  const extra = await extraContext(r, header, now, market);
  const inputB = { ...inputA, extra_context: extra } as typeof inputA;

  const A1 = await decide(inputA, options, r);
  const A2 = await decide(inputA, options, r);
  const B = await decide(inputB, options, r);
  return { ...base, status: 'OK', live, rules, A1, A2, B, extra };
}

const results: Result[] = new Array(rows.length);
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < rows.length) {
      const i = next++;
      results[i] = await run(rows[i]!);
      const x = results[i] as Record<string, Record<string, unknown> | string>;
      const s = (v: unknown) => { const o = v as { side?: string; outcome?: string } | undefined; return o ? `${o.side ?? o}${o.outcome ? ' ' + o.outcome : ''}` : '-'; };
      console.log(`${i + 1}/${rows.length} ${x.match}: A1 ${s(x.A1)} | A2 ${s(x.A2)} | B ${s(x.B)}`);
    }
  }),
);

type V = { status?: string; side?: string; outcome?: string; profit?: number; clv?: number | null; tokens?: number; pick?: { market: string; selection: string; line: number } };
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const tally = (vs: Array<V | null | undefined>) => {
  const p = vs.filter((v): v is V => !!v && v.outcome !== undefined);
  const clv = p.map((v) => v.clv).filter((x): x is number => x != null);
  return {
    picks: p.length,
    noPick: vs.filter((v) => v && v.status === 'OK' && v.side === 'NO_PICK').length,
    invalid: vs.filter((v) => v && (v.status === 'INVALID' || v.status === 'ERROR')).length,
    win: p.filter((v) => v.outcome === 'WIN' || v.outcome === 'HALF_WIN').length,
    loss: p.filter((v) => v.outcome === 'LOSS' || v.outcome === 'HALF_LOSS').length,
    push: p.filter((v) => v.outcome === 'PUSH').length,
    units: Number(sum(p.map((v) => v.profit ?? 0)).toFixed(2)),
    clvMean: clv.length ? Number((sum(clv) / clv.length).toFixed(4)) : null,
    clvN: clv.length,
  };
};
const key = (v?: V) => (v && v.pick ? `${v.pick.market}|${v.pick.selection}|${v.pick.line}` : v?.side === 'NO_PICK' ? 'NO_PICK' : 'x');
const ok = results.filter((x) => x.status === 'OK') as Array<Record<string, V & Record<string, unknown>>>;
const summary = {
  version: 'hybrid-ai-v1 A/B dry-run, standings/injuries/lineups removed in A1/A2/B',
  date: values.date,
  fixtures: results.length,
  noOptions: results.filter((x) => x.status === 'NO_OPTIONS').length,
  live: tally(results.map((x) => x.live as V)),
  rules: tally(results.map((x) => x.rules as V | null)),
  A1: tally(ok.map((x) => x.A1 as V)),
  A2: tally(ok.map((x) => x.A2 as V)),
  B: tally(ok.map((x) => x.B as V)),
  sameBetA1vsA2: ok.filter((x) => key(x.A1 as V) === key(x.A2 as V)).length,
  sameBetA1vsB: ok.filter((x) => key(x.A1 as V) === key(x.B as V)).length,
  sameBetA2vsB: ok.filter((x) => key(x.A2 as V) === key(x.B as V)).length,
  comparable: ok.length,
  tokens: sum(ok.flatMap((x) => [x.A1, x.A2, x.B]).map((v) => (v as V).tokens ?? 0)),
};
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify({ summary, results }, null, 2));
console.log('\n' + JSON.stringify(summary, null, 2));
await db.close();

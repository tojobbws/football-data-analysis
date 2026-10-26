/**
 * Re-analyse one football day (06:00 → 06:00 Thai) with the market-anchored experiment beside rules-v0.6.
 * Read-only: nothing is written to the database. Prints a table and writes a markdown report.
 *
 *   npx tsx scripts/reanalyze-today.ts [--day 2026-10-22] [--min-edge 0.02] [--min-ev 0.01]
 *
 * Per fixture:
 *  - stored   the last rules-v0.6 run before kickoff (what the site had)
 *  - v0.6     rules-v0.6 recomputed now on the latest model prices and quotes
 *  - anchor   the same rules on market-anchored prices (data/market-anchor-v0.1.json): main AH and O/U line
 *             from Pinnacle's de-margined price (consensus when Pinnacle has no fresh quote on that line),
 *             moved by the fitted layer; gates from the anchor's walk-forward test; thresholds from the flags.
 * A match that already started is judged as of 20 minutes before kickoff, with quotes from before kickoff,
 * and settled when it has finished.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  ahFeatures,
  anchorContributions,
  applyAnchor,
  DEFAULT_RULES,
  expectedValue,
  generateCandidates,
  isDead,
  leagueTable,
  mainLines,
  noVig,
  ouFeatures,
  restOf,
  seasonPlayed,
  settle,
  sortByTime,
  xgLuck,
  type AnchorFit,
  type Candidate,
  type Decision,
  type DecisionRules,
  type MainLine,
  type MarketSelection,
  type MatchRecord,
  type MatchSituation,
  type ModelPrice,
  type OddsQuote,
} from '@fp/analysis';
import { createPgDb, Repository } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';
import { candidateContext } from '../workers/analysis/src/candidates-job.js';

const { values } = parseArgs({
  options: {
    day: { type: 'string', default: new Date(Date.now() + 7 * 3_600_000 - 6 * 3_600_000).toISOString().slice(0, 10) },
    'min-edge': { type: 'string', default: '0.02' },
    'min-ev': { type: 'string', default: '0.01' },
  },
});
const PINNACLE = 4;
// 06:00 Thai = 23:00Z of the previous day
const from = new Date(`${values.day}T00:00:00+07:00`).getTime() + 6 * 3_600_000;
const to = from + 86_400_000;

type Fit = Pick<AnchorFit, 'beta' | 'mean' | 'sd' | 'features'> & { test: { z: number; n: number } };
const fits = JSON.parse(readFileSync('data/market-anchor-v0.1.json', 'utf8')) as { version: string; leagues: number[]; ASIAN_HANDICAP: Fit; OVER_UNDER: Fit };

const ANCHOR_RULES: DecisionRules = {
  ...DEFAULT_RULES,
  version: 'rules-ma-v0.1-experiment',
  minEdge: Number(values['min-edge']),
  minEv: Number(values['min-ev']),
};

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL);
const repo = new Repository(db);

const fixtures = (
  await db.query<Record<string, unknown>>(
    `select f.id, f.league_id, f.season, f.kickoff_at, f.status_short, f.home_team_id, f.away_team_id,
            coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga,
            th.name as home, ta.name as away, l.name as league
       from fixtures f join teams th on th.id = f.home_team_id join teams ta on ta.id = f.away_team_id
       join leagues l on l.id = f.league_id
      where f.league_id = any($1::int[]) and f.kickoff_at >= $2 and f.kickoff_at < $3
      order by f.kickoff_at, f.id`,
    [env.TRACKED_LEAGUES, new Date(from).toISOString(), new Date(to).toISOString()],
  )
).rows.map((r) => ({
  id: Number(r.id),
  leagueId: Number(r.league_id),
  season: Number(r.season),
  kickoffAt: new Date(r.kickoff_at as string),
  status: String(r.status_short),
  homeTeamId: Number(r.home_team_id),
  awayTeamId: Number(r.away_team_id),
  gh: r.gh == null ? null : Number(r.gh),
  ga: r.ga == null ? null : Number(r.ga),
  name: `${r.home} – ${r.away}`,
  league: String(r.league),
}));

const schedule = new Map<number, number[]>();
for (const r of (await db.query<{ h: string; a: string; t: Date }>('select home_team_id as h, away_team_id as a, kickoff_at as t from fixtures')).rows)
  for (const id of [Number(r.h), Number(r.a)]) (schedule.get(id) ?? schedule.set(id, []).get(id)!).push(new Date(r.t).getTime());
for (const v of schedule.values()) v.sort((x, y) => x - y);
const log = await repo.teamMatchLog();

const leagueData = new Map<number, { matches: MatchRecord[]; season: Map<number, number> }>();
async function league(id: number) {
  if (!leagueData.has(id)) {
    const matches = sortByTime(await repo.finishedMatches(id));
    const season = new Map((await db.query<{ id: string; season: number }>('select id, season from fixtures where league_id = $1', [id])).rows.map((r) => [Number(r.id), r.season]));
    leagueData.set(id, { matches, season });
  }
  return leagueData.get(id)!;
}

async function storedRun(fixtureId: number, kickoffAt: Date) {
  const r = (
    await db.query<Record<string, unknown>>(
      `select r.outcome, r.started_at, c.market, c.selection, c.line, c.odds
         from analysis_runs r left join analysis_candidates c on c.run_id = r.id and c.rank = 1
        where r.fixture_id = $1 and r.decision_rule_version = 'rules-v0.6' and r.started_at < $2
        order by r.started_at desc limit 1`,
      [fixtureId, kickoffAt.toISOString()],
    )
  ).rows[0];
  if (!r) return null;
  return r.outcome === 'SIGNAL' && r.market ? `${short(String(r.market), String(r.selection), r.line == null ? null : Number(r.line))} @${Number(r.odds)}` : 'ไม่มี pick';
}

/** Pinnacle's de-margined price of the first side (HOME / OVER) on a main line, when fresh. */
function pinnacle(quotes: readonly OddsQuote[], ml: MainLine, now: Date): number | null {
  const fresh = quotes.filter((q) => q.bookmakerId === PINNACLE && q.market === ml.market && now.getTime() - q.updatedAt.getTime() <= DEFAULT_RULES.maxOddsAgeHours * 3_600_000);
  const at = (sel: string) =>
    fresh.find((q) => q.selection === sel && (ml.market === 'ASIAN_HANDICAP' ? q.homeLine === ml.line : q.line === ml.line));
  const [a, b] = ml.market === 'ASIAN_HANDICAP' ? [at('HOME'), at('AWAY')] : [at('OVER'), at('UNDER')];
  if (!a || !b) return null;
  const sum = 1 / a.odds + 1 / b.odds;
  if (sum < 1 || sum > 1.25) return null;
  return noVig([a.odds, b.odds])[0]!;
}

const short = (market: string, sel: string, line: number | null) =>
  `${market === 'ASIAN_HANDICAP' ? 'AH' : market === 'OVER_UNDER' ? 'OU' : '1X2'} ${sel}${line === null ? '' : ` ${line > 0 && market === 'ASIAN_HANDICAP' ? '+' : ''}${line}`}`;
const pickText = (d: Decision) => (d.pick ? `${short(d.pick.market, d.pick.selection, d.pick.line)} @${d.pick.odds} (edge ${(d.pick.edge! * 100).toFixed(1)})` : 'ไม่มี pick');
const pts = (p: number | null | undefined) => (p == null ? '–' : (p * 100).toFixed(1));

function result(c: Candidate | null, gh: number | null, ga: number | null, finished: boolean) {
  if (!c || !finished || gh === null || ga === null) return '';
  const o = settle({ market: c.market, selection: c.selection, line: c.line } as MarketSelection, gh, ga);
  return { WIN: 'ชนะ', HALF_WIN: 'ชนะครึ่ง', PUSH: 'คืนทุน', HALF_LOSS: 'เสียครึ่ง', LOSS: 'เสีย' }[o];
}

const NAMES: Record<string, string> = {
  HOME_BIAS: 'อคติเจ้าบ้าน', OVER_BIAS: 'อคติสูง', DC_GAP: 'DC', XG_LUCK: 'ประตู−xG', REST: 'วันพัก',
  CONGESTION: 'นัดถี่', MOTIVATION: 'แรงจูงใจ', DEAD: 'ไม่มีอะไรต้องลุ้น', LINE: 'ขนาดแต้มต่อ', QUARTER: 'ไลน์ควอเตอร์', EARLY: 'ต้นฤดูกาล',
};

const now = new Date();
const rows: Array<Record<string, string | number>> = [];
const details: string[] = [];
const tally = { v06: 0, anchor: 0, changed: 0, total: 0, settled: { v06: [] as string[], anchor: [] as string[] } };

for (const f of fixtures) {
  const finished = ['FT', 'AET', 'PEN'].includes(f.status);
  const evalAt = new Date(Math.min(now.getTime(), f.kickoffAt.getTime() - 20 * 60_000));
  const cfg = await repo.latestModelConfigs(f.leagueId);
  const c = await candidateContext(repo, f, cfg, evalAt);
  tally.total++;
  if (!c) {
    rows.push({ kickoff: thai(f.kickoffAt), match: f.name, note: 'ยังไม่มีราคาโมเดล' });
    continue;
  }
  const quotes = c.quotes.filter((q) => q.updatedAt < f.kickoffAt);
  const base = { ...c.input, quotes, now: evalAt };
  const old = generateCandidates(base, DEFAULT_RULES);

  // the anchored prices of the main lines
  const { matches, season } = await league(f.leagueId);
  const tested = fits.leagues.includes(f.leagueId);
  const seasonMatches = matches.filter((m) => season.get((m as MatchRecord & { fixtureId: number }).fixtureId) === f.season);
  const table = leagueTable(seasonMatches, f.kickoffAt);
  const team = (id: number) => ({
    luck: xgLuck(log.get(id) ?? [], id, f.kickoffAt),
    rest: restOf(schedule.get(id) ?? [], f.kickoffAt),
    dead: isDead(table, id),
    seasonPlayed: seasonPlayed(log.get(id) ?? [], f.season, f.kickoffAt),
  });
  const s: MatchSituation = { home: team(f.homeTeamId), away: team(f.awayTeamId) };
  const mains = mainLines(quotes, evalAt, DEFAULT_RULES);
  const anchored: ModelPrice[] = c.input.model.filter((m) => m.market === 'MATCH_WINNER');
  const lines: string[] = [];
  for (const market of ['ASIAN_HANDICAP', 'OVER_UNDER'] as const) {
    const ml = mains[market];
    if (ml.status !== 'OK' || ml.line === null) {
      lines.push(`${market === 'ASIAN_HANDICAP' ? 'AH' : 'OU'}: ไม่มีไลน์หลัก (${ml.status})`);
      continue;
    }
    const pin = pinnacle(quotes, ml, evalAt);
    const mkt = pin ?? ml.firstProbability!;
    const [first, second] = market === 'ASIAN_HANDICAP' ? ['HOME', 'AWAY'] : ['OVER', 'UNDER'];
    const secondLine = market === 'ASIAN_HANDICAP' && ml.line !== 0 ? -ml.line : ml.line;
    const dc = c.input.model.find((m) => m.market === market && m.selection === first && m.line === ml.line)?.probability ?? null;
    const fit = fits[market];
    const x = market === 'ASIAN_HANDICAP' ? ahFeatures(s, ml.line, dc, mkt) : ouFeatures(s, dc, mkt);
    const p = applyAnchor(fit, mkt, x);
    const push = c.input.model.find((m) => m.market === market && m.selection === first && m.line === ml.line)?.distribution?.push ?? 0;
    const dist = (q: number) => ({ win: q * (1 - push), halfWin: 0, push, halfLoss: 0, loss: (1 - q) * (1 - push) });
    anchored.push({ market, selection: first, line: ml.line, probability: p, distribution: dist(p) });
    anchored.push({ market, selection: second, line: secondLine, probability: 1 - p, distribution: dist(1 - p) });
    const contrib = Object.entries(anchorContributions(fit, x))
      .map(([k, v]) => [k, v * p * (1 - p)] as const)
      .filter(([, v]) => Math.abs(v) >= 0.002)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 3)
      .map(([k, v]) => `${NAMES[k] ?? k} ${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}`);
    lines.push(
      `${market === 'ASIAN_HANDICAP' ? `AH เจ้าบ้าน ${ml.line > 0 ? '+' : ''}${ml.line}` : `OU สูง ${ml.line}`}: ตลาด ${pts(mkt)}% (${pin === null ? 'consensus' : 'Pinnacle'}) · DC ${pts(dc)}% · ใหม่ ${pts(p)}%` +
        (contrib.length ? ` [${contrib.join(', ')}]` : ''),
    );
  }
  const gate = (m: 'ASIAN_HANDICAP' | 'OVER_UNDER') => ({ enabled: true, z: fits[m].test.z });
  const neu = generateCandidates(
    { ...base, model: anchored, gates: { ...base.gates, ASIAN_HANDICAP: gate('ASIAN_HANDICAP'), OVER_UNDER: gate('OVER_UNDER') } },
    ANCHOR_RULES,
  );

  // 5. the best price on the market for the new pick
  const best = neu.pick && neu.pick.distribution ? ` · ราคาดีสุด ${neu.pick.bestOdds} (EV ${(expectedValue(neu.pick.distribution, neu.pick.bestOdds) * 100).toFixed(1)}%)` : '';
  const stored = await storedRun(f.id, f.kickoffAt);
  const changed = pickText(old).split(' (')[0] !== pickText(neu).split(' (')[0];
  if (old.pick) tally.v06++;
  if (neu.pick) tally.anchor++;
  if (changed) tally.changed++;
  const r06 = result(old.pick, f.gh, f.ga, finished);
  const rNew = result(neu.pick, f.gh, f.ga, finished);
  if (r06) tally.settled.v06.push(r06);
  if (rNew) tally.settled.anchor.push(rNew);
  rows.push({
    kickoff: thai(f.kickoffAt),
    match: f.name + (tested ? '' : ' *'),
    status: finished ? `จบ ${f.gh}-${f.ga}` : f.status === 'NS' ? 'ยังไม่เตะ' : f.status,
    stored: stored ?? '–',
    'v0.6 now': pickText(old) + (r06 ? ` → ${r06}` : ''),
    anchor: pickText(neu) + (rNew ? ` → ${rNew}` : ''),
    changed: changed ? 'เปลี่ยน' : '',
  });
  details.push(
    `### ${thai(f.kickoffAt)} ${f.name} (${f.league}${tested ? '' : ', ลีกนอกชุดทดสอบ'})${finished ? ` — จบ ${f.gh}-${f.ga}` : ''}\n` +
      `- ที่เว็บมีอยู่ (rules-v0.6 ล่าสุดก่อนเตะ): ${stored ?? '–'}\n` +
      `- rules-v0.6 คำนวณใหม่: ${pickText(old)}${r06 ? ` → ${r06}` : ''}${old.pick ? '' : ` (${old.fogReasons.map((x) => x.reason).join(', ') || old.decisionReason})`}\n` +
      `- market-anchor: ${pickText(neu)}${rNew ? ` → ${rNew}` : ''}${best}${neu.pick ? '' : ` (${neu.fogReasons.map((x) => x.reason).join(', ') || neu.decisionReason})`}\n` +
      lines.map((l) => `  - ${l}`).join('\n') +
      `\n  - ข้อมูลทีม: เจ้าบ้าน ประตู−xG ${s.home.luck.scored.toFixed(2)}/${s.home.luck.conceded.toFixed(2)} (${s.home.luck.matches} นัด), พัก ${s.home.rest.days.toFixed(1)} วัน, 14 วัน ${s.home.rest.last14} นัด${s.home.dead ? ', ไม่มีอะไรต้องลุ้น' : ''}` +
      ` · ทีมเยือน ${s.away.luck.scored.toFixed(2)}/${s.away.luck.conceded.toFixed(2)} (${s.away.luck.matches} นัด), พัก ${s.away.rest.days.toFixed(1)} วัน, 14 วัน ${s.away.rest.last14} นัด${s.away.dead ? ', ไม่มีอะไรต้องลุ้น' : ''}\n`,
  );
}

function thai(d: Date) {
  return new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(11, 16);
}

console.table(rows);
const sum = (xs: string[]) => `${xs.length} นัด: ` + Object.entries(xs.reduce<Record<string, number>>((a, x) => ((a[x] = (a[x] ?? 0) + 1), a), {})).map(([k, v]) => `${k} ${v}`).join(', ');
const header =
  `# วิเคราะห์คู่วันที่ ${values.day} ใหม่: rules-v0.6 เทียบ market-anchor (${new Date().toISOString().slice(0, 16)}Z)\n\n` +
  `อ่านอย่างเดียว ไม่ได้เขียนอะไรลงฐานข้อมูล · โมเดล ${fits.version} · กฎทดลอง minEdge ${ANCHOR_RULES.minEdge}, minEv ${ANCHOR_RULES.minEv}, ` +
  `gate z: AH ${fits.ASIAN_HANDICAP.test.z.toFixed(2)}, OU ${fits.OVER_UNDER.test.z.toFixed(2)}\n\n` +
  `- ${tally.total} คู่ · rules-v0.6 มี pick ${tally.v06} คู่ · market-anchor มี pick ${tally.anchor} คู่ · ผลต่างกัน ${tally.changed} คู่\n` +
  `- คู่ที่จบแล้ว: rules-v0.6 ${sum(tally.settled.v06)} · market-anchor ${sum(tally.settled.anchor)}\n\n` +
  `| เวลา | คู่ | สถานะ | ที่เว็บมี | v0.6 คำนวณใหม่ | market-anchor | |\n|---|---|---|---|---|---|---|\n` +
  rows.map((r) => `| ${r.kickoff} | ${r.match} | ${r.status ?? ''} | ${r.stored ?? r.note ?? ''} | ${r['v0.6 now'] ?? ''} | ${r.anchor ?? ''} | ${r.changed ?? ''} |`).join('\n') +
  '\n\n\\* = ลีกที่ไม่มีราคา Pinnacle ย้อนหลังให้ทดสอบ: ตัวปรับของโมเดลใหม่ถูกใช้นอกข้อมูลที่มันเรียนมา\n\n## รายละเอียดรายคู่\n\nตัวเลขในวงเล็บเหลี่ยม = ปัจจัยที่ขยับความน่าจะเป็นมากที่สุด (จุด %)\n\n';
const file = `reports/reanalyze-${values.day}.md`;
writeFileSync(file, header + details.join('\n'));
console.log(`\n${tally.total} fixtures, v0.6 picks ${tally.v06}, anchor picks ${tally.anchor}, different ${tally.changed}. Report: ${file}`);
process.exit(0);

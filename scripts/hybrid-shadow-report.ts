/**
 * ADR 0019: the Hybrid AI's Over/Under choices are shadow decisions (stored in hybrid_decisions, never published).
 * National-team choices were shadow for the 15 Nov 2026 run only, and are published again, but stay a row of their
 * own here. This report settles every DAILY decision on the 90-minute score, grouped by market and by clubs or
 * national teams, for the same prompt versions. Read-only (no DB writes).
 *
 *   npx tsx scripts/hybrid-shadow-report.ts            # prompt hybrid-ai-v1.8 and later
 *   npx tsx scripts/hybrid-shadow-report.ts --from 1.6 # also earlier prompts, for comparison (published then)
 *   npx tsx scripts/hybrid-shadow-report.ts --from 2.0 # the ADR 0020 review: v2.1.1 is counted apart from v2.0 (ADR 0021)
 *
 * Per row: the latest OK decision of each fixture's DAILY round. Hit = fair hit (WIN 1, HALF_WIN ½ weight counted as a
 * hit, HALF_LOSS ½ weight, LOSS 1, PUSH out), the same measure as /admin/review, against the mean no-vig market
 * probability of the chosen side. The 95% interval is the normal approximation on the fair weights.
 * ADR 0019 reviews each shadow group at 100 settled decisions.
 */
import { settle, type Outcome } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv, NATIONAL_TEAM_COMPETITIONS } from '@fp/shared';

loadDotEnvFile();
const env = loadEnv();
const db = createPgDb(env.DATABASE_URL!, { max: 1 });

const fromArg = process.argv.indexOf('--from');
const fromVersion = fromArg > 0 ? String(process.argv[fromArg + 1]) : '1.8';
const REVIEW_AT = 100;
const OU_REVIEW_AT = 30; // amendment 2: Over/Under from v1.8

/**
 * Each part compared apart: as numbers, v1.10 would sort below v1.8. Any number of parts, so hybrid-ai-v2.1.1 counts
 * (a two-part pattern left every v2.1.1 decision out of this report until 2026-11-21); a missing part is 0.
 */
function versionAtLeast(prompt: string, min: string): boolean {
  const m = prompt.match(/v(\d+(?:\.\d+)*)$/);
  if (!m) return false;
  const have = m[1]!.split('.').map(Number);
  const want = min.split('.').map(Number);
  for (let i = 0; i < Math.max(have.length, want.length); i++) {
    const a = have[i] ?? 0;
    const b = want[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

const { rows } = await db.query<{
  fixture_id: string; league_id: number; prompt_version: string; side: string; market: string; selection: string; line: string;
  market_probability: string | null; gh: number | null; ga: number | null; status_short: string;
}>(`
  select distinct on (h.fixture_id) h.fixture_id, f.league_id, h.prompt_version, h.side, h.market, h.selection, h.line, h.market_probability,
         coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga, f.status_short
    from hybrid_decisions h join fixtures f on f.id = h.fixture_id
   where h.publish_round = 'DAILY' and h.status = 'OK' and h.side in ('FAVORITE', 'UNDERDOG', 'OVER', 'UNDER')
   order by h.fixture_id, h.decided_at desc`);

interface Tally { n: number; settled: number; push: number; hits: number; weight: number; mp: number; won: number; lost: number }
const empty = (): Tally => ({ n: 0, settled: 0, push: 0, hits: 0, weight: 0, mp: 0, won: 0, lost: 0 });
const groups = new Map<string, Tally>();
const add = (key: string, o: Outcome | null, mp: number | null) => {
  const t = groups.get(key) ?? empty();
  groups.set(key, t);
  t.n++;
  if (!o) return;
  t.settled++;
  if (o === 'PUSH') { t.push++; return; }
  const w = o === 'HALF_WIN' || o === 'HALF_LOSS' ? 0.5 : 1;
  t.weight += w;
  if (o === 'WIN' || o === 'HALF_WIN') { t.hits += w; t.won++; } else t.lost++;
  t.mp += (mp ?? 0.5) * w;
};

for (const r of rows) {
  if (!versionAtLeast(r.prompt_version, fromVersion)) continue;
  const finished = ['FT', 'AET', 'PEN'].includes(r.status_short) && r.gh !== null && r.ga !== null;
  const line = Number(r.line);
  const outcome = finished
    ? r.market === 'OVER_UNDER'
      ? settle({ market: 'OVER_UNDER', selection: r.selection as 'OVER' | 'UNDER', line }, r.gh!, r.ga!)
      : settle({ market: 'ASIAN_HANDICAP', selection: r.selection as 'HOME' | 'AWAY', line }, r.gh!, r.ga!)
    : null;
  const mp = r.market_probability === null ? null : Number(r.market_probability);
  const scope = NATIONAL_TEAM_COMPETITIONS.includes(Number(r.league_id)) ? 'national' : 'clubs';
  const kind = `${r.market === 'OVER_UNDER' ? 'O/U' : 'AH'} ${scope}`;
  add(`${kind} (all)`, outcome, mp);
  add(`${kind} ${r.side}`, outcome, mp);
  add(`${kind} ${r.prompt_version}`, outcome, mp);
  add(`all ${r.prompt_version}`, outcome, mp); // AH and O/U together, per prompt version: the ADR 0020 / 0021 review count
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
console.log(`Hybrid AI DAILY decisions, prompt v${fromVersion} and later.`);
console.log('O/U was shadow in v1.8–v1.9 (ADR 0019) and is published again from v2.0 (ADR 0020); AH is published (national teams were shadow on 15 Nov 2026 only). Before v1.8 all were published.\n');
console.table(
  [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, t]) => {
    const hit = t.weight ? t.hits / t.weight : null;
    const half = t.weight ? 1.96 * Math.sqrt((hit! * (1 - hit!)) / t.weight) : null;
    return {
      group,
      decisions: t.n,
      settled: t.settled,
      'won-lost-push': `${t.won}-${t.lost}-${t.push}`,
      hit: hit === null ? '-' : pct(hit),
      '95% CI': hit === null ? '-' : `${pct(Math.max(0, hit - half!))}–${pct(Math.min(1, hit + half!))}`,
      'market expected': t.weight ? pct(t.mp / t.weight) : '-',
    };
  }),
);
const settled = (prefix: string) => [...groups.entries()].filter(([k]) => k.startsWith(prefix) && k.endsWith('(all)')).reduce((s, [, t]) => s + t.settled, 0);
console.log(`\nADR 0019 review at ${REVIEW_AT} settled decisions per shadow group:`);
console.log(`  O/U (clubs and national, count from v1.8): ${settled('O/U')} of ${OU_REVIEW_AT}`);
console.log(`  AH national (published again, measured apart): ${settled('AH national')} of ${REVIEW_AT}`);
// ADR 0021: v2.1.1 (live from the 17 Nov 2026 run) is counted apart from v2.0, and the review at 100 is judged on
// v2.1.1 alone (owner, 2026-11-21); v2.0 stays a row of its own for comparison.
console.log(`ADR 0020 review: ${REVIEW_AT} settled picks per prompt version, AH and O/U together (run with --from 2.0):`);
for (const [key, t] of [...groups.entries()].filter(([k]) => k.startsWith('all ')).sort(([a], [b]) => a.localeCompare(b))) {
  const v = key.slice(4);
  console.log(`  ${v}: ${t.settled} of ${REVIEW_AT}${v === 'hybrid-ai-v2.1.1' ? ' (the review count)' : ''}`);
}
await db.close();

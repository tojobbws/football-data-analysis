/**
 * Research, READ-ONLY (ADR 0021, before production): checks every v2.1.1 aggregate and the data cut-off on every stored
 * Hybrid AI input. No AI call, no write.
 *
 *   npx tsx scripts/research/v211-aggregate-audit.ts
 *
 * For each stored hybrid_decisions.input, prepareHybridInputV211() (the production function) is recomputed here by an
 * independent implementation and compared value by value:
 *  - per match: goals_total = goals for + against; xg_total / npxg_total = sum, null when a part is null (never 0)
 *  - per window (last_10, last_5, the venue window): the same matches as the window; each *_matches is the number of
 *    matches that have the value (not the window size); each *_sum and *_avg over exactly those matches; an average
 *    is null when its count is 0
 *  - against the v2.0 window values already in the input: matches = goals_matches, goals_for_avg = goals_for_sum /
 *    goals_matches, xg_matches = xg_for_matches, xg_for_avg = xg_for_sum / xg_for_matches (proves the same matches)
 *  - comparison: home, away, sum, gap and counts equal the two windows' values
 * Cut-off: every dated value against prediction_timestamp_utc (recent matches, head to head, recent starters, market
 * movement, API prediction), independently of enforceCutoffV211, and enforceCutoffV211's own warnings.
 */
import { prepareHybridInputV211 } from '@fp/ai';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

loadDotEnvFile();
const db = createPgDb(loadEnv().DATABASE_URL!, { max: 2 });
const rows = (await db.query<{ id: string; prompt_version: string; input: Record<string, any> }>(`select id, prompt_version, input from hybrid_decisions where engine_version = 'hybrid-ai-v1' order by id`)).rows;

let checks = 0;
const fails: string[] = [];
const fail = (id: string, what: string) => fails.length < 60 && fails.push(`row ${id}: ${what}`);
const eq = (id: string, what: string, got: unknown, want: unknown, tol = 0.0051) => {
  checks++;
  if (want === null || got === null) {
    if (got !== want) fail(id, `${what}: got ${got}, want ${want}`);
    return;
  }
  if (typeof want === 'number' && typeof got === 'number') {
    if (Math.abs(got - want) > tol) fail(id, `${what}: got ${got}, want ${want}`);
    return;
  }
  if (got !== want) fail(id, `${what}: got ${String(got)}, want ${String(want)}`);
};
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const total = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) : null);

let cutoffChecked = 0;
const leaks: string[] = [];
let enforceWarnings = 0;
let comparisons = 0;
let windowsChecked = 0;
let v20Cross = 0;

for (const r of rows) {
  const id = r.id;
  const original = r.input;
  const { input: out, cutoffWarnings } = prepareHybridInputV211(original);
  enforceWarnings += cutoffWarnings.length;

  // ---------------- independent cut-off check on the original input
  const cut = Date.parse(original.prediction_timestamp_utc);
  const day = new Date(cut).toISOString().slice(0, 10);
  const lateDay = (d: unknown, what: string) => {
    cutoffChecked++;
    if (typeof d === 'string' && d.slice(0, 10) > day) leaks.push(`row ${id}: ${what} ${d} > ${day}`);
  };
  const lateTime = (t: unknown, what: string) => {
    if (t == null) return;
    cutoffChecked++;
    if (Date.parse(String(t)) > cut) leaks.push(`row ${id}: ${what} ${t} > ${original.prediction_timestamp_utc}`);
  };
  for (const side of ['home_team', 'away_team']) for (const m of original[side]?.recent_matches ?? []) lateDay(m.date_utc, `${side} recent match`);
  for (const m of original.match_context?.head_to_head?.meetings ?? []) lateDay(m.date_utc, 'head to head');
  for (const s of ['home', 'away']) lateDay(original.recent_starters?.[s]?.to_date_utc, `recent_starters.${s}`);
  for (const k of ['opening', 'day_ago', 'now']) lateTime(original.market?.movement?.[k]?.as_of_utc, `movement.${k}`);
  lateTime(original.api_football_prediction?.collected_at_utc, 'api prediction');
  // a recent match must also be before the match being analysed
  const ko = Date.parse(original.match?.kickoff_utc);
  for (const side of ['home_team', 'away_team']) for (const m of original[side]?.recent_matches ?? []) if (Date.parse(m.date_utc) > ko) leaks.push(`row ${id}: ${side} recent match after the kickoff`);

  // ---------------- aggregates
  for (const [side, venue, vw] of [['home_team', 'HOME', 'home_matches_in_last_10'], ['away_team', 'AWAY', 'away_matches_in_last_10']] as const) {
    const src = (original[side]?.recent_matches ?? []) as Array<Record<string, any>>;
    const got = (out[side] as Record<string, any> | undefined)?.recent_matches as Array<Record<string, any>> | undefined;
    if (!got) continue;
    src.forEach((m, i) => {
      const [gf, ga] = String(m.score_for_against).split('-').map(Number);
      eq(id, `${side}[${i}].goals_total`, got[i]!.goals_total, Number.isFinite(gf) && Number.isFinite(ga) ? gf! + ga! : null, 0);
      eq(id, `${side}[${i}].xg_total`, got[i]!.xg_total, isNum(m.xg_for) && isNum(m.xg_against) ? m.xg_for + m.xg_against : null);
      if ('npxg_for' in m) eq(id, `${side}[${i}].npxg_total`, got[i]!.npxg_total, isNum(m.npxg_for) && isNum(m.npxg_against) ? m.npxg_for + m.npxg_against : null);
    });
    const windows: Array<[string, Array<Record<string, any>>]> = [['last_10', src.slice(0, 10)], ['last_5', src.slice(0, 5)], [vw, src.slice(0, 10).filter((m) => m.venue === venue)]];
    for (const [w, ms] of windows) {
      const W = (out[side] as Record<string, any>)[w];
      const W0 = original[side]?.[w];
      if (!W || !W0) continue;
      windowsChecked++;
      const scored = ms.map((m) => String(m.score_for_against).split('-').map(Number)).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b)) as Array<[number, number]>;
      const xf = ms.map((m) => m.xg_for).filter(isNum);
      const xa = ms.map((m) => m.xg_against).filter(isNum);
      const xt = ms.filter((m) => isNum(m.xg_for) && isNum(m.xg_against)).map((m) => m.xg_for + m.xg_against);
      eq(id, `${side}.${w}.goals_matches`, W.goals_matches, scored.length, 0);
      eq(id, `${side}.${w}.goals_for_sum`, W.goals_for_sum, total(scored.map((s) => s[0])));
      eq(id, `${side}.${w}.goals_against_sum`, W.goals_against_sum, total(scored.map((s) => s[1])));
      eq(id, `${side}.${w}.goals_total_sum`, W.goals_total_sum, total(scored.map((s) => s[0] + s[1])));
      eq(id, `${side}.${w}.goals_total_avg`, W.goals_total_avg, mean(scored.map((s) => s[0] + s[1])));
      eq(id, `${side}.${w}.xg_for_matches`, W.xg_for_matches, xf.length, 0);
      eq(id, `${side}.${w}.xg_against_matches`, W.xg_against_matches, xa.length, 0);
      eq(id, `${side}.${w}.xg_total_matches`, W.xg_total_matches, xt.length, 0);
      eq(id, `${side}.${w}.xg_for_sum`, W.xg_for_sum, total(xf), 0.0151);
      eq(id, `${side}.${w}.xg_total_sum`, W.xg_total_sum, total(xt), 0.0151);
      eq(id, `${side}.${w}.xg_total_avg`, W.xg_total_avg, mean(xt));
      // never a zero-filled average: no matches with the value = null
      if (xt.length === 0) eq(id, `${side}.${w}.xg_total_avg null`, W.xg_total_avg, null);
      // the same matches as the v2.0 window values
      v20Cross++;
      eq(id, `${side}.${w} matches = goals_matches`, W0.matches, W.goals_matches, 0);
      if (isNum(W0.goals_for_avg) && W.goals_matches) eq(id, `${side}.${w} v2.0 goals_for_avg`, W0.goals_for_avg, W.goals_for_sum / W.goals_matches);
      if (isNum(W0.xg_matches)) eq(id, `${side}.${w} v2.0 xg_matches = xg_for_matches`, W0.xg_matches, W.xg_for_matches, 0);
      if (isNum(W0.xg_for_avg) && W.xg_for_matches) eq(id, `${side}.${w} v2.0 xg_for_avg`, W0.xg_for_avg, W.xg_for_sum / W.xg_for_matches, 0.0151);
    }
  }
  const C = out.comparison as Record<string, any> | undefined;
  if (C) {
    for (const w of ['last_10', 'last_5']) {
      for (const [k, c] of Object.entries(C[w] ?? {}) as Array<[string, any]>) {
        comparisons++;
        const h = (out.home_team as any)[w]?.[k];
        const a = (out.away_team as any)[w]?.[k];
        eq(id, `comparison.${w}.${k}.home`, c.home, h);
        eq(id, `comparison.${w}.${k}.away`, c.away, a);
        eq(id, `comparison.${w}.${k}.sum`, c.sum, h + a);
        eq(id, `comparison.${w}.${k}.gap`, c.gap_home_minus_away, h - a);
      }
    }
  }
}

console.log(`inputs ${rows.length} (${[...new Set(rows.map((r) => r.prompt_version))].join(', ')})`);
console.log(`aggregate checks ${checks} · windows ${windowsChecked} · v2.0 cross-checks ${v20Cross} · comparison entries ${comparisons} · mismatches ${fails.length}`);
for (const f of fails) console.log('  ', f);
console.log(`cut-off: dated values checked ${cutoffChecked} · after the decision time ${leaks.length} · enforceCutoffV211 warnings ${enforceWarnings}`);
for (const l of leaks.slice(0, 20)) console.log('  ', l);
await db.close();

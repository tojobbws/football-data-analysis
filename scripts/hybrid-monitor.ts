/**
 * Monitor of the daily pick run, per prompt version (ADR 0021: v2.0 and v2.1.1 are counted apart). READ-ONLY.
 *
 *   npx tsx scripts/hybrid-monitor.ts [--day 2026-11-17] [--days 1]
 *
 * For each pick day (14:00 Thai D → 14:00 D+1, the DAILY decisions of its run) and each prompt_version:
 *   decisions and fixtures; AI calls (attempts); INVALID / REFUSED / ERROR decisions; number-guard and match-count
 *   rejections; answers that needed a retry, feedback retries and how many of them passed; attempts per decision;
 *   persistent API errors; answer latency p50 / p95 (v2.1.1 records it); fixtures left without a publication because
 *   no valid decision came; publishing delay after 14:00 Thai; when the featured list was confirmed.
 * ALERT lines: any INVALID / ERROR left at the end, a persistent API error, a fixture not published for validation,
 * a featured list later than 16:15 Thai or none, a cut-off warning in an input.
 */
import { parseArgs } from 'node:util';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({ options: { day: { type: 'string' }, days: { type: 'string', default: '1' } } });
loadDotEnvFile();
const db = createPgDb(loadEnv().DATABASE_URL!, { max: 2 });
const q = async <R = Record<string, any>>(sql: string, p: unknown[] = []) => (await db.query<R>(sql, p)).rows;

// the pick day of "now" if not given: 14:00 Thai = 07:00 UTC
const today = (() => {
  const n = new Date(Date.now() - 7 * 3_600_000);
  return n.toISOString().slice(0, 10);
})();
const first = values.day ?? today;
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]! : null);
const alerts: string[] = [];

for (let i = 0; i < Number(values.days); i++) {
  const day = new Date(Date.parse(`${first}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
  const from = `${day}T07:00:00Z`;
  const to = new Date(Date.parse(from) + 86_400_000).toISOString();
  const rows = await q(
    `select d.id, d.fixture_id, d.prompt_version, d.status, d.side, d.attempts, d.votes, d.violations, d.decided_at, d.input->'data_quality'->'cutoff_warnings' as cutoff
       from hybrid_decisions d
      where d.publish_round = 'DAILY' and d.decided_at >= $1 and d.decided_at < $2 order by d.decided_at`,
    [from, to],
  );
  const pubs = await q(`select fixture_id, prompt_version, kind, published_at from analysis_predictions where publish_round = 'DAILY' and published_at >= $1 and published_at < $2`, [from, to]);
  const featured = await q(`select version, min(locked_at) as locked, count(*) filter (where rank is not null) as listed from featured_selections where football_date = $1 and phase = 'CONFIRMED' group by version`, [day]);
  console.log(`\n=== pick day ${day} (from ${from}) · ${rows.length} decisions · ${pubs.length} publications`);
  if (!rows.length) continue;
  for (const version of [...new Set(rows.map((r) => r.prompt_version as string))]) {
    const rs = rows.filter((r) => r.prompt_version === version);
    const fixtures = [...new Set(rs.map((r) => Number(r.fixture_id)))];
    const latest = new Map<number, Record<string, any>>();
    for (const r of rs) latest.set(Number(r.fixture_id), r);
    const votes = rs.flatMap((r) => (Array.isArray(r.votes) ? r.votes : [])) as Array<Record<string, any>>;
    const viol = rs.flatMap((r) => (r.violations as string[]) ?? []);
    const retried = votes.filter((v) => Number(v.attempts) > 1);
    const latencies = votes.map((v) => Number(v.latencyMs)).filter((x) => Number.isFinite(x) && x > 0);
    const published = new Set(pubs.filter((p) => p.prompt_version === version).map((p) => Number(p.fixture_id)));
    const unpublished = fixtures.filter((f) => !published.has(f) && latest.get(f)!.status !== 'OK');
    const delays = pubs.filter((p) => p.prompt_version === version).map((p) => (Date.parse(p.published_at) - Date.parse(from)) / 60_000);
    const persistent = viol.filter((v) => /credit|quota|billing|invalid_api_key|authentication|permission|model_not_found/i.test(v));
    const cutoffs = rs.filter((r) => Array.isArray(r.cutoff) && r.cutoff.length);
    const m = {
      decisions: rs.length,
      fixtures: fixtures.length,
      aiCalls: rs.reduce((s, r) => s + Number(r.attempts), 0),
      'attempts/decision': +(rs.reduce((s, r) => s + Number(r.attempts), 0) / rs.length).toFixed(2),
      invalidRows: rs.filter((r) => r.status === 'INVALID').length,
      refusedRows: rs.filter((r) => r.status === 'REFUSED').length,
      errorRows: rs.filter((r) => r.status === 'ERROR').length,
      numberGuard: viol.filter((v) => v.includes('number not in input')).length,
      averageCount: viol.filter((v) => v.includes('average without match count')).length,
      answersRetried: retried.length,
      retriedThenOK: retried.filter((v) => v.status === 'OK').length,
      feedbackRetries: votes.reduce((s, v) => s + Number(v.feedbackRetries ?? 0), 0),
      persistentErrors: persistent.length,
      latencyP50s: latencies.length ? +(pct(latencies, 0.5)! / 1000).toFixed(1) : null,
      latencyP95s: latencies.length ? +(pct(latencies, 0.95)! / 1000).toFixed(1) : null,
      notPublishedValidation: unpublished.length,
      publishDelayP50min: delays.length ? Math.round(pct(delays, 0.5)!) : null,
      publishDelayMaxMin: delays.length ? Math.round(Math.max(...delays)) : null,
      cutoffWarnings: cutoffs.length,
    };
    console.log(`--- ${version}`);
    console.table([m]);
    const sides = [...latest.values()].reduce<Record<string, number>>((a, r) => ((a[r.status === 'OK' ? r.side : r.status] = (a[r.status === 'OK' ? r.side : r.status] ?? 0) + 1), a), {});
    console.log(`final per fixture: ${JSON.stringify(sides)}`);
    const left = [...latest.values()].filter((r) => r.status !== 'OK');
    if (left.length) alerts.push(`${day} ${version}: ${left.length} fixtures end on ${left.map((r) => r.status).join('/')} (fixtures ${left.map((r) => r.fixture_id).join(', ')})`);
    if (persistent.length) alerts.push(`${day} ${version}: persistent API error: ${persistent[0]}`);
    if (unpublished.length) alerts.push(`${day} ${version}: ${unpublished.length} fixtures not published for want of a valid decision`);
    if (cutoffs.length) alerts.push(`${day} ${version}: ${cutoffs.length} inputs had data after the decision time removed`);
  }
  for (const f of featured) console.log(`featured ${f.version}: ${f.listed} listed, confirmed ${f.locked ? new Date(f.locked).toISOString() : '-'}`);
  const v4 = featured.find((f) => f.version === 'featured-ai-v4');
  if (!v4) alerts.push(`${day}: no featured-ai-v4 list`);
  else if (v4.locked && Date.parse(v4.locked) > Date.parse(`${day}T09:15:00Z`)) alerts.push(`${day}: featured list confirmed late (${new Date(v4.locked).toISOString()})`);
}
console.log(alerts.length ? `\nALERTS:\n${alerts.map((a) => `  ⚠ ${a}`).join('\n')}` : '\nno alert');
await db.close();

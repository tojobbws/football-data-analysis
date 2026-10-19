import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';
loadDotEnvFile();
const db = createPgDb(loadEnv().DATABASE_URL, { max: 1 });
const r = await db.query<{ league_id: number; name: string; purpose: string; enabled: boolean; metrics: Record<string, any> }>(
  `select distinct on (c.league_id, c.purpose) c.league_id, l.name, c.purpose, c.enabled, c.metrics
     from model_configs c join leagues l on l.id = c.league_id where c.purpose in ('SIDES','ENSEMBLE','TOTALS')
    order by c.league_id, c.purpose, c.tuned_at desc`);
console.log(Object.keys(r.rows.find((x) => x.purpose === 'SIDES')!.metrics), Object.keys(r.rows.find((x) => x.purpose === 'ENSEMBLE')!.metrics));
const ex = r.rows.find((x) => x.purpose === 'ENSEMBLE')!.metrics;
console.log(JSON.stringify(ex).slice(0, 700));
// normal one-sided p from z
const erf = (x: number) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const pOne = (z: number) => 1 - 0.5 * (1 + erf(z / Math.SQRT2));
const out: Record<string, any>[] = [];
for (const purpose of ['SIDES', 'ENSEMBLE', 'TOTALS']) {
  const rows = r.rows.filter((x) => x.purpose === purpose).map((x) => {
    const m = x.metrics;
    const z = m.test?.z ?? m.holdoutTest?.z ?? m.z ?? null;
    return { id: x.league_id, enabled: x.enabled, z: z === null ? null : Number(z), n: m.holdoutN ?? m.holdout?.n ?? null };
  }).filter((x) => x.z !== null) as { id: number; enabled: boolean; z: number; n: number | null }[];
  const ps = rows.map((x) => pOne(x.z)).sort((a, b) => a - b);
  const m = ps.length;
  const holm = ps.filter((p, i) => ps.slice(0, i + 1).every((q, j) => ps[j]! <= 0.1 / (m - j))).length;
  let bh = 0; ps.forEach((p, i) => { if (p <= (0.1 * (i + 1)) / m) bh = i + 1; });
  out.push({ purpose, tests: m, enabledNow: rows.filter((x) => x.enabled).length, 'p<=0.10 uncorrected': ps.filter((p) => p <= 0.1).length, 'Holm 10%': holm, 'BH FDR 10%': bh, expectedFalsePositivesIfNoneReal: +(m * 0.1).toFixed(1) });
}
console.table(out);
await db.close();

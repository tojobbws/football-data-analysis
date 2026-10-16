import { Section } from '@/components/ui';
import { authClient } from '@/lib/auth';
import { dateTimeTH } from '@/lib/time';

const MB = (b: unknown) => `${(Number(b ?? 0) / 1048576).toFixed(0)} MB`;
const LIMIT_MB = 500; // Supabase free tier

/** Pipeline health at a glance: what ran, what failed, how full the DB is, which markets are ON, what data each league has. */
export default async function AdminHome() {
  const sb = await authClient();
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const [overview, runs, configs, leagues, coverage] = await Promise.all([
    sb.rpc('fp_admin_overview'),
    sb.from('sync_runs').select('id, job, status, started_at, finished_at, requests_used, items_written, error').order('started_at', { ascending: false }).limit(300),
    sb.from('model_configs_latest').select('league_id, purpose, enabled, tuned_at'),
    sb.from('leagues').select('id, name'),
    sb.rpc('fp_admin_coverage'),
  ]);
  const coverageRows = (coverage.data ?? []) as CoverageRow[];
  const o = (overview.data ?? {}) as Record<string, number | boolean>;
  const allRuns = runs.data ?? [];
  const latestByJob = new Map<string, (typeof allRuns)[number]>();
  for (const r of allRuns) if (!latestByJob.has(r.job)) latestByJob.set(r.job, r);
  const failed24 = allRuns.filter((r) => r.status === 'FAILED' && r.started_at >= since);
  const requests24 = allRuns.filter((r) => r.started_at >= since).reduce((s, r) => s + Number(r.requests_used ?? 0), 0);
  const names = new Map((leagues.data ?? []).map((l) => [Number(l.id), String(l.name)]));
  const gate = new Map<number, Record<string, boolean>>();
  for (const c of configs.data ?? []) {
    const g = gate.get(Number(c.league_id)) ?? {};
    g[c.purpose] = Boolean(c.enabled);
    gate.set(Number(c.league_id), g);
  }
  const dbPct = (Number(o.db_bytes ?? 0) / 1048576 / LIMIT_MB) * 100;
  const err = overview.error ?? runs.error ?? configs.error ?? coverage.error;

  return (
    <main className="space-y-5">
      {err ? <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">โหลดข้อมูลไม่สำเร็จ: {err.message}</p> : null}
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi k="พื้นที่ DB" v={MB(o.db_bytes)} sub={`${dbPct.toFixed(0)}% ของ ${LIMIT_MB} MB · odds ${MB(o.odds_bytes)}`} warn={dbPct > 80} />
        <Kpi k="บทวิเคราะห์ที่เผยแพร่" v={String(o.published ?? 0)} sub={`รอผล ${o.pending ?? 0}`} />
        <Kpi k="Hash chain" v={o.chain_ok === false ? '❌ ผิดปกติ' : '✅ ถูกต้อง'} warn={o.chain_ok === false} />
        <Kpi k="Job fail (24 ชม.)" v={String(failed24.length)} sub={`API ใช้ไป ${requests24} requests`} warn={failed24.length > 0} />
      </section>

      <Section title="Job ล่าสุดของแต่ละงาน">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-2 font-normal">job</th>
                <th className="pb-2 font-normal">สถานะ</th>
                <th className="pb-2 font-normal">เริ่ม</th>
                <th className="pb-2 text-right font-normal">ใช้เวลา</th>
                <th className="pb-2 text-right font-normal">requests</th>
                <th className="pb-2 text-right font-normal">rows</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {[...latestByJob.values()]
                .sort((a, b) => a.job.localeCompare(b.job))
                .map((r) => (
                  <tr key={r.id}>
                    <td className="py-1.5 font-mono text-xs">{r.job}</td>
                    <td className={r.status === 'FAILED' ? 'text-rose-600' : r.status === 'RUNNING' ? 'text-amber-600' : 'text-emerald-700'}>{r.status}</td>
                    <td className="text-xs text-slate-500">{dateTimeTH(r.started_at)}</td>
                    <td className="text-right tabular-nums text-xs">{r.finished_at ? `${Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 1000)} วิ` : '–'}</td>
                    <td className="text-right tabular-nums">{r.requests_used}</td>
                    <td className="text-right tabular-nums">{r.items_written}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {failed24.length ? (
          <ul className="mt-4 space-y-1 rounded-xl bg-rose-50 p-3 text-xs text-rose-800">
            {failed24.slice(0, 10).map((r) => (
              <li key={r.id}>
                <b>{r.job}</b> {dateTimeTH(r.started_at)} — {String(r.error ?? '').slice(0, 200)}
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section title="ตลาดที่เปิดให้ออก 🧭 (จาก model:tune ล่าสุด)">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500">
              <th className="pb-2 text-left font-normal">ลีก</th>
              <th className="pb-2 font-normal">1X2</th>
              <th className="pb-2 font-normal">AH</th>
              <th className="pb-2 font-normal">O/U</th>
              <th className="pb-2 font-normal">Player Impact</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-center">
            {[...gate.entries()].map(([id, g]) => (
              <tr key={id}>
                <td className="py-1.5 text-left">{names.get(id) ?? id}</td>
                {[g.ENSEMBLE ?? g.SIDES, g.SIDES, g.TOTALS, g.IMPACT].map((on, i) => (
                  <td key={i}>{on === undefined ? '–' : on ? '✅' : '·'}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="ข้อมูลที่แต่ละลีกมี (coverage จาก API เทียบกับที่เก็บได้จริง)">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="text-xs text-slate-500">
                <th className="pb-2 text-left font-normal">ลีก</th>
                <th className="pb-2 text-right font-normal">จบแล้ว</th>
                <th className="pb-2 font-normal">xG (stats)</th>
                <th className="pb-2 font-normal">events</th>
                <th className="pb-2 font-normal">lineups</th>
                <th className="pb-2 font-normal">injuries</th>
                <th className="pb-2 font-normal">predictions</th>
                <th className="pb-2 font-normal">odds</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-center">
              {coverageRows.map((c) => {
                const cov = (c.coverage ?? {}) as Record<string, unknown>;
                const fx = (cov.fixtures ?? {}) as Record<string, unknown>;
                return (
                  <tr key={c.league_id}>
                    <td className="py-1.5 text-left">
                      {c.league_name} <span className="text-xs text-slate-400">{c.season}</span>
                    </td>
                    <td className="text-right tabular-nums">{c.finished}</td>
                    <HeldCell flag={fx.statistics_fixtures} held={c.xg} finished={c.finished} />
                    <HeldCell flag={fx.events} held={c.events} finished={c.finished} />
                    <HeldCell flag={fx.lineups} held={c.lineups} finished={c.finished} />
                    <HeldCell flag={cov.injuries} held={c.injuries} finished={c.finished} />
                    <td>{flagMark(cov.predictions)}</td>
                    <td>{flagMark(cov.odds)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          ✅/· = API บอกว่ามี/ไม่มี · % = สัดส่วนนัดที่จบแล้วซึ่งเราเก็บข้อมูลนั้นได้ · สีส้ม = API บอกว่ามีแต่เก็บได้ไม่ถึงครึ่ง (sync อาจตกหล่น) · ลีกที่ไม่มี injuries: ก่อนประกาศตัวจริง Player Impact ถือว่า &quot;ไม่รู้&quot; ไม่ใช่ &quot;ไม่มีใครเจ็บ&quot;
        </p>
      </Section>
    </main>
  );
}

type CoverageRow = { league_id: number; league_name: string; season: number; coverage: unknown; finished: number; xg: number; events: number; lineups: number; injuries: number };

const flagMark = (flag: unknown) => (flag === true ? '✅' : flag === false ? '·' : '?');

/** Coverage flag + share of finished matches we hold that data for; amber when the API says yes but we hold under half. */
function HeldCell({ flag, held, finished }: { flag: unknown; held: number; finished: number }) {
  const pct = finished ? Math.round((held / finished) * 100) : null;
  const gap = flag === true && finished >= 10 && held / finished < 0.5;
  return (
    <td className={gap ? 'text-amber-600' : undefined}>
      {flagMark(flag)} <span className="tabular-nums text-xs">{pct === null ? '–' : `${pct}%`}</span>
    </td>
  );
}

function Kpi({ k, v, sub, warn }: { k: string; v: string; sub?: string; warn?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${warn ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'}`}>
      <p className="text-xs text-slate-500">{k}</p>
      <p className="mt-1 text-xl font-bold tabular-nums">{v}</p>
      {sub ? <p className="mt-0.5 text-[11px] text-slate-500">{sub}</p> : null}
    </div>
  );
}

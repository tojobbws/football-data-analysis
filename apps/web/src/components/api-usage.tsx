import { Section } from '@/components/ui';

export interface ApiUsage {
  today: Array<{ group_name: string; used: number; daily_cap: number; enforced: boolean; ratio: number | null }>;
  days: Array<{ day: string; requests: number; rejected: number }>;
  remaining: number | null;
  remaining_at: string | null;
}

/** Same threshold as packages/database/src/budget.ts (BUDGET_WARN_RATIO). */
const WARN = 0.8;
const DAY_LIMIT = 7500;
const GROUP_LABEL: Record<string, string> = { live: 'คะแนนสด', odds: 'ราคา (odds)', sync: 'ซิงก์ข้อมูลอื่น', critical: 'ผล/ไลน์อัป (สำรอง ไม่หยุด)' };

/**
 * API-Football quota today (the API's day starts at 00:00 UTC = 07:00 Thai): per budget group against its cap,
 * the API's own remaining count, and the last 7 days. A group at 80% of its cap is flagged; at 100% its jobs are skipped.
 */
export function ApiUsageCard({ usage }: { usage: ApiUsage }) {
  const used = usage.today.reduce((s, g) => s + g.used, 0);
  const alert = usage.today.filter((g) => g.ratio != null && g.ratio >= WARN);
  return (
    <Section title="โควตา API-Football วันนี้" aside={`ใช้ ${used} / ${DAY_LIMIT}${usage.remaining != null ? ` · API เหลือ ${usage.remaining}` : ''}`}>
      {alert.length ? (
        <p className="mb-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
          {alert.map((g) => `${GROUP_LABEL[g.group_name] ?? g.group_name} ใช้ไป ${Math.round((g.ratio ?? 0) * 100)}% ของเพดาน`).join(' · ')}
          {alert.some((g) => g.enforced && (g.ratio ?? 0) >= 1) ? ' — งานกลุ่มที่ถึงเพดานถูกข้ามจนถึงเที่ยงคืน UTC' : ''}
        </p>
      ) : null}
      <ul className="space-y-2 text-sm">
        {usage.today.map((g) => {
          const pct = g.daily_cap ? Math.min(100, (g.used / g.daily_cap) * 100) : 0;
          const hot = g.ratio != null && g.ratio >= WARN;
          return (
            <li key={g.group_name}>
              <div className="flex justify-between gap-3">
                <span>{GROUP_LABEL[g.group_name] ?? g.group_name}</span>
                <span className="tabular-nums text-slate-600">
                  {g.used} / {g.daily_cap}
                </span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${GROUP_LABEL[g.group_name] ?? g.group_name} ${Math.round(pct)}%`}>
                <div className={`h-full rounded-full ${hot ? 'bg-amber-500' : 'bg-emerald-600'}`} style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      {usage.days.length ? (
        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          7 วันล่าสุด (นับเฉพาะคำขอที่ API นับโควตา · ที่ถูกปฏิเสธเพราะ rate limit ไม่นับ):{' '}
          {usage.days.map((d) => `${d.day.slice(5)}: ${d.requests}${d.rejected ? ` (+${d.rejected} ถูกปฏิเสธ)` : ''}`).join(' · ')}
        </p>
      ) : null}
    </Section>
  );
}

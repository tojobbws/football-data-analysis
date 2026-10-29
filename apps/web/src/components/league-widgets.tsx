'use client';

import { useId, useState } from 'react';
import type { LeagueWidget } from '@/lib/queries';
import { Empty, Section, TeamLogo } from './primitives';

/** The five biggest leagues, shown up front: Premier League, La Liga, Serie A, Bundesliga, Ligue 1. */
const BIG = [39, 140, 135, 78, 61];

/** Sidebar: tracked league logos (also the league picker) + standings + top scorers. */
export function LeagueWidgets({ widgets }: { widgets: LeagueWidget[] }) {
  const [id, setId] = useState(() => (widgets.find((w) => w.standings.length) ?? widgets[0])?.league.id);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(false);
  const pickerId = useId();
  const w = widgets.find((x) => x.league.id === id);
  if (!w) return null;
  const table = all ? w.standings : w.standings.slice(0, 10);
  const big = BIG.map((bid) => widgets.find((x) => x.league.id === bid)).filter((x): x is LeagueWidget => x != null);
  const more = widgets.filter((x) => !BIG.includes(x.league.id));
  const groups = [
    { label: 'ลีก', items: more.filter((x) => x.league.type !== 'Cup') },
    { label: 'ถ้วย', items: more.filter((x) => x.league.type === 'Cup') },
  ].filter((g) => g.items.length);
  // e.g. two "Bundesliga" (Germany, Austria): show the country under the name
  const names = widgets.map((x) => x.league.name);
  const dup = new Set(names.filter((n, i) => names.indexOf(n) !== i));

  const pick = (l: LeagueWidget['league']) => (
    <button
      key={l.id}
      type="button"
      onClick={() => {
        setId(l.id);
        setAll(false);
        setOpen(false);
      }}
      aria-pressed={l.id === id}
      title={l.country && l.type !== 'Cup' ? `${l.name} (${l.country})` : l.name}
      className={`flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl border px-1 py-2 text-xs leading-tight transition-colors ${
        l.id === id ? 'border-[var(--color-pitch)] bg-[var(--color-pitch-soft)] font-semibold text-[var(--color-ink)]' : 'border-transparent text-slate-600 hover:bg-slate-50'
      }`}
    >
      <TeamLogo src={l.logo_url} alt="" size={28} />
      <span className="line-clamp-2 text-center">{l.name}</span>
      {dup.has(l.name) && l.country ? <span className="-mt-0.5 text-xs text-slate-600">{l.country}</span> : null}
    </button>
  );

  return (
    <>
      <Section title="ลีกที่เราวิเคราะห์" aside={`ทั้งหมด ${widgets.length}`}>
        <div className="grid grid-cols-5 gap-1" role="group" aria-label="ลีกใหญ่">
          {big.map((x) => pick(x.league))}
        </div>
        {more.length ? (
          <>
            <button
              type="button"
              onClick={() => setOpen((x) => !x)}
              aria-expanded={open}
              aria-controls={pickerId}
              className="mt-2 flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-1 text-left text-sm font-medium text-[var(--color-pitch)] hover:bg-slate-50"
            >
              <span>{open ? 'ซ่อน' : `ลีกอื่น ๆ อีก ${more.length} รายการ`}</span>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <div id={pickerId} hidden={!open} className="mt-2 space-y-3">
              {groups.map((g) => (
                <div key={g.label}>
                  <h3 className="mb-1.5 text-xs font-medium text-slate-500">
                    {g.label} <span className="tabular-nums">({g.items.length})</span>
                  </h3>
                  <div className="grid grid-cols-4 gap-1.5" role="group" aria-label={`เลือก${g.label}`}>
                    {g.items.map((x) => pick(x.league))}
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}
      </Section>

      <Section
        title={
          <span className="flex items-center gap-2">
            <TeamLogo src={w.league.logo_url} alt="" size={18} />
            ตารางคะแนน
          </span>
        }
        aside={w.league.name}
      >
        {w.standings.length ? (
          <>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-slate-500">
                  <th className="pb-1.5 text-left font-normal">#</th>
                  <th className="pb-1.5 text-left font-normal">ทีม</th>
                  <th className="pb-1.5 text-right font-normal">แข่ง</th>
                  <th className="pb-1.5 text-right font-normal">+/-</th>
                  <th className="pb-1.5 text-right font-normal">แต้ม</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {table.map((r) => (
                  <tr key={r.team.id} className="border-t border-slate-100">
                    <td className="w-6 py-1.5 text-xs text-slate-500">{r.rank}</td>
                    <td className="max-w-0 py-1.5">
                      <span className="flex items-center gap-1.5">
                        <TeamLogo src={r.team.logo_url} alt="" size={16} />
                        <span className="truncate">{r.team.name}</span>
                      </span>
                    </td>
                    <td className="w-9 py-1.5 text-right text-slate-600">{r.played}</td>
                    <td className="w-9 py-1.5 text-right text-slate-600">{r.goals_diff > 0 ? `+${r.goals_diff}` : r.goals_diff}</td>
                    <td className="w-9 py-1.5 text-right font-semibold">{r.points}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {w.standings.length > 10 ? (
              <button type="button" onClick={() => setAll((x) => !x)} className="mt-2 min-h-11 w-full rounded-lg text-sm font-medium text-[var(--color-pitch)] hover:bg-slate-50">
                {all ? 'ย่อเหลือ 10 อันดับ' : `ดูทั้งหมด ${w.standings.length} ทีม`}
              </button>
            ) : null}
          </>
        ) : (
          <Empty>ลีกนี้แข่งแบบแบ่งกลุ่ม ยังไม่มีตารางคะแนนรวม</Empty>
        )}
      </Section>

      <Section title="ดาวซัลโว" aside={w.league.name}>
        {w.scorers.length ? (
          <ol className="space-y-2">
            {w.scorers.map((p, i) => (
              <li key={`${p.player}-${i}`} className="flex items-center gap-2.5">
                <span className="w-4 text-right text-xs tabular-nums text-slate-500">{i + 1}</span>
                {p.photo_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.photo_url} alt="" width={32} height={32} loading="lazy" className="h-8 w-8 shrink-0 rounded-full bg-slate-100 object-cover" />
                ) : (
                  <span className="h-8 w-8 shrink-0 rounded-full bg-slate-200" aria-hidden />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{p.player}</span>
                  <span className="flex items-center gap-1 text-xs text-slate-500">
                    <TeamLogo src={p.team.logo_url} alt="" size={12} />
                    <span className="truncate">{p.team.name}</span>
                  </span>
                </span>
                <span className="text-right tabular-nums">
                  <span className="block text-base font-bold leading-none">{p.goals}</span>
                  <span className="text-xs text-slate-500">ประตู</span>
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <Empty>ยังไม่มีข้อมูลผู้ทำประตู</Empty>
        )}
      </Section>
    </>
  );
}

import Link from 'next/link';
import type { MatchRow } from '@/lib/queries';
import { FINISHED, LIVE, selectionLabel } from '@/lib/labels';
import { timeTH } from '@/lib/time';
import { StatusBadge, TeamLogo } from './ui';

const OFF: Record<string, string> = { PST: 'เลื่อน', CANC: 'ยกเลิก', ABD: 'ยุติ' };

/** Matches grouped by league, in kickoff order. */
export function MatchList({ matches }: { matches: MatchRow[] }) {
  const groups = new Map<number, { league: MatchRow['league']; rows: MatchRow[] }>();
  for (const m of matches) {
    const g = groups.get(m.league.id) ?? { league: m.league, rows: [] };
    g.rows.push(m);
    groups.set(m.league.id, g);
  }
  return (
    <div className="space-y-3">
      {[...groups.values()].map(({ league, rows }) => (
        <div key={league.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-sm font-semibold">
            <TeamLogo src={league.logo_url} alt="" size={18} />
            <span className="truncate">{league.name}</span>
            {league.country ? <span className="shrink-0 font-normal text-slate-500">· {league.country}</span> : null}
            <span className="ml-auto shrink-0 text-xs font-normal text-slate-500">{rows.length} คู่</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {rows.map((m) => (
              <MatchItem key={m.id} m={m} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function MatchItem({ m }: { m: MatchRow }) {
  const finished = FINISHED.includes(m.status_short);
  const live = LIVE.includes(m.status_short);
  const c = m.compass;
  return (
    <li>
      <Link href={`/matches/${m.slug}`} className="grid min-h-16 grid-cols-[3.25rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors duration-150 hover:bg-slate-50 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]">
        <div className="text-xs">
          {live ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-live)] px-1.5 py-0.5 font-semibold text-white">{m.status_short === 'HT' ? 'HT' : `${m.elapsed ?? ''}′`}</span>
          ) : finished ? (
            <span className="text-slate-500">จบ</span>
          ) : OFF[m.status_short] ? (
            <span className="font-medium text-rose-700">{OFF[m.status_short]}</span>
          ) : (
            <span className="text-sm font-semibold tabular-nums">{timeTH(m.kickoff_at)}</span>
          )}
        </div>
        <div className="space-y-1 text-sm">
          {[
            [m.home, m.goals_home],
            [m.away, m.goals_away],
          ].map(([t, g], i) => (
            <div key={i} className="flex items-center gap-2">
              <TeamLogo src={(t as MatchRow['home']).logo_url} alt="" size={20} />
              <span className="truncate">{(t as MatchRow['home']).name}</span>
              {finished || live ? <span className="ml-auto pl-2 font-semibold tabular-nums">{g as number | null}</span> : null}
            </div>
          ))}
        </div>
        {m.preview ? (
          <p className="col-start-2 line-clamp-2 text-xs leading-relaxed text-slate-600 sm:col-span-2">
            <span className="mr-1" aria-hidden>🔎</span>
            {m.preview.overview_th}
          </p>
        ) : null}
        {c ? (
          <div className="col-start-2 flex flex-wrap items-center gap-1.5 sm:col-start-3 sm:row-start-1 sm:flex-col sm:items-end">
            {c.kind === 'SIGNAL' ? (
              <>
                <span className="rounded-full bg-[var(--color-compass-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--color-compass)]">
                  🧭 {selectionLabel(c.market!, c.selection!, c.line == null ? null : Number(c.line), m.home.name, m.away.name)}
                </span>
                {c.status !== 'PENDING' ? <StatusBadge status={c.status} /> : <span className="text-xs text-slate-500">{c.signal_strength}</span>}
              </>
            ) : (
              <span className="text-xs text-slate-500">🌫️ หมอกข้อมูล</span>
            )}
          </div>
        ) : null}
      </Link>
    </li>
  );
}

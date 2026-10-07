import Link from 'next/link';
import type { MatchRow } from '@/lib/queries';
import { FINISHED, LIVE, selectionLabel } from '@/lib/labels';
import { timeTH } from '@/lib/time';
import { StatusBadge, TeamLogo } from './ui';

/** Matches grouped by league, in kickoff order. */
export function MatchList({ matches }: { matches: MatchRow[] }) {
  const groups = new Map<number, { league: MatchRow['league']; rows: MatchRow[] }>();
  for (const m of matches) {
    const g = groups.get(m.league.id) ?? { league: m.league, rows: [] };
    g.rows.push(m);
    groups.set(m.league.id, g);
  }
  return (
    <div className="space-y-4">
      {[...groups.values()].map(({ league, rows }) => (
        <div key={league.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-semibold">
            <TeamLogo src={league.logo_url} alt="" size={18} />
            {league.name}
            {league.country ? <span className="font-normal text-slate-400">· {league.country}</span> : null}
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
      <Link href={`/matches/${m.slug}`} className="grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 px-4 py-3 hover:bg-slate-50">
        <div className="text-xs text-slate-500">
          {live ? <span className="font-semibold text-rose-600">{m.elapsed ?? ''}′ LIVE</span> : finished ? 'จบ' : ['PST', 'CANC', 'ABD'].includes(m.status_short) ? m.status_short : timeTH(m.kickoff_at)}
        </div>
        <div className="min-w-0 space-y-1 text-sm">
          {[
            [m.home, m.goals_home],
            [m.away, m.goals_away],
          ].map(([t, g], i) => (
            <div key={i} className="flex items-center gap-2">
              <TeamLogo src={(t as MatchRow['home']).logo_url} alt="" size={18} />
              <span className="truncate">{(t as MatchRow['home']).name}</span>
              {finished || live ? <span className="ml-auto font-semibold tabular-nums">{g as number | null}</span> : null}
            </div>
          ))}
        </div>
        <div className="flex flex-col items-end gap-1 text-right">
          {c ? (
            c.kind === 'SIGNAL' ? (
              <>
                <span className="rounded-full bg-[var(--color-compass-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--color-compass)]">
                  🧭 {selectionLabel(c.market!, c.selection!, c.line == null ? null : Number(c.line), m.home.name, m.away.name)}
                </span>
                {c.status !== 'PENDING' ? <StatusBadge status={c.status} /> : <span className="text-[10px] text-slate-400">{c.signal_strength}</span>}
              </>
            ) : (
              <span className="text-xs text-slate-400">🌫️ หมอกข้อมูล</span>
            )
          ) : null}
        </div>
      </Link>
    </li>
  );
}

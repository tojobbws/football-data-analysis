import Link from 'next/link';
import { odds, pct, selectionLabel } from '@/lib/labels';
import { dayTH, timeTH } from '@/lib/time';

export interface SignalCardData {
  slug: string;
  league: string;
  kickoff_at: string;
  home: string;
  away: string;
  market: string;
  selection: string;
  line: number | null;
  signal_strength: string | null;
  model_probability: number | null;
  market_probability: number | null;
  odds_at_publish: number | null;
}

/** One 🧭 pick, linking to its match page. */
export function SignalCard({ s }: { s: SignalCardData }) {
  return (
    <Link
      href={`/matches/${s.slug}`}
      className="block h-full rounded-xl border border-[var(--color-compass)]/25 bg-gradient-to-br from-[var(--color-compass-soft)] to-white p-3 transition-shadow duration-200 hover:shadow-md"
    >
      <p className="text-xs text-slate-600">
        {s.league} · {dayTH(s.kickoff_at)} {timeTH(s.kickoff_at)}
      </p>
      <p className="mt-0.5 truncate text-sm font-medium">
        {s.home} vs {s.away}
      </p>
      <p className="mt-1.5 text-base font-bold leading-snug text-[var(--color-compass)]">🧭 {selectionLabel(s.market, s.selection, s.line == null ? null : Number(s.line), s.home, s.away)}</p>
      <p className="mt-1 text-xs text-slate-600">
        {s.signal_strength} · โมเดล {pct(s.model_probability)} vs ตลาด {pct(s.market_probability)} · ราคา {odds(s.odds_at_publish)}
      </p>
    </Link>
  );
}

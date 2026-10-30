import Link from 'next/link';
import { ResultMark, TeamLogo } from '@/components/ui';
import { FINISHED, selectionLabel, type Status } from '@/lib/labels';
import type { WatchedPick } from '@/lib/queries';
import { addDaysStr } from '@/lib/time';

/** Shared by /performance (the week) and /performance/[date] (one day): the day's numbers and a pick card. */

const DAY = new Intl.DateTimeFormat('th-TH', { weekday: 'long', timeZone: 'UTC' });
const DAY_MONTH = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const dateUtc = (date: string) => new Date(`${date}T00:00:00Z`);
export const dayName = (date: string) => DAY.format(dateUtc(date));
export const dayMonth = (date: string) => DAY_MONTH.format(dateUtc(date));
export const dayMonthYear = (date: string) => DAY_MONTH_YEAR.format(dateUtc(date));
export const dayOfMonth = (date: string) => String(Number(date.slice(8, 10)));

/** Monday of the week `date` falls in. */
export function mondayOf(date: string): string {
  return addDaysStr(date, -((dateUtc(date).getUTCDay() + 6) % 7));
}

const RIGHT: Status[] = ['WIN', 'HALF_WIN'];
const WRONG: Status[] = ['LOSS', 'HALF_LOSS'];

/**
 * Simulated result of one unit on a pick at the odds it was published with (decimal odds, same formula as expectedValue):
 * a win returns odds − 1, a loss costs 1, halves count half, PUSH / VOID return 0. Null while unsettled or without odds.
 */
function unitResult(p: WatchedPick): number | null {
  if (p.status === 'PUSH' || p.status === 'VOID') return 0;
  if (p.status === 'LOSS') return -1;
  if (p.status === 'HALF_LOSS') return -0.5;
  if ((p.status === 'WIN' || p.status === 'HALF_WIN') && p.odds != null) return (p.odds - 1) * (p.status === 'HALF_WIN' ? 0.5 : 1);
  return null;
}

export const signed = (x: number) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(2)}`;

/** Same counting as the track record: a half result counts half, PUSH / VOID / pending stay out. */
export function daySummary(picks: WatchedPick[]) {
  let right = 0;
  let wrong = 0;
  let net = 0;
  let counted = 0;
  for (const p of picks) {
    const half = p.status === 'HALF_WIN' || p.status === 'HALF_LOSS' ? 0.5 : 1;
    if (RIGHT.includes(p.status)) right += half;
    else if (WRONG.includes(p.status)) wrong += half;
    const u = unitResult(p);
    if (u != null) {
      net += u;
      counted += 1;
    }
  }
  const rate = right + wrong > 0 ? right / (right + wrong) : null;
  const tone = rate == null || right === wrong ? 'neutral' : right > wrong ? 'good' : 'bad';
  return { rate, tone, net: counted ? net : null, right, wrong } as const;
}

/** Green when the day got more right than wrong, red when more wrong, grey otherwise. */
export const CARD = {
  good: 'border-emerald-300 bg-emerald-50',
  bad: 'border-rose-300 bg-rose-50',
  neutral: 'border-slate-200 bg-white',
} as const;
export const RATE = { good: 'text-emerald-700', bad: 'text-rose-700', neutral: 'text-slate-600' } as const;
/** Secondary text on a tinted card takes the card's hue (slate-500 falls under 4.5:1 on rose-50). */
export const SUB = { good: 'text-emerald-800', bad: 'text-rose-800', neutral: 'text-slate-600' } as const;
export const netTone = (net: number) => (net > 0 ? 'text-emerald-700' : net < 0 ? 'text-rose-700' : 'text-slate-600');

export function PickCard({ p }: { p: WatchedPick }) {
  const finished = FINISHED.includes(p.status_short);
  const unit = unitResult(p);
  const label = selectionLabel(p.market as never, p.selection as never, p.line == null ? null : Number(p.line), p.home.name, p.away.name);
  // a side pick shows that team's logo; Over/Under and Draw have no single team, so both show
  const side = p.selection === 'HOME' ? [p.home] : p.selection === 'AWAY' ? [p.away] : [p.home, p.away];
  return (
    <Link href={`/matches/${p.slug}`} className="block rounded-xl bg-white/80 p-2 ring-1 ring-slate-200 hover:bg-white">
      <span className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1">
          {side.map((t) => (
            // the pick label and the line below already name the teams, so the logo is decoration for a screen reader
            <TeamLogo key={t.id} src={t.logo_url} alt="" size={side.length > 1 ? 40 : 52} />
          ))}
        </span>
        <ResultMark status={p.status} />
      </span>
      <span className="mt-1.5 block text-sm font-medium leading-snug">{label}</span>
      <span className="mt-0.5 block truncate text-[13px] text-slate-600">
        {p.home.name} {finished && p.goals_home != null ? `${p.goals_home}–${p.goals_away}` : 'vs'} {p.away.name}
      </span>
      {unit != null ? (
        <span className={`mt-0.5 block text-[13px] font-semibold tabular-nums ${unit > 0 ? 'text-emerald-700' : unit < 0 ? 'text-rose-700' : 'text-slate-600'}`}>
          {signed(unit)} หน่วย{p.odds != null ? <span className="font-normal text-slate-600"> · ราคา {p.odds.toFixed(2)}</span> : null}
        </span>
      ) : null}
    </Link>
  );
}

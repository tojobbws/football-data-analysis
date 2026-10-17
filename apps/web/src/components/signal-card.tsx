import Link from 'next/link';
import { ROUND_SHORT, odds, pct, selectionLabel } from '@/lib/labels';
import { footballDate, shortDayTH, timeTH } from '@/lib/time';
import { CompassMark, IconLock } from './icons';

export interface SignalCardData {
  slug: string;
  league: string;
  kickoff_at: string;
  home: string;
  away: string;
  home_logo?: string | null;
  away_logo?: string | null;
  market: string;
  selection: string;
  line: number | null;
  signal_strength: string | null;
  model_probability: number | null;
  market_probability: number | null;
  odds_at_publish: number | null;
  /** EARLY | LINEUP — which publish round locked this pick */
  round?: string | null;
}

const MARKET_SHORT: Record<string, string> = { MATCH_WINNER: 'ผลแพ้ชนะ 1X2', ASIAN_HANDICAP: 'กำแพง · แฮนดิแคป', OVER_UNDER: 'สูง/ต่ำ' };

/** "คืนนี้ / วันนี้" for today's football day (06:00→06:00), otherwise the short date. */
function whenLabel(iso: string) {
  const d = new Date(iso);
  if (footballDate(d) !== footballDate()) return shortDayTH(iso);
  const h = Number(timeTH(iso).slice(0, 2));
  return h >= 17 || h < 6 ? 'คืนนี้' : 'วันนี้';
}

/**
 * One 🧭 pick as a locked record slip: the selection is the headline, the edge meter shows
 * why (model probability vs the market's), strength and the lock sit underneath.
 * Dark on purpose, so a pick never looks like the model outlook or a plain fixture row.
 */
export function SignalCard({ s }: { s: SignalCardData }) {
  const label = selectionLabel(s.market, s.selection, s.line == null ? null : Number(s.line), s.home, s.away);
  const model = s.model_probability == null ? null : Number(s.model_probability);
  const market = s.market_probability == null ? null : Number(s.market_probability);
  const edge = model != null && market != null ? Math.round((model - market) * 100) : null;
  // a side pick (handicap / 1X2) names one team: that row leads, the other steps back; totals name neither
  const picked = s.market !== 'OVER_UNDER' && (s.selection === 'HOME' || s.selection === 'AWAY') ? s.selection : null;

  return (
    <Link
      href={`/matches/${s.slug}`}
      className="group flex h-full flex-col rounded-2xl bg-[var(--color-ink)] p-4 text-white shadow-[0_10px_24px_-14px_rgb(11_19_36/0.7)] ring-1 ring-white/5 transition-[transform,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:shadow-[0_16px_32px_-14px_rgb(11_19_36/0.8)] focus-visible:outline-[var(--color-compass)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-white/65">{s.league}</p>
          <ul className="mt-2 space-y-1.5">
            <TeamRow name={s.home} logo={s.home_logo ?? null} state={picked ? (picked === 'HOME' ? 'picked' : 'other') : 'plain'} />
            <TeamRow name={s.away} logo={s.away_logo ?? null} state={picked ? (picked === 'AWAY' ? 'picked' : 'other') : 'plain'} />
          </ul>
        </div>
        <p className="shrink-0 text-right leading-tight">
          <span className="block text-lg font-bold tabular-nums">{timeTH(s.kickoff_at)}</span>
          <span className="text-xs text-white/65">{whenLabel(s.kickoff_at)}</span>
        </p>
      </div>

      <div className="mt-4">
        <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-compass-bright)]">
          <CompassMark size={20} />
          {MARKET_SHORT[s.market] ?? s.market}
        </p>
        <p className="mt-1 text-2xl font-bold leading-tight tracking-tight text-balance">{label}</p>
      </div>

      {model != null && market != null ? (
        <div className="mt-4">
          <p className="mb-1.5 text-right text-xs">
            <span className="text-white/65">ส่วนต่าง </span>
            <b className="font-semibold tabular-nums">{edge! > 0 ? '+' : ''}{edge} จุด</b>
          </p>
          <EdgeMeter model={model} market={market} />
        </div>
      ) : null}

      <div className="mt-auto pt-4">
        <div className="flex items-center justify-between gap-3 border-t border-white/10 pt-3 text-xs">
          <span />
          <span className="text-white/65">
            ราคาอ้างอิง <b className="font-semibold tabular-nums text-white">{odds(s.odds_at_publish)}</b>
          </span>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-white/55">
          <IconLock size={12} />
          ล็อกก่อนเตะ{s.round ? ` · ${ROUND_SHORT[s.round] ?? s.round}` : ''} · แก้ไขไม่ได้
        </p>
      </div>
    </Link>
  );
}

/**
 * One team of the fixture. Logos sit on a light tile so dark crests stay readable on the ink card.
 * picked = the side the model chose (full weight, amber ring), other = its opponent (dimmed).
 */
function TeamRow({ name, logo, state }: { name: string; logo: string | null; state: 'picked' | 'other' | 'plain' }) {
  return (
    // relative: keeps the sr-only label inside the card (absolute text escaped the rail and widened the page on phones)
    <li className={`relative flex items-center gap-2.5 ${state === 'other' ? 'opacity-55' : ''}`}>
      <span
        className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white ${state === 'picked' ? 'ring-2 ring-[var(--color-compass-bright)] ring-offset-2 ring-offset-[var(--color-ink)]' : ''}`}
      >
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" width={24} height={24} loading="lazy" className="h-6 w-6 object-contain" />
        ) : (
          <span className="h-5 w-5 rounded-full bg-slate-200" aria-hidden />
        )}
      </span>
      <span className={`min-w-0 truncate leading-snug ${state === 'picked' ? 'text-base font-bold text-white' : 'text-sm font-medium text-white/90'}`}>{name}</span>
      {state === 'picked' ? <span className="sr-only">(ฝั่งที่โมเดลเลือก)</span> : null}
    </li>
  );
}

/** 0–100% track: the market's share in grey, the model's extra (the edge) in compass amber. */
/**
 * Grey fill = market, white tick = model, gold = the gap between them. Each label sits under its
 * own mark: the lower one ends at its mark, the higher one starts at it, so they never overlap.
 */
function EdgeMeter({ model, market }: { model: number; market: number }) {
  const lo = Math.min(model, market) * 100;
  const hi = Math.max(model, market) * 100;
  const label = (k: string, p: number, tone = '') => (
    <>
      <dt className="text-white/65">{k}</dt>
      <dd className={`font-semibold tabular-nums ${tone}`}>{pct(p)}</dd>
    </>
  );
  const modelLabel = label('โมเดล', model, 'text-[var(--color-compass-bright)]');
  const marketLabel = label('ตลาด', market);
  return (
    <>
      <div className="relative h-2 rounded-full bg-white/10" aria-hidden>
        <span className="absolute inset-y-0 left-0 rounded-full bg-white/30" style={{ width: `${market * 100}%` }} />
        <span className="absolute inset-y-0 rounded-r-full bg-[var(--color-compass-bright)]" style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
        <span className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-white" style={{ left: `${model * 100}%` }} />
      </div>
      {/* clamp keeps a label near either end inside the card */}
      <dl className="relative mt-2 h-8 text-xs leading-4">
        <div className="absolute top-0 whitespace-nowrap text-right" style={{ right: `clamp(0%, ${100 - lo}%, calc(100% - 3rem))` }}>
          {model < market ? modelLabel : marketLabel}
        </div>
        <div className="absolute top-0 whitespace-nowrap" style={{ left: `clamp(0%, ${hi}%, calc(100% - 3rem))` }}>
          {model < market ? marketLabel : modelLabel}
        </div>
      </dl>
    </>
  );
}

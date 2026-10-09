import type { ReactNode } from 'react';
import type { Status } from '@/lib/labels';

// shadcn-style building blocks for the match page: bordered cards on white, outline badges,
// rule-divided stat strips. No icons, no gradients — type and hairlines do the work.

export function Card({
  id,
  title,
  description,
  action,
  children,
  tone = 'default',
  className = '',
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  /** `pick` = the one compass-amber card on the page */
  tone?: 'default' | 'pick';
  className?: string;
}) {
  const edge = tone === 'pick' ? 'border-amber-300 shadow-[0_1px_2px_rgb(9_9_11/0.04)]' : 'border-zinc-200 shadow-[0_1px_2px_rgb(9_9_11/0.04)]';
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className={`scroll-mt-32 rounded-xl border bg-white ${edge} ${className}`}>
      <header className="flex items-start justify-between gap-4 px-4 pt-4 sm:px-5 sm:pt-5">
        <div className="min-w-0">
          <h2 id={id ? `${id}-title` : undefined} className="text-[15px] font-semibold leading-snug tracking-tight text-zinc-950">
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div className="px-4 pb-4 pt-4 sm:px-5 sm:pb-5">{children}</div>
    </section>
  );
}

const BADGE = {
  outline: 'border-zinc-200 bg-white text-zinc-700',
  secondary: 'border-transparent bg-zinc-100 text-zinc-700',
  solid: 'border-transparent bg-zinc-900 text-white',
  compass: 'border-amber-300 bg-amber-50 text-amber-900',
  good: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  warn: 'border-zinc-300 bg-white text-zinc-700',
  half: 'border-rose-200 bg-white text-rose-700',
  bad: 'border-rose-200 bg-rose-50 text-rose-800',
  live: 'border-transparent bg-[var(--color-live)] text-white',
} as const;

export function Badge({ children, variant = 'outline' }: { children: ReactNode; variant?: keyof typeof BADGE }) {
  return <span className={`inline-flex items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium ${BADGE[variant]}`}>{children}</span>;
}

/** Settlement status as a plain-text badge. HALF results stay separate from WIN / LOSS. */
const STATUS_BADGE: Record<Status, { label: string; variant: keyof typeof BADGE }> = {
  PENDING: { label: 'รอผล', variant: 'secondary' },
  WIN: { label: 'WIN', variant: 'good' },
  HALF_WIN: { label: 'HALF WIN', variant: 'good' },
  LOSS: { label: 'LOSS', variant: 'bad' },
  HALF_LOSS: { label: 'HALF LOSS', variant: 'half' },
  PUSH: { label: 'PUSH', variant: 'outline' },
  VOID: { label: 'VOID', variant: 'outline' },
  NO_SIGNAL: { label: 'ไม่มีตัวเลือก', variant: 'outline' },
};

export function StatusPill({ status }: { status: Status }) {
  const s = STATUS_BADGE[status] ?? STATUS_BADGE.PENDING;
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/** A row of figures separated by hairlines (one bordered strip, not a card per number). */
export function StatStrip({ items }: { items: Array<{ k: ReactNode; v: ReactNode; tone?: string }> }) {
  return (
    <dl className={`grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-zinc-200 bg-zinc-200 ${items.length >= 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
      {items.map((it, i) => (
        <div key={i} className="bg-white px-3 py-2.5">
          <dt className="text-xs text-zinc-500">{it.k}</dt>
          <dd className={`mt-0.5 text-base font-semibold tabular-nums ${it.tone ?? 'text-zinc-950'}`}>{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Small print under a card's content. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="mt-4 border-t border-zinc-100 pt-3 text-xs leading-relaxed text-zinc-500">{children}</p>;
}

/** Drop leading emoji / bullets / check marks from a stored text line (display only; the record is untouched). */
export function plainLine(s: string): string {
  return s.replace(/^[\p{Extended_Pictographic}\u{FE0F}\u{200D}✓✗•·\s-]+/u, '').trim();
}

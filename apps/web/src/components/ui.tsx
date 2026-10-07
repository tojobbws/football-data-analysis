import Link from 'next/link';
import type { ReactNode } from 'react';
import { STATUS, type Status } from '@/lib/labels';

export function Section({ title, aside, children, className = '' }: { title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-4 sm:p-5 ${className}`}>
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-base font-semibold">{title}</h2>
        {aside ? <div className="text-xs text-slate-500">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function StatusBadge({ status }: { status: Status }) {
  const s = STATUS[status] ?? STATUS.PENDING;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.tone}`}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  );
}

export function TeamLogo({ src, alt, size = 24 }: { src: string | null; alt: string; size?: number }) {
  if (!src) return <span className="inline-block rounded-full bg-slate-200" style={{ width: size, height: size }} aria-hidden />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={alt} width={size} height={size} loading="lazy" className="inline-block shrink-0 object-contain" style={{ width: size, height: size }} />;
}

export function FormPills({ results }: { results: Array<'W' | 'D' | 'L'> }) {
  const tone = { W: 'bg-emerald-600', D: 'bg-slate-400', L: 'bg-rose-500' } as const;
  return (
    <span className="inline-flex gap-1">
      {results.map((r, i) => (
        <span key={i} className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold text-white ${tone[r]}`}>
          {r}
        </span>
      ))}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">{children}</p>;
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-[var(--color-pitch)] hover:underline">
      {children}
    </Link>
  );
}

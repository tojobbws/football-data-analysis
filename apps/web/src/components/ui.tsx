import Link from 'next/link';
import type { ReactNode } from 'react';
import { ADMIN_STATUS_LABEL, STATUS, type Status } from '@/lib/labels';

export { Empty, Section, TeamLogo } from './primitives';

export function StatusBadge({ status, admin = false }: { status: Status; admin?: boolean }) {
  const s = STATUS[status] ?? STATUS.PENDING;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${s.tone}`}>
      <span aria-hidden>{s.icon}</span>
      {admin ? (ADMIN_STATUS_LABEL[status] ?? s.label) : s.label}
    </span>
  );
}

/** ถูก/ผิด on a finished คู่น่าจับตา: a tick or a cross with the outcome word (รอผล until it is settled). */
export function ResultMark({ status }: { status: Status }) {
  const s = STATUS[status] ?? STATUS.PENDING;
  const right = status === 'WIN' || status === 'HALF_WIN';
  const wrong = status === 'LOSS' || status === 'HALF_LOSS';
  const tone = right ? 'bg-emerald-600 text-white' : wrong ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-700';
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full py-0.5 pl-1 pr-2 text-xs font-bold ${tone}`}>
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
        {right ? <path d="M5 12.5l4.5 4.5L19 7.5" /> : wrong ? <path d="M7 7l10 10M17 7L7 17" /> : <path d="M7 12h10" />}
      </svg>
      {s.label}
    </span>
  );
}

export function FormPills({ results }: { results: Array<'W' | 'D' | 'L'> }) {
  const tone = { W: 'bg-emerald-700', D: 'bg-slate-500', L: 'bg-rose-600' } as const;
  return (
    <span className="inline-flex gap-1">
      {results.map((r, i) => (
        <span key={i} className={`inline-flex h-6 w-6 items-center justify-center rounded text-xs font-bold text-white ${tone[r]}`}>
          {r}
        </span>
      ))}
    </span>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-[var(--color-pitch)] hover:underline">
      {children}
    </Link>
  );
}

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

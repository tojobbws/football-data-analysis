import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { requireAdmin } from '@/lib/auth';
import { logout } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'หลังบ้าน', robots: { index: false, follow: false } };

const nav = [
  { href: '/admin', label: 'ภาพรวมระบบ' },
  { href: '/admin/analyses', label: '🧭 บทวิเคราะห์ & AI' },
  { href: '/admin/review', label: '📊 ทบทวนผล' },
  { href: '/admin/articles', label: '📝 บทความ' },
];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const admin = await requireAdmin();
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[var(--color-ink)] px-4 py-3 text-sm text-white">
        <nav className="flex flex-wrap gap-1">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="rounded-full px-3 py-1 hover:bg-white/10">
              {n.label}
            </Link>
          ))}
        </nav>
        <form action={logout} className="flex items-center gap-3 text-xs text-slate-300">
          {admin.email} · {admin.role}
          <button className="rounded-full bg-white/10 px-3 py-1 text-white hover:bg-white/20">ออกจากระบบ</button>
        </form>
      </div>
      {children}
    </div>
  );
}

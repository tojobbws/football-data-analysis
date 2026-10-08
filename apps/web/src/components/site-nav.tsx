'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconArticle, IconCalendar, IconChart, IconHome, Logo } from './icons';

const NAV = [
  { href: '/', label: 'หน้าแรก', Icon: IconHome },
  { href: '/matches', label: 'แมตช์', Icon: IconCalendar },
  { href: '/analysis', label: 'บทวิเคราะห์', Icon: IconArticle },
  { href: '/performance', label: 'ผลงาน', long: 'ผลงานการวิเคราะห์', Icon: IconChart },
] as const;

const isActive = (path: string, href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`));

/** Top bar on every screen; on mobile the links move to a bottom tab bar (thumb reach). */
export function SiteNav() {
  const path = usePathname() ?? '/';
  const admin = path.startsWith('/admin');

  return (
    <>
      <header className="sticky top-0 z-30 bg-[var(--color-ink)] text-white shadow-[0_1px_0_rgb(255_255_255/0.06)]">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-4 px-4 md:h-16">
          <Link href="/" className="flex shrink-0 items-center gap-2.5 whitespace-nowrap" aria-label="เข็มทิศเกม หน้าแรก">
            <Logo size={32} />
            <span className="leading-tight">
              <span className="block text-base font-bold tracking-tight">เข็มทิศเกม</span>
              <span className="hidden text-[11px] text-slate-300 sm:block">Football Data &amp; Analysis</span>
            </span>
          </Link>

          {!admin ? (
            <nav aria-label="เมนูหลัก" className="hidden h-full md:block">
              <ul className="flex h-full items-stretch gap-1">
                {NAV.map(({ href, label, ...n }) => {
                  const on = isActive(path, href);
                  return (
                    <li key={href} className="flex">
                      <Link
                        href={href}
                        aria-current={on ? 'page' : undefined}
                        className={`relative flex items-center gap-2 px-3 text-sm transition-colors duration-150 ${on ? 'font-semibold text-white' : 'text-slate-300 hover:text-white'}`}
                      >
                        <n.Icon size={18} />
                        {'long' in n ? n.long : label}
                        <span className={`absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[var(--color-pitch-bright)] transition-opacity ${on ? 'opacity-100' : 'opacity-0'}`} aria-hidden />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ) : null}
        </div>
      </header>

      {!admin ? (
        <nav
          aria-label="เมนูหลัก"
          className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        >
          <ul className="grid h-[var(--spacing-tabbar)] grid-cols-4">
            {NAV.map(({ href, label, Icon }) => {
              const on = isActive(path, href);
              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={on ? 'page' : undefined}
                    className={`flex h-full flex-col items-center justify-center gap-1 text-xs transition-colors duration-150 ${on ? 'font-semibold text-[var(--color-pitch)]' : 'text-slate-600'}`}
                  >
                    <span className={`flex h-7 w-12 items-center justify-center rounded-full transition-colors ${on ? 'bg-[var(--color-pitch-soft)]' : ''}`}>
                      <Icon size={20} />
                    </span>
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      ) : null}
    </>
  );
}

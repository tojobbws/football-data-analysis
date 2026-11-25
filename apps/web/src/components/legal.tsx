import type { ReactNode } from 'react';
import { CONTACT_EMAIL, SITE_NAME } from '@/lib/brand';

/** The frame of /privacy and /terms: a title, the date of the last change, then numbered sections. */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:py-10">
      <header>
        <h1 className="text-2xl font-bold sm:text-3xl">{title}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {SITE_NAME} (khemthitfootball.com) · ปรับปรุงล่าสุด {updated}
        </p>
      </header>
      <div className="space-y-6 text-[15px] leading-relaxed text-slate-800">{children}</div>
    </main>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export const legalList = 'list-disc space-y-1 pl-6';
export const legalLink = 'text-sky-700 underline underline-offset-2';

/** How to reach us; an address only once the owner has named one. */
export function LegalContact() {
  return CONTACT_EMAIL ? (
    <p>
      ติดต่อเราได้ที่ <a href={`mailto:${CONTACT_EMAIL}`} className={legalLink}>{CONTACT_EMAIL}</a>
    </p>
  ) : (
    <p>ติดต่อเราได้ทางข้อความในเพจโซเชียลของ{SITE_NAME}</p>
  );
}

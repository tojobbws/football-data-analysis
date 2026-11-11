'use client';

import Link from 'next/link';

/**
 * A page that failed on the server (usually a database read that did not come back) keeps the site's header
 * and says so in Thai, with a retry, instead of Next's bare English error screen.
 * error.digest matches the server log line of the failure (Workers Logs).
 */
export default function PageError({ error, retry }: { error: unknown; retry: () => void }) {
  const digest = error instanceof Error && 'digest' in error ? String((error as Error & { digest?: string }).digest ?? '') : '';
  return (
    <main className="mx-auto max-w-5xl px-4 py-20 text-center">
      <h1 className="text-xl font-bold">โหลดหน้านี้ไม่สำเร็จ</h1>
      <p className="mt-2 text-sm text-slate-600">ระบบดึงข้อมูลไม่ทันในครั้งนี้ ลองโหลดใหม่อีกครั้ง</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="min-h-11 rounded-full bg-[var(--color-ink)] px-5 py-2 text-sm text-white"
        >
          โหลดใหม่
        </button>
        <Link href="/today" className="inline-flex min-h-11 items-center rounded-full px-5 py-2 text-sm text-[var(--color-pitch)] ring-1 ring-inset ring-slate-200">
          ดูวิเคราะห์ทุกคู่วันนี้
        </Link>
      </div>
      {digest ? <p className="mt-10 font-mono text-xs text-slate-400">รหัส {digest}</p> : null}
    </main>
  );
}

import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-20 text-center">
      <p className="text-5xl">🌫️</p>
      <h1 className="mt-4 text-xl font-bold">ไม่พบหน้านี้</h1>
      <p className="mt-2 text-sm text-slate-600">ลิงก์อาจเปลี่ยนไป หรือแมตช์นี้ไม่อยู่ในลีกที่เราติดตาม</p>
      <Link href="/matches" className="mt-6 inline-block rounded-full bg-[var(--color-ink)] px-5 py-2 text-sm text-white">
        ดูแมตช์ทั้งหมด
      </Link>
    </main>
  );
}

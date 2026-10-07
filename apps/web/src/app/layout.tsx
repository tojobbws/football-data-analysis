import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Sans_Thai } from 'next/font/google';
import Link from 'next/link';
import './globals.css';

const thai = IBM_Plex_Sans_Thai({ subsets: ['thai', 'latin'], weight: ['400', '500', '600', '700'], variable: '--font-thai', display: 'swap' });

export const metadata: Metadata = {
  title: { default: '🧭 เข็มทิศเกม — Football Data & Analysis', template: '%s | เข็มทิศเกม' },
  description: 'วิเคราะห์ฟุตบอลด้วย Data, Model และ Market — ทุกบทวิเคราะห์ถูกบันทึกก่อนเตะ และตรวจสอบผลงานย้อนหลังได้ทั้งหมด',
};

const nav = [
  { href: '/', label: 'หน้าแรก' },
  { href: '/matches', label: '🔎 แมตช์' },
  { href: '/performance', label: '📊 ผลงานการวิเคราะห์' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th" className={thai.variable}>
      <body className="min-h-screen font-sans antialiased">
        <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-bold tracking-tight">
              <span className="text-xl">🧭</span>
              <span>เข็มทิศเกม</span>
            </Link>
            <nav className="flex gap-1 overflow-x-auto text-sm">
              {nav.map((n) => (
                <Link key={n.href} href={n.href} className="whitespace-nowrap rounded-full px-3 py-1.5 text-slate-600 hover:bg-slate-100 hover:text-slate-900">
                  {n.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        {children}
        <footer className="mt-16 border-t border-slate-200 bg-white">
          <div className="mx-auto max-w-5xl space-y-2 px-4 py-8 text-xs leading-relaxed text-slate-500">
            <p>บทวิเคราะห์จัดทำขึ้นเพื่อข้อมูลและความบันเทิง ไม่ใช่คำแนะนำในการเล่นพนัน และไม่มีโมเดลใดรับประกันผลการแข่งขันได้</p>
            <p>ทุกบทวิเคราะห์ถูกบันทึกก่อนเตะ แก้ไขหรือลบไม่ได้ และแสดงผลทั้งที่ถูกและผิด</p>
          </div>
        </footer>
      </body>
    </html>
  );
}

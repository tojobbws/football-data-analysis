import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Sans_Thai } from 'next/font/google';
import Link from 'next/link';
import { IconShield, Logo } from '@/components/icons';
import { SiteNav } from '@/components/site-nav';
import './globals.css';

const thai = IBM_Plex_Sans_Thai({ subsets: ['thai', 'latin'], weight: ['400', '500', '600', '700'], variable: '--font-thai', display: 'swap' });

export const metadata: Metadata = {
  title: { default: '🧭 เข็มทิศเกม — Football Data & Analysis', template: '%s | เข็มทิศเกม' },
  description: 'วิเคราะห์ฟุตบอลด้วย Data, Model และ Market — ทุกบทวิเคราะห์ถูกบันทึกก่อนเตะ และตรวจสอบผลงานย้อนหลังได้ทั้งหมด',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover', // lets the bottom tab bar pad for the home indicator
  themeColor: '#0b1324',
};

const footerLinks = [
  { href: '/matches', label: 'แมตช์' },
  { href: '/analysis', label: 'บทวิเคราะห์' },
  { href: '/performance', label: 'ผลงานการวิเคราะห์' },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th" className={thai.variable}>
      <body className="min-h-screen pb-[calc(var(--spacing-tabbar)+env(safe-area-inset-bottom))] font-sans antialiased md:pb-0">
        <SiteNav />
        {children}
        <footer className="mt-12 bg-[var(--color-ink)] text-slate-300">
          <div className="mx-auto grid max-w-5xl gap-6 px-4 py-10 text-sm sm:grid-cols-[1fr_auto]">
            <div className="space-y-3">
              <Link href="/" className="inline-flex items-center gap-2 font-bold text-white">
                <Logo size={28} />
                เข็มทิศเกม
              </Link>
              <p className="flex max-w-xl gap-2 text-xs leading-relaxed">
                <IconShield size={16} className="mt-0.5 shrink-0 text-[var(--color-pitch-bright)]" />
                ทุกบทวิเคราะห์ถูกบันทึกก่อนเตะ แก้ไขหรือลบไม่ได้ และแสดงผลทั้งที่ถูกและผิด
              </p>
              <p className="max-w-xl text-xs leading-relaxed text-slate-400">
                บทวิเคราะห์จัดทำขึ้นเพื่อข้อมูลและความบันเทิง ไม่ใช่คำแนะนำในการเล่นพนัน และไม่มีโมเดลใดรับประกันผลการแข่งขันได้
              </p>
            </div>
            <nav aria-label="ลิงก์ท้ายเว็บ">
              <ul className="flex flex-wrap gap-x-5 gap-y-1 sm:flex-col">
                {footerLinks.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="inline-flex min-h-11 items-center hover:text-white sm:min-h-0">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}

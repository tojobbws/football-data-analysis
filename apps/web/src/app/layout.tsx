import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Football Data & Analysis', template: '%s | Football Data & Analysis' },
  description: 'วิเคราะห์ฟุตบอลด้วย Data, Model และ Market — พร้อมผลงานการวิเคราะห์ที่ตรวจสอบย้อนหลังได้',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body className="min-h-screen bg-slate-50 text-slate-900 antialiased">
        {children}
        <footer className="mx-auto max-w-5xl px-4 py-8 text-xs text-slate-500">
          บทวิเคราะห์จัดทำขึ้นเพื่อข้อมูลและความบันเทิง ไม่ใช่คำแนะนำในการเล่นพนัน และไม่มีโมเดลใดรับประกันผลการแข่งขันได้
        </footer>
      </body>
    </html>
  );
}

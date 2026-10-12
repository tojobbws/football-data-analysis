import type { Metadata } from 'next';
import Link from 'next/link';
import { PreviewGrid } from '@/components/home';
import { Empty, Section } from '@/components/ui';
import { previewCards } from '@/lib/queries';
import { db } from '@/lib/supabase';
import { dayTH } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'บทวิเคราะห์ฟุตบอล',
  description: 'วิเคราะห์บอลทุกคู่ก่อนเตะ จาก Data, Model และ Market — ฟอร์ม xG ตัวเจ็บ และโอกาสของจำนวนประตู',
};

/** Every match's written preview (upcoming first, then recent), and editorial articles when there are some. */
export default async function AnalysisList() {
  const [upcoming, recent, articles] = await Promise.all([
    previewCards('upcoming', 24),
    previewCards('recent', 12),
    // anon can only read PUBLISHED articles (RLS)
    db()
      .from('articles')
      .select('slug, title, description, published_at, category:article_categories(name)')
      .eq('status', 'PUBLISHED')
      .order('published_at', { ascending: false })
      .limit(50),
  ]);
  const rows = (articles.data ?? []) as unknown as Array<{ slug: string; title: string; description: string | null; published_at: string; category: { name: string } | null }>;
  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-6">
      <header>
        <h1 className="text-2xl font-bold">บทวิเคราะห์ฟุตบอล</h1>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">ทุกคู่ในลีกที่เราติดตามมีบทวิเคราะห์ก่อนเตะ เขียนจากข้อมูลจริงและบันทึกไว้ก่อนเตะเสมอ</p>
      </header>

      <Section title="คู่ที่กำลังจะเตะ">
        {upcoming.length ? <PreviewGrid previews={upcoming} /> : <Empty>บทวิเคราะห์จะเผยแพร่ภายใน 48 ชม. ก่อนเตะ</Empty>}
      </Section>

      {recent.length ? (
        <Section title="ย้อนหลัง">
          <PreviewGrid previews={recent} />
        </Section>
      ) : null}

      {rows.length ? (
        <Section title="บทความ">
          <ul className="space-y-3">
            {rows.map((a) => (
              <li key={a.slug}>
                <Link href={`/analysis/${a.slug}`} className="block rounded-2xl border border-slate-200 bg-white p-4 hover:border-slate-300">
                  <p className="text-xs text-slate-500">
                    {a.category?.name ?? 'บทความ'} · {dayTH(a.published_at)}
                  </p>
                  <p className="mt-1 font-semibold">{a.title}</p>
                  {a.description ? <p className="mt-1 text-sm text-slate-600">{a.description}</p> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </main>
  );
}

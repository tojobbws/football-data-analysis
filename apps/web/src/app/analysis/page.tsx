import type { Metadata } from 'next';
import Link from 'next/link';
import { Empty } from '@/components/ui';
import { db } from '@/lib/supabase';
import { dayTH } from '@/lib/time';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'บทวิเคราะห์ฟุตบอล', description: 'บทวิเคราะห์ฟุตบอลจาก Data, Model และ Market' };

export default async function AnalysisList() {
  // anon can only read PUBLISHED articles (RLS)
  const { data } = await db()
    .from('articles')
    .select('slug, title, description, published_at, category:article_categories(name)')
    .eq('status', 'PUBLISHED')
    .order('published_at', { ascending: false })
    .limit(50);
  const rows = (data ?? []) as unknown as Array<{ slug: string; title: string; description: string | null; published_at: string; category: { name: string } | null }>;
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-6">
      <h1 className="text-2xl font-bold">🔎 บทวิเคราะห์</h1>
      {rows.length ? (
        <ul className="space-y-3">
          {rows.map((a) => (
            <li key={a.slug}>
              <Link href={`/analysis/${a.slug}`} className="block rounded-2xl border border-slate-200 bg-white p-4 hover:border-slate-300">
                <p className="text-xs text-slate-500">
                  {a.category?.name ?? 'บทวิเคราะห์'} · {dayTH(a.published_at)}
                </p>
                <p className="mt-1 font-semibold">{a.title}</p>
                {a.description ? <p className="mt-1 text-sm text-slate-600">{a.description}</p> : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>ยังไม่มีบทวิเคราะห์ที่เผยแพร่</Empty>
      )}
    </main>
  );
}

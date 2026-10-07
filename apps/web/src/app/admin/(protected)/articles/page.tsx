import Link from 'next/link';
import { Empty, Section } from '@/components/ui';
import { authClient } from '@/lib/auth';
import { dateTimeTH } from '@/lib/time';

export default async function AdminArticles() {
  const sb = await authClient();
  const { data, error } = await sb
    .from('articles')
    .select('id, slug, title, status, published_at, updated_at, category:article_categories(name)')
    .order('updated_at', { ascending: false })
    .limit(200);
  const rows = (data ?? []) as unknown as Array<{ id: number; slug: string; title: string; status: string; published_at: string | null; updated_at: string; category: { name: string } | null }>;
  return (
    <Section
      title="📝 บทความ"
      aside={
        <Link href="/admin/articles/new" className="rounded-full bg-[var(--color-ink)] px-3 py-1 text-xs text-white">
          + เขียนบทความ
        </Link>
      }
    >
      {error ? <p className="mb-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700">{error.message}</p> : null}
      {rows.length ? (
        <ul className="divide-y divide-slate-100 text-sm">
          {rows.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <Link href={`/admin/articles/${a.id}`} className="font-medium hover:underline">
                  {a.title}
                </Link>
                <p className="truncate text-xs text-slate-500">
                  /analysis/{a.slug} · {a.category?.name ?? 'ไม่มีหมวด'} · แก้ไข {dateTimeTH(a.updated_at)}
                </p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${a.status === 'PUBLISHED' ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>{a.status}</span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>ยังไม่มีบทความ</Empty>
      )}
    </Section>
  );
}

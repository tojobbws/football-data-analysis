import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Section } from '@/components/ui';
import { authClient, currentAdmin } from '@/lib/auth';
import { deleteArticle } from '../actions';
import { ArticleForm } from '../article-form';

export default async function EditArticle({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const [{ id }, { saved }] = await Promise.all([params, searchParams]);
  const sb = await authClient();
  const [article, cats, admin] = await Promise.all([
    sb.from('articles').select('id, slug, title, description, body_md, status, category_id, fixture:fixtures(slug)').eq('id', Number(id)).maybeSingle(),
    sb.from('article_categories').select('id, name').order('id'),
    currentAdmin(),
  ]);
  if (!article.data) notFound();
  const a = article.data as unknown as {
    id: number;
    slug: string;
    title: string;
    description: string | null;
    body_md: string;
    status: string;
    category_id: number | null;
    fixture: { slug: string } | null;
  };
  return (
    <Section
      title="แก้ไขบทความ"
      aside={
        a.status === 'PUBLISHED' ? (
          <Link href={`/analysis/${a.slug}`} className="text-[var(--color-pitch)] hover:underline">
            ดูหน้าเว็บ →
          </Link>
        ) : (
          'ยังไม่แสดงบนเว็บ'
        )
      }
    >
      {saved ? <p className="mb-4 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">บันทึกแล้ว</p> : null}
      <ArticleForm article={{ ...a, fixture_slug: a.fixture?.slug ?? null }} categories={(cats.data ?? []) as Array<{ id: number; name: string }>} />
      {admin?.role === 'ADMIN' ? (
        <form action={deleteArticle} className="mt-8 border-t border-slate-100 pt-4">
          <input type="hidden" name="id" value={a.id} />
          <button className="text-sm text-rose-600 hover:underline">ลบบทความนี้</button>
        </form>
      ) : null}
    </Section>
  );
}

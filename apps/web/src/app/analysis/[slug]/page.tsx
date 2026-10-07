import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TextLink } from '@/components/ui';
import { renderMarkdown } from '@/lib/markdown';
import { db } from '@/lib/supabase';
import { dateTimeTH } from '@/lib/time';

export const dynamic = 'force-dynamic';

async function load(slug: string) {
  const { data } = await db()
    .from('articles')
    .select('slug, title, description, body_md, og_image_url, published_at, updated_at, category:article_categories(name), fixture:fixtures(slug)')
    .eq('slug', slug)
    .eq('status', 'PUBLISHED')
    .maybeSingle();
  return data as unknown as {
    slug: string;
    title: string;
    description: string | null;
    body_md: string;
    og_image_url: string | null;
    published_at: string;
    updated_at: string;
    category: { name: string } | null;
    fixture: { slug: string } | null;
  } | null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const a = await load((await params).slug);
  if (!a) return { title: 'ไม่พบบทความ' };
  return {
    title: a.title,
    description: a.description ?? undefined,
    alternates: { canonical: `/analysis/${a.slug}` },
    openGraph: { title: a.title, description: a.description ?? undefined, type: 'article', images: a.og_image_url ? [a.og_image_url] : undefined },
  };
}

export default async function ArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const a = await load((await params).slug);
  if (!a) notFound();
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.description ?? undefined,
    datePublished: a.published_at,
    dateModified: a.updated_at,
    image: a.og_image_url ?? undefined,
  };
  return (
    <main className="mx-auto max-w-3xl px-4 py-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <article className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-8">
        <p className="text-xs text-slate-500">
          {a.category?.name ?? 'บทวิเคราะห์'} · เผยแพร่ {dateTimeTH(a.published_at)}
        </p>
        <h1 className="mt-2 text-2xl font-bold leading-snug sm:text-3xl">{a.title}</h1>
        {a.description ? <p className="mt-2 text-slate-600">{a.description}</p> : null}
        <div
          className="mt-6 space-y-4 leading-relaxed [&_a]:text-[var(--color-pitch)] [&_a]:underline [&_blockquote]:border-l-4 [&_blockquote]:border-slate-200 [&_blockquote]:pl-4 [&_h2]:mt-6 [&_h2]:text-xl [&_h2]:font-bold [&_h3]:font-semibold [&_img]:rounded-xl [&_li]:ml-5 [&_ol]:list-decimal [&_table]:w-full [&_td]:border-b [&_td]:py-1 [&_ul]:list-disc"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(a.body_md) }}
        />
        {a.fixture ? (
          <p className="mt-6 text-sm">
            ดูข้อมูลแมตช์และ 🧭 เข็มทิศเกม: <TextLink href={`/matches/${a.fixture.slug}`}>หน้าแมตช์ →</TextLink>
          </p>
        ) : null}
        <p className="mt-8 border-t border-slate-100 pt-4 text-xs text-slate-500">
          บทวิเคราะห์จัดทำขึ้นเพื่อข้อมูลและความบันเทิง ไม่ใช่คำแนะนำในการเล่นพนัน และไม่มีโมเดลใดรับประกันผลการแข่งขันได้
        </p>
      </article>
    </main>
  );
}

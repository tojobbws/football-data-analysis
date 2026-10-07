import { Section } from '@/components/ui';
import { authClient } from '@/lib/auth';
import { ArticleForm } from '../article-form';

export default async function NewArticle() {
  const sb = await authClient();
  const { data } = await sb.from('article_categories').select('id, name').order('id');
  return (
    <Section title="เขียนบทความใหม่">
      <ArticleForm article={{}} categories={(data ?? []) as Array<{ id: number; name: string }>} />
    </Section>
  );
}

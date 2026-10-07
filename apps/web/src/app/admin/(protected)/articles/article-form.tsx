'use client';

import { useActionState } from 'react';
import { saveArticle } from './actions';

export interface ArticleInput {
  id?: number;
  title?: string;
  slug?: string;
  description?: string | null;
  body_md?: string;
  status?: string;
  category_id?: number | null;
  fixture_slug?: string | null;
}

const input = 'mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm';

export function ArticleForm({ article, categories }: { article: ArticleInput; categories: Array<{ id: number; name: string }> }) {
  const [state, action, pending] = useActionState(saveArticle, undefined);
  return (
    <form action={action} className="space-y-4">
      {article.id ? <input type="hidden" name="id" value={article.id} /> : null}
      <label className="block text-sm">
        หัวข้อ
        <input name="title" defaultValue={article.title} required className={input} />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm">
          slug (URL: /analysis/…)
          <input name="slug" defaultValue={article.slug} required pattern="[a-z0-9]+(-[a-z0-9]+)*" className={`${input} font-mono`} />
        </label>
        <label className="block text-sm">
          หมวด
          <select name="category_id" defaultValue={article.category_id ?? ''} className={input}>
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          ผูกกับแมตช์ (slug, ไม่บังคับ)
          <input name="fixture_slug" defaultValue={article.fixture_slug ?? ''} placeholder="liverpool-vs-arsenal-2026-10-10" className={`${input} font-mono`} />
        </label>
        <label className="block text-sm">
          สถานะ
          <select name="status" defaultValue={article.status ?? 'DRAFT'} className={input}>
            <option value="DRAFT">DRAFT (ยังไม่เผยแพร่)</option>
            <option value="PUBLISHED">PUBLISHED (เผยแพร่)</option>
            <option value="ARCHIVED">ARCHIVED (เก็บถาวร)</option>
          </select>
        </label>
      </div>
      <label className="block text-sm">
        คำอธิบายสั้น (meta description)
        <input name="description" defaultValue={article.description ?? ''} maxLength={300} className={input} />
      </label>
      <label className="block text-sm">
        เนื้อหา (Markdown)
        <textarea name="body_md" defaultValue={article.body_md} required rows={18} className={`${input} font-mono leading-relaxed`} />
      </label>
      <p className="text-xs text-slate-500">ห้ามใช้คำ: ทีเด็ด, แทง, แทงบอล, กำไร, ตามคู่นี้, การันตีถูก · disclaimer จะแสดงท้ายบทความให้อัตโนมัติ</p>
      {state?.error ? <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.error}</p> : null}
      <button disabled={pending} className="rounded-lg bg-[var(--color-ink)] px-5 py-2 text-sm font-semibold text-white disabled:opacity-60">
        {pending ? 'กำลังบันทึก…' : 'บันทึก'}
      </button>
    </form>
  );
}

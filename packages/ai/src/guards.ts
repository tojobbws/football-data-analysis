/**
 * Validation of the AI answer. The AI may only reason over the input:
 *  - candidate indices must exist, the top pick must be one of them
 *  - every number in Thai text must come from the input (no invented probabilities / odds / xG)
 *  - banned gambling words are rejected
 * A violation never crashes the job: the row is stored as INVALID with the reasons, so the
 * measurement stays complete and the problem is visible.
 */
import { z } from 'zod';
import type { ShadowCandidate } from './input.js';

export const BANNED_WORDS = ['ทีเด็ด', 'แทงบอล', 'แทง', 'กำไร', 'ตามคู่นี้', 'การันตี'] as const;

export const aiOutputSchema = z.object({
  data_issues: z.array(z.string()),
  conflicts_th: z.array(z.string()),
  ranking: z.array(z.object({ candidate_index: z.number().int(), support: z.enum(['HIGH', 'MEDIUM', 'LOW']), reason_th: z.string() })),
  no_clear_signal: z.boolean(),
  top_pick_index: z.number().int(),
  explanation_th: z.string(),
});
export type AiOutput = z.infer<typeof aiOutputSchema>;

export interface ValidatedShadow {
  ok: boolean;
  violations: string[];
  ranking: Array<{ market: string; selection: string; line: number | null; label: string; support: string; reason_th: string }>;
  noClearSignal: boolean;
  pick: ShadowCandidate | null;
  explanation: string;
}

export function validateShadowOutput(raw: unknown, input: Record<string, unknown>, candidates: readonly ShadowCandidate[]): ValidatedShadow {
  const violations: string[] = [];
  const parsed = aiOutputSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, violations: [`schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`], ranking: [], noClearSignal: true, pick: null, explanation: '' };
  }
  const out = parsed.data;

  const seen = new Set<number>();
  const ranking: ValidatedShadow['ranking'] = [];
  for (const r of out.ranking) {
    const c = candidates[r.candidate_index];
    if (!c) {
      violations.push(`ranking: unknown candidate index ${r.candidate_index}`);
      continue;
    }
    if (seen.has(r.candidate_index)) {
      violations.push(`ranking: duplicate candidate index ${r.candidate_index}`);
      continue;
    }
    seen.add(r.candidate_index);
    ranking.push({ market: c.market, selection: c.selection, line: c.line, label: c.label, support: r.support, reason_th: r.reason_th });
  }

  let pick: ShadowCandidate | null = null;
  if (!out.no_clear_signal) {
    pick = candidates[out.top_pick_index] ?? null;
    if (!pick) violations.push(`top_pick_index ${out.top_pick_index} is not a candidate`);
    else if (!seen.has(out.top_pick_index)) violations.push(`top pick ${out.top_pick_index} is missing from the ranking`);
  }

  const texts = [out.explanation_th, ...out.conflicts_th, ...out.ranking.map((r) => r.reason_th)];
  for (const t of texts) {
    for (const w of BANNED_WORDS) if (t.includes(w)) violations.push(`banned word "${w}"`);
  }
  const allowed = allowedNumbers(input);
  for (const t of texts) for (const n of inventedNumbers(t, allowed)) violations.push(`number not in input: ${n}`);

  return { ok: violations.length === 0, violations: [...new Set(violations)], ranking, noClearSignal: out.no_clear_signal, pick, explanation: out.explanation_th };
}

/** Every numeric value in the input (recursively), plus candidate labels' numbers. */
export function allowedNumbers(input: unknown): number[] {
  const out: number[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
    else if (typeof v === 'string') for (const m of v.matchAll(NUM)) out.push(Number(m[0].replace(',', '')));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(input);
  // array lengths ("5 นัด", "2 ตัวหลัก") are facts of the input too
  const lengths = (v: unknown): void => {
    if (Array.isArray(v)) {
      out.push(v.length);
      v.forEach(lengths);
    } else if (v && typeof v === 'object') Object.values(v).forEach(lengths);
  };
  lengths(input);
  return out;
}

const NUM = /\d+(?:[.,]\d+)?/g;

/**
 * Numbers in `text` that cannot be traced to the input. Matching is tolerant to rounding:
 *  - "63%" matches 0.634 (probability shown as a whole/1-decimal percent) or 63.4
 *  - "1.95" matches 1.95; "-0.75"/"+0.75" match 0.75 (signs are ignored)
 * Integers 0-3 are always allowed ("2 ทีม", "1 ประตู", "0-0").
 */
export function inventedNumbers(text: string, allowed: readonly number[]): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(/(\d+(?:[.,]\d+)?)(\s*%)?/g)) {
    const raw = m[1]!;
    const n = Number(raw.replace(',', '.'));
    const pct = Boolean(m[2]);
    if (!pct && Number.isInteger(n) && n <= 3) continue;
    const ok = allowed.some((a) => {
      const x = Math.abs(a);
      if (pct) return Math.abs(x * 100 - n) <= 0.51 || Math.abs(x - n) <= 0.51;
      const decimals = raw.split(/[.,]/)[1]?.length ?? 0;
      const tol = 0.5 * 10 ** -decimals + 1e-9;
      return Math.abs(x - n) <= tol;
    });
    if (!ok) bad.push(raw + (pct ? '%' : ''));
  }
  return bad;
}

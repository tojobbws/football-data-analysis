/**
 * 🔎 Match report: everything the system knows about upcoming fixtures, in one readable
 * Markdown file (reports/matches-<date>.md). Read-only — publishes nothing.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { consensus, DEFAULT_RULES, DIXON_COLES_VERSION, ELO_VERSION, IMPACT_VERSION, REASON_TH, selectionLabel } from '@fp/analysis';
import type { JobContext } from '@fp/database';
import { addHours } from '@fp/shared';

const pct = (x: number | null | undefined) => (x == null ? '-' : `${(x * 100).toFixed(1)}%`);
const th = (d: Date) => d.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });

export async function matchReport(ctx: JobContext, opts: { hours?: number; now?: Date } = {}): Promise<{ path: string; markdown: string; fixtures: number }> {
  const now = opts.now ?? new Date();
  const fixtures = await ctx.repo.fixturesForCandidates(ctx.env.TRACKED_LEAGUES, new Date(now.getTime() - 3_600_000).toISOString(), addHours(now, opts.hours ?? 18).toISOString());
  const out: string[] = [`# 🔎 วิเคราะห์เกม — สร้างเมื่อ ${th(now)}`, '', `จำนวนคู่: ${fixtures.length}`, ''];

  for (const f of fixtures) {
    const h = (await ctx.repo.fixtureHeader(f.id))!;
    const probs = await ctx.repo.latestProbabilities(f.id, DIXON_COLES_VERSION);
    const dc = (s: string) => probs.find((p) => p.modelVersionId === DIXON_COLES_VERSION && p.market === 'MATCH_WINNER' && p.selection === s)?.probability;
    const elo = (s: string) => probs.find((p) => p.modelVersionId === ELO_VERSION && p.selection === s)?.probability;
    const dcIn = probs.find((p) => p.modelVersionId === DIXON_COLES_VERSION && p.inputs && 'lambda' in p.inputs)?.inputs as
      | { lambda: number; mu: number; home?: { weightedMatches?: number }; away?: { weightedMatches?: number } }
      | undefined;
    const quotes = await ctx.repo.latestQuotes(f.id);
    const cons = consensus(quotes, now, 24);
    const mkt = (s: string) => cons.find((c) => c.market === 'MATCH_WINNER' && c.selection === s);
    const [formH, formA, inj, api, run, cfg] = await Promise.all([
      ctx.repo.teamForm(h.homeTeamId, h.kickoffAt),
      ctx.repo.teamForm(h.awayTeamId, h.kickoffAt),
      ctx.repo.injuriesDetailed(f.id),
      ctx.repo.latestApiPrediction(f.id),
      ctx.repo.latestRun(f.id, DEFAULT_RULES.version),
      ctx.repo.latestModelConfigs(h.leagueId),
    ]);
    const impact = (await ctx.repo.latestProbabilities(f.id, IMPACT_VERSION)).find((r) => r.inputs && 'impact' in r.inputs)?.inputs?.impact as
      | { home: { attackLoss: number; defenceLoss: number; missing: Array<{ name: string | null }> }; away: { attackLoss: number; defenceLoss: number; missing: Array<{ name: string | null }> }; enabled: boolean }
      | undefined;

    const form = (rows: typeof formH) => rows.map((r) => r.result).join('') || '-';
    const gf = (rows: typeof formH) => (rows.length ? (rows.reduce((s, r) => s + r.goalsFor, 0) / rows.length).toFixed(1) : '-');
    const ga = (rows: typeof formH) => (rows.length ? (rows.reduce((s, r) => s + r.goalsAgainst, 0) / rows.length).toFixed(1) : '-');

    out.push(`## ${h.home} vs ${h.away}`, `${h.league} · ${th(h.kickoffAt)}`, '');
    out.push('| | ' + h.home + ' | เสมอ | ' + h.away + ' |', '|---|---|---|---|');
    out.push(`| Dixon-Coles | ${pct(dc('HOME'))} | ${pct(dc('DRAW'))} | ${pct(dc('AWAY'))} |`);
    out.push(`| Elo | ${pct(elo('HOME'))} | ${pct(elo('DRAW'))} | ${pct(elo('AWAY'))} |`);
    out.push(`| ตลาด (no-vig, ${mkt('HOME')?.nBookmakers ?? 0} เจ้า) | ${pct(mkt('HOME')?.marketProbability)} | ${pct(mkt('DRAW')?.marketProbability)} | ${pct(mkt('AWAY')?.marketProbability)} |`);
    if (api) out.push(`| API-Football | ${api.percent_home ?? '-'}% | ${api.percent_draw ?? '-'}% | ${api.percent_away ?? '-'}% |`);
    out.push('');
    if (dcIn) out.push(`- ประตูคาดหมายจากโมเดล: ${h.home} ${dcIn.lambda.toFixed(2)} – ${dcIn.mu.toFixed(2)} ${h.away}`);
    out.push(`- ฟอร์ม 5 นัด: ${h.home} **${form(formH)}** (ยิง ${gf(formH)} / เสีย ${ga(formH)} ต่อนัด) · ${h.away} **${form(formA)}** (ยิง ${gf(formA)} / เสีย ${ga(formA)})`);
    out.push(`- ข้อมูลในโมเดล (น้ำหนักนัด): ${h.home} ${dcIn?.home?.weightedMatches ?? '-'} · ${h.away} ${dcIn?.away?.weightedMatches ?? '-'}`);
    if (inj.length) out.push(`- 🩹 รายชื่อเจ็บ/แบน: ${inj.map((i) => `${i.player_name} (${i.type})`).join(', ')}`);
    if (impact) {
      const line = (t: string, s: typeof impact.home) => `${t} รุก −${Math.round(s.attackLoss * 100)}% / รับ −${Math.round(s.defenceLoss * 100)}%`;
      out.push(`- ผลกระทบผู้เล่นขาด: ${line(h.home, impact.home)} · ${line(h.away, impact.away)}${impact.enabled ? '' : ' (ยังไม่ผ่านการทดสอบ — ใช้เป็นข้อมูลเท่านั้น)'}`);
    }
    const gates = `1X2 ${cfg.ENSEMBLE?.enabled ? 'ON' : 'off'} · AH ${cfg.SIDES?.enabled ? 'ON' : 'off'} · O/U ${cfg.TOTALS?.enabled ? 'ON' : 'off'}`;
    out.push(`- ความน่าเชื่อถือของโมเดลในลีกนี้: ${gates}`);

    if (run) {
      const cands = await ctx.repo.runCandidates(run.id);
      const pick = cands.find((c) => c.rank === 1);
      if (run.outcome === 'SIGNAL' && pick) {
        out.push(`- **🧭 เข็มทิศเกม: ${selectionLabel(pick.market, pick.selection, pick.line, h.home, h.away)}** — โมเดล ${pct(pick.modelProbability)} vs ตลาด ${pct(pick.marketProbability)} @ ${pick.odds}`);
      } else {
        const reasons = Object.entries((run.summary.rejectReasons ?? {}) as Record<string, number>)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([k]) => REASON_TH[k] ?? k);
        out.push(`- **🌫️ หมอกข้อมูล** — ${reasons.join(' / ') || 'ไม่มีตลาดใดผ่านเกณฑ์'}`);
      }
      const top = cands.filter((c) => c.edge != null).sort((a, b) => (b.edge ?? 0) - (a.edge ?? 0)).slice(0, 3);
      if (top.length)
        out.push(`- มุมที่โมเดลมองต่างจากตลาดมากที่สุด (ข้อมูล ไม่ใช่สัญญาณ): ${top.map((c) => `${selectionLabel(c.market, c.selection, c.line, h.home, h.away)} ${c.edge! > 0 ? '+' : ''}${(c.edge! * 100).toFixed(1)} จุด`).join(' · ')}`);
    } else {
      out.push('- ยังไม่มีการตัดสินจาก Candidate Generator (รัน model:candidates)');
    }
    out.push('');
  }
  out.push('---', '_บทวิเคราะห์จัดทำขึ้นเพื่อข้อมูลและความบันเทิง ไม่ใช่คำแนะนำในการเล่นพนัน และไม่มีโมเดลใดรับประกันผลการแข่งขันได้_');

  const markdown = out.join('\n');
  const dir = fileURLToPath(new URL('../../../reports/', import.meta.url));
  await mkdir(dir, { recursive: true });
  const path = `${dir}matches-${now.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.md`;
  await writeFile(path, markdown, 'utf8');
  return { path, markdown, fixtures: fixtures.length };
}

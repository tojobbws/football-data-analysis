import Link from 'next/link';
import { Empty, Section, StatusBadge } from '@/components/ui';
import { authClient } from '@/lib/auth';
import { pct, selectionLabel, type Status } from '@/lib/labels';
import { dateTimeTH } from '@/lib/time';

interface Shadow {
  status: 'OK' | 'INVALID' | 'REFUSED';
  model: string;
  no_clear_signal: boolean | null;
  pick_market: string | null;
  pick_selection: string | null;
  pick_line: number | null;
  agrees_with_rules: boolean | null;
  explanation_th: string | null;
  guard_violations: string[];
  ai_status: Status | null;
}

/** Published 🧭 (rules) next to the AI shadow ranking of the same snapshot — internal only. */
export default async function AdminAnalyses() {
  const sb = await authClient();
  const [rows, comparison] = await Promise.all([
    sb
      .from('analysis_predictions')
      .select(
        `id, public_id, publish_round, kind, market, selection, line, odds_at_publish, model_probability, signal_strength, status, result_score, published_at,
         fixture:fixtures!analysis_predictions_fixture_id_fkey(slug, kickoff_at, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name)),
         ai:ai_shadow_rankings(status, model, no_clear_signal, pick_market, pick_selection, pick_line, agrees_with_rules, explanation_th, guard_violations, ai_status)`,
      )
      .order('published_at', { ascending: false })
      .limit(100),
    sb.from('ai_shadow_comparison').select('*'),
  ]);
  const err = rows.error ?? comparison.error;
  const list = (rows.data ?? []) as unknown as Array<{
    id: number;
    public_id: string;
    publish_round: string;
    kind: string;
    market: string | null;
    selection: string | null;
    line: number | null;
    model_probability: number | null;
    signal_strength: string | null;
    status: Status;
    result_score: string | null;
    published_at: string;
    fixture: { slug: string; kickoff_at: string; home: { name: string }; away: { name: string } };
    ai: Shadow | Shadow[] | null;
  }>;

  return (
    <main className="space-y-5">
      {err ? <p className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">โหลดข้อมูลไม่สำเร็จ: {err.message}</p> : null}
      <Section title="กฎ vs AI (เฉพาะคู่ที่ AI ตอบผ่าน guard)" aside="ต้องการ 500–1,000 คู่ก่อนสรุป">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500">
              <th className="pb-2 text-left font-normal">ผู้เลือก</th>
              <th className="pb-2 font-normal">คู่ที่เทียบ</th>
              <th className="pb-2 font-normal">สัญญาณ</th>
              <th className="pb-2 font-normal">W / ½W</th>
              <th className="pb-2 font-normal">L / ½L</th>
              <th className="pb-2 font-normal">รอผล</th>
              <th className="pb-2 font-normal">Win rate</th>
              <th className="pb-2 font-normal">เห็นตรงกัน</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-center tabular-nums">
            {(comparison.data ?? []).map((c) => (
              <tr key={c.source}>
                <td className="py-1.5 text-left">{c.source === 'AI' ? '🤖 AI shadow' : '📏 กฎ (เผยแพร่จริง)'}</td>
                <td>{c.fixtures_compared}</td>
                <td>{c.signals}</td>
                <td>
                  {c.win} / {c.half_win}
                </td>
                <td>
                  {c.loss} / {c.half_loss}
                </td>
                <td>{c.pending}</td>
                <td className="font-semibold">{pct(c.win_rate == null ? null : Number(c.win_rate), 1)}</td>
                <td>{pct(c.agreement_rate == null ? null : Number(c.agreement_rate), 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      <Section title="บทวิเคราะห์ที่เผยแพร่ล่าสุด">
        {list.length ? (
          <ul className="divide-y divide-slate-100">
            {list.map((r) => {
              const ai = Array.isArray(r.ai) ? r.ai[0] : r.ai;
              const h = r.fixture.home.name;
              const a = r.fixture.away.name;
              return (
                <li key={r.id} className="grid gap-3 py-3 md:grid-cols-2">
                  <div>
                    <Link href={`/matches/${r.fixture.slug}`} className="font-medium hover:underline">
                      {h} vs {a}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {r.public_id} · {r.publish_round} · เผยแพร่ {dateTimeTH(r.published_at)} · เตะ {dateTimeTH(r.fixture.kickoff_at)}
                    </p>
                    <p className="mt-1 text-sm">
                      📏 {r.kind === 'SIGNAL' ? `🧭 ${selectionLabel(r.market!, r.selection!, r.line == null ? null : Number(r.line), h, a)} · ${r.signal_strength} · ${pct(r.model_probability)}` : '🌫️ หมอกข้อมูล'}{' '}
                      <StatusBadge admin status={r.status} /> {r.result_score ?? ''}
                    </p>
                  </div>
                  <div className="rounded-xl bg-slate-50 p-3 text-sm">
                    {ai ? (
                      <>
                        <p>
                          🤖{' '}
                          {ai.status !== 'OK' ? (
                            <span className="text-rose-600">{ai.status}</span>
                          ) : ai.no_clear_signal ? (
                            '🌫️'
                          ) : (
                            selectionLabel(ai.pick_market!, ai.pick_selection!, ai.pick_line == null ? null : Number(ai.pick_line), h, a)
                          )}{' '}
                          {ai.agrees_with_rules === true ? <span className="text-xs text-emerald-700">🤝 ตรงกับกฎ</span> : ai.agrees_with_rules === false ? <span className="text-xs text-amber-700">เห็นต่าง</span> : null}{' '}
                          {ai.ai_status ? <StatusBadge admin status={ai.ai_status} /> : null}
                        </p>
                        {ai.explanation_th ? <p className="mt-1 text-xs leading-relaxed text-slate-600">{ai.explanation_th}</p> : null}
                        {ai.guard_violations?.length ? <p className="mt-1 text-xs text-rose-600">guard: {ai.guard_violations.join(' · ')}</p> : null}
                        <p className="mt-1 text-[10px] text-slate-400">{ai.model}</p>
                      </>
                    ) : (
                      <span className="text-xs text-slate-400">ยังไม่มี AI shadow (ต้องมี ANTHROPIC_API_KEY และรันก่อนเตะ)</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <Empty>ยังไม่มีบทวิเคราะห์ที่เผยแพร่</Empty>
        )}
      </Section>
    </main>
  );
}

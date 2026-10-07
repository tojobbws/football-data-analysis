import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CompassCard } from '@/components/compass-card';
import { Empty, FormPills, Section, TeamLogo, TextLink } from '@/components/ui';
import { FINISHED, LIVE, odds, selectionLabel } from '@/lib/labels';
import { matchBySlug, type FormRow } from '@/lib/queries';
import { dateTimeTH, dayTH, shortDayTH, timeTH } from '@/lib/time';

export const dynamic = 'force-dynamic';

type Data = NonNullable<Awaited<ReturnType<typeof matchBySlug>>>;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const d = await matchBySlug(slug);
  if (!d) return { title: 'ไม่พบแมตช์' };
  const { home, away, league, kickoff_at } = d.match;
  return {
    title: `${home.name} vs ${away.name} วิเคราะห์บอล ${league.name}`,
    description: `วิเคราะห์ ${home.name} vs ${away.name} (${league.name}) ${dayTH(kickoff_at)} — ฟอร์ม, xG, ตัวเจ็บ, แรงตลาด และ 🧭 เข็มทิศเกม`,
    alternates: { canonical: `/matches/${slug}` },
  };
}

export default async function MatchPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const d = await matchBySlug(slug);
  if (!d) notFound();
  const { match: m } = d;
  const latest = d.rounds.at(-1) ?? null;
  const earlier = d.rounds.slice(0, -1);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: `${m.home.name} vs ${m.away.name}`,
    startDate: m.kickoff_at,
    sport: 'Soccer',
    homeTeam: { '@type': 'SportsTeam', name: m.home.name },
    awayTeam: { '@type': 'SportsTeam', name: m.away.name },
    location: m.venue?.name ? { '@type': 'Place', name: m.venue.name, address: m.venue.city ?? undefined } : undefined,
    superEvent: { '@type': 'SportsEvent', name: m.league.name },
  };

  return (
    <main className="mx-auto max-w-5xl space-y-5 px-4 py-6">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Header d={d} />

      {latest ? (
        <div className="space-y-2">
          <CompassCard c={latest} home={m.home.name} away={m.away.name} />
          {earlier.map((c) => (
            <details key={c.public_id} className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm">
              <summary className="cursor-pointer text-slate-600">บทวิเคราะห์รอบก่อนหน้า ({c.public_id}) — ยังอยู่ใน track record</summary>
              <div className="mt-3">
                <CompassCard c={c} home={m.home.name} away={m.away.name} />
              </div>
            </details>
          ))}
        </div>
      ) : (
        <Section title="🧭 เข็มทิศเกม">
          <Empty>{FINISHED.includes(m.status_short) ? 'แมตช์นี้ไม่มีบทวิเคราะห์ที่เผยแพร่' : 'บทวิเคราะห์จะเผยแพร่ภายใน 24 ชม. ก่อนเตะ'}</Empty>
        </Section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <MarketSection d={d} />
        <FormSection d={d} />
      </div>

      {d.finished && d.stats.length ? <StatsSection d={d} /> : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <InjurySection d={d} />
        <LineupSection d={d} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <StandingsSection d={d} />
        <H2HSection d={d} />
      </div>
    </main>
  );
}

function Header({ d }: { d: Data }) {
  const m = d.match;
  const live = LIVE.includes(m.status_short);
  const showScore = d.finished || live;
  return (
    <section className="rounded-3xl border border-slate-200 bg-white px-5 py-6">
      <p className="text-center text-xs text-slate-500">
        {m.league.name}
        {m.round ? ` · ${m.round}` : ''} · {dayTH(m.kickoff_at)} {timeTH(m.kickoff_at)}
        {m.venue?.name ? ` · ${m.venue.name}` : ''}
      </p>
      <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
        <Team t={m.home} />
        <div className="text-center">
          {showScore ? (
            <>
              <p className="text-4xl font-bold tabular-nums">
                {m.goals_home} – {m.goals_away}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                {live ? <span className="font-semibold text-rose-600">{m.elapsed}′ LIVE</span> : 'จบการแข่งขัน'}
                {m.ht_home != null ? ` · HT ${m.ht_home}-${m.ht_away}` : ''}
              </p>
            </>
          ) : (
            <p className="text-2xl font-semibold tabular-nums">{['PST', 'CANC', 'ABD'].includes(m.status_short) ? m.status_short : timeTH(m.kickoff_at)}</p>
          )}
        </div>
        <Team t={m.away} />
      </div>
    </section>
  );
}

function Team({ t }: { t: Data['match']['home'] }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <TeamLogo src={t.logo_url} alt={t.name} size={56} />
      <p className="text-sm font-semibold sm:text-base">{t.name}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 📈 Market
// ---------------------------------------------------------------------------

type MarketRow = Data['market'][number];

/**
 * The market's "main" line: where both sides are priced closest to each other.
 * AH: HOME at line L pairs with AWAY at -L. O/U: OVER at L pairs with UNDER at L.
 */
function mainLine(rows: MarketRow[], a: 'HOME' | 'OVER', b: 'AWAY' | 'UNDER'): number | null {
  const pairLine = (l: number) => (a === 'HOME' ? -l || 0 : l);
  let best: { line: number; diff: number } | null = null;
  for (const x of rows.filter((r) => r.selection === a && r.line != null)) {
    const l = Number(x.line);
    const y = rows.find((r) => r.selection === b && r.line != null && Number(r.line) === pairLine(l));
    if (!x.current_odds || !y?.current_odds || x.bookmakers < 2) continue;
    const diff = Math.abs(Number(x.current_odds) - Number(y.current_odds));
    if (!best || diff < best.diff) best = { line: l, diff };
  }
  return best?.line ?? null;
}

function MarketSection({ d }: { d: Data }) {
  const m = d.match;
  const mw = d.market.filter((r) => r.market === 'MATCH_WINNER');
  const ah = d.market.filter((r) => r.market === 'ASIAN_HANDICAP');
  const ou = d.market.filter((r) => r.market === 'OVER_UNDER');
  const ahLine = mainLine(ah, 'HOME', 'AWAY');
  const ouLine = mainLine(ou, 'OVER', 'UNDER');
  const rows: Array<{ label: string; r: MarketRow | undefined }> = [
    ...(['HOME', 'DRAW', 'AWAY'] as const).map((s) => ({ label: selectionLabel('MATCH_WINNER', s, null, m.home.name, m.away.name), r: mw.find((x) => x.selection === s) })),
    ...(ahLine != null
      ? [
          { label: selectionLabel('ASIAN_HANDICAP', 'HOME', ahLine, m.home.name, m.away.name), r: ah.find((x) => x.selection === 'HOME' && Number(x.line) === ahLine) },
          { label: selectionLabel('ASIAN_HANDICAP', 'AWAY', -ahLine || 0, m.home.name, m.away.name), r: ah.find((x) => x.selection === 'AWAY' && Number(x.line) === (-ahLine || 0)) },
        ]
      : []),
    ...(ouLine != null
      ? (['OVER', 'UNDER'] as const).map((s) => ({ label: selectionLabel('OVER_UNDER', s, ouLine, m.home.name, m.away.name), r: ou.find((x) => x.selection === s && Number(x.line) === ouLine) }))
      : []),
  ].filter((x) => x.r);
  const last = d.market.reduce<string | null>((a, r) => (!a || r.last_quote_at > a ? r.last_quote_at : a), null);

  return (
    <Section title="📈 แรงตลาด" aside={last ? `อัปเดต ${dateTimeTH(last)}` : undefined}>
      {rows.length ? (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th className="pb-2 font-normal">ตัวเลือก</th>
                <th className="pb-2 text-right font-normal">ราคาเปิด</th>
                <th className="pb-2 text-right font-normal">ล่าสุด</th>
                <th className="pb-2 text-right font-normal">เจ้า</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ label, r }) => {
                const o = Number(r!.opening_odds);
                const c = Number(r!.current_odds);
                const move = o && c ? (c - o) / o : 0;
                return (
                  <tr key={label}>
                    <td className="py-1.5">{label}</td>
                    <td className="py-1.5 text-right tabular-nums text-slate-500">{odds(r!.opening_odds)}</td>
                    <td className="py-1.5 text-right font-semibold tabular-nums">
                      {odds(r!.current_odds)}
                      {Math.abs(move) >= 0.03 ? <span className={`ml-1 text-xs ${move < 0 ? 'text-emerald-600' : 'text-rose-500'}`}>{move < 0 ? '▼' : '▲'}</span> : null}
                    </td>
                    <td className="py-1.5 text-right text-xs text-slate-400">{r!.bookmakers}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-slate-500">ค่ากลาง (median) ของราคาจากหลายเจ้ามือ ก่อนเตะ · ▼ ราคาลง = ตลาดให้น้ำหนักฝั่งนั้นมากขึ้น</p>
        </>
      ) : (
        <Empty>ยังไม่มีข้อมูลราคาตลาดสำหรับแมตช์นี้</Empty>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Form / xG
// ---------------------------------------------------------------------------

function FormSection({ d }: { d: Data }) {
  const m = d.match;
  return (
    <Section title="ฟอร์ม 5 นัดล่าสุด + xG" aside="ทุกรายการ">
      <div className="space-y-4">
        <FormTeam name={m.home.name} rows={d.form.home} />
        <FormTeam name={m.away.name} rows={d.form.away} />
      </div>
    </Section>
  );
}

function FormTeam({ name, rows }: { name: string; rows: FormRow[] }) {
  const xg = rows.filter((r) => r.xgFor != null);
  const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '–');
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{name}</span>
        <FormPills results={[...rows].reverse().map((r) => r.result)} />
      </div>
      {rows.length ? (
        <>
          <ul className="space-y-0.5 text-xs text-slate-600">
            {rows.map((r) => (
              <li key={r.slug} className="flex justify-between gap-2">
                <span className="truncate">
                  {shortDayTH(r.kickoff_at)} · {r.venue === 'H' ? 'เหย้า' : 'เยือน'} vs {r.opponent}
                </span>
                <span className="shrink-0 tabular-nums">
                  {r.gf}-{r.ga}
                  {r.xgFor != null ? <span className="ml-2 text-slate-400">xG {r.xgFor.toFixed(2)}-{r.xgAgainst?.toFixed(2) ?? '–'}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-slate-500">
            เฉลี่ย xG ได้ {avg(xg.map((r) => r.xgFor!))} · เสีย {avg(xg.filter((r) => r.xgAgainst != null).map((r) => r.xgAgainst!))} ({xg.length} นัดที่มี xG)
          </p>
        </>
      ) : (
        <p className="text-xs text-slate-500">ยังไม่มีข้อมูล</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Match stats (finished)
// ---------------------------------------------------------------------------

const STAT_LABEL: Record<string, string> = {
  expected_goals: 'xG',
  ball_possession: 'ครองบอล',
  total_shots: 'ยิงทั้งหมด',
  shots_on_goal: 'ยิงเข้ากรอบ',
  corner_kicks: 'เตะมุม',
  fouls: 'ฟาวล์',
  yellow_cards: 'ใบเหลือง',
  red_cards: 'ใบแดง',
  passes_pct: 'ผ่านบอลสำเร็จ',
};

function StatsSection({ d }: { d: Data }) {
  const m = d.match;
  const val = (team: number, type: string) => d.stats.find((s) => s.team_id === team && s.type === type);
  const goals = d.events.filter((e) => e.type === 'Goal');
  return (
    <Section title="สถิติหลังเกม">
      <div className="space-y-2">
        {Object.entries(STAT_LABEL).map(([type, label]) => {
          const h = val(m.home.id, type);
          const a = val(m.away.id, type);
          if (!h && !a) return null;
          const hv = Number(h?.value_num ?? 0);
          const av = Number(a?.value_num ?? 0);
          const share = hv + av > 0 ? (hv / (hv + av)) * 100 : 50;
          const show = (x?: { value_num: number | null; value_text: string | null }) => x?.value_text ?? (x?.value_num ?? '–');
          return (
            <div key={type}>
              <div className="flex justify-between text-xs">
                <span className="font-semibold tabular-nums">{show(h)}</span>
                <span className="text-slate-500">{label}</span>
                <span className="font-semibold tabular-nums">{show(a)}</span>
              </div>
              <div className="mt-1 flex h-1.5 overflow-hidden rounded-full bg-slate-200">
                <div className="bg-[var(--color-pitch)]" style={{ width: `${share}%` }} />
              </div>
            </div>
          );
        })}
      </div>
      {goals.length ? (
        <ul className="mt-4 space-y-0.5 border-t border-slate-100 pt-3 text-xs text-slate-600">
          {goals.map((g, i) => (
            <li key={i} className={g.team_id === m.away.id ? 'text-right' : ''}>
              ⚽ {g.elapsed}
              {g.extra ? `+${g.extra}` : ''}′ {g.player_name}
              {g.detail && g.detail !== 'Normal Goal' ? ` (${g.detail})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Injuries / lineups / standings / H2H
// ---------------------------------------------------------------------------

function InjurySection({ d }: { d: Data }) {
  const m = d.match;
  return (
    <Section title="ตัวเจ็บ / ติดโทษ">
      {d.injuries.length ? (
        <div className="grid grid-cols-2 gap-4 text-sm">
          {[m.home, m.away].map((t) => (
            <div key={t.id}>
              <p className="mb-1 text-xs font-semibold text-slate-500">{t.name}</p>
              <ul className="space-y-0.5">
                {d.injuries
                  .filter((i) => i.team_id === t.id)
                  .map((i, k) => (
                    <li key={k}>
                      {i.player_name} <span className="text-xs text-slate-400">· {i.type === 'Missing Fixture' ? 'ไม่ได้ลงเล่น' : i.type === 'Questionable' ? 'ไม่แน่นอน' : i.type} ({i.reason})</span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <Empty>ไม่มีรายงานตัวเจ็บ</Empty>
      )}
    </Section>
  );
}

function LineupSection({ d }: { d: Data }) {
  const m = d.match;
  const starters = d.lineups.filter((p) => p.is_starter);
  return (
    <Section title="ตัวจริง" aside={starters.length ? 'ยืนยันแล้ว' : undefined}>
      {starters.length ? (
        <div className="grid grid-cols-2 gap-4 text-sm">
          {[m.home, m.away].map((t) => (
            <ol key={t.id} className="space-y-0.5">
              <li className="mb-1 text-xs font-semibold text-slate-500">{t.name}</li>
              {starters
                .filter((p) => p.team_id === t.id)
                .map((p, k) => (
                  <li key={k} className="flex gap-2">
                    <span className="w-6 text-right text-xs tabular-nums text-slate-400">{p.number}</span>
                    {p.player_name}
                  </li>
                ))}
            </ol>
          ))}
        </div>
      ) : (
        <Empty>รายชื่อตัวจริงจะประกาศประมาณ 1 ชั่วโมงก่อนเตะ</Empty>
      )}
    </Section>
  );
}

function StandingsSection({ d }: { d: Data }) {
  const m = d.match;
  const rows = [m.home, m.away].map((t) => ({ t, s: d.standings.find((s) => s.team_id === t.id) })).filter((x) => x.s);
  return (
    <Section title="ตารางคะแนน">
      {rows.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-slate-500">
              <th className="pb-2 text-left font-normal">ทีม</th>
              <th className="pb-2 font-normal">อันดับ</th>
              <th className="pb-2 font-normal">แข่ง</th>
              <th className="pb-2 font-normal">ชนะ-เสมอ-แพ้</th>
              <th className="pb-2 font-normal">ได้-เสีย</th>
              <th className="pb-2 font-normal">แต้ม</th>
            </tr>
          </thead>
          <tbody className="text-center tabular-nums">
            {rows.map(({ t, s }) => (
              <tr key={t.id}>
                <td className="py-1 text-left">{t.name}</td>
                <td>{s!.rank}</td>
                <td>{s!.played}</td>
                <td>
                  {s!.win}-{s!.draw}-{s!.lose}
                </td>
                <td>
                  {s!.goals_for}-{s!.goals_against}
                </td>
                <td className="font-semibold">{s!.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty>ยังไม่มีตารางคะแนน</Empty>
      )}
    </Section>
  );
}

function H2HSection({ d }: { d: Data }) {
  return (
    <Section title="เจอกันล่าสุด (H2H)">
      {d.h2h.length ? (
        <ul className="space-y-1 text-sm">
          {d.h2h.map((h) => (
            <li key={h.slug} className="flex justify-between gap-2">
              <span className="text-xs text-slate-500">{shortDayTH(h.kickoff_at)}</span>
              <TextLink href={`/matches/${h.slug}`}>
                {h.home.name} {h.ft_home ?? h.goals_home}-{h.ft_away ?? h.goals_away} {h.away.name}
              </TextLink>
            </li>
          ))}
        </ul>
      ) : (
        <Empty>ไม่มีประวัติการพบกันในข้อมูลของเรา</Empty>
      )}
    </Section>
  );
}

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CompassCard } from '@/components/compass-card';
import { ModelOutlookCard } from '@/components/model-outlook';
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
    <main className="mx-auto max-w-5xl space-y-4 px-4 py-5 sm:space-y-5 sm:py-8">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Header d={d} />

      {latest ? (
        <div className="space-y-2">
          <CompassCard c={latest} home={m.home.name} away={m.away.name} />
          {earlier.map((c) => (
            <details key={c.public_id} className="rounded-xl border border-slate-200 bg-white px-4 text-sm">
              <summary className="flex min-h-11 cursor-pointer items-center text-slate-600">บทวิเคราะห์รอบก่อนหน้า ({c.public_id}) — ยังอยู่ใน track record</summary>
              <div className="pb-3">
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

      {d.outlook ? <ModelOutlookCard o={d.outlook} home={m.home.name} away={m.away.name} result={result90(d)} /> : null}

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

const OFF: Record<string, string> = { PST: 'เลื่อนการแข่งขัน', CANC: 'ยกเลิก', ABD: 'ยุติการแข่งขัน' };

function Header({ d }: { d: Data }) {
  const m = d.match;
  const live = LIVE.includes(m.status_short);
  const showScore = d.finished || live;
  const photo = m.venue?.image_url;
  return (
    <section className="relative -mx-4 overflow-hidden bg-[var(--color-ink)] px-4 py-6 text-white sm:mx-0 sm:rounded-3xl sm:px-6 sm:py-8">
      {photo ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photo} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25" />
          <div className="absolute inset-0 bg-gradient-to-b from-[var(--color-ink)]/60 to-[var(--color-ink)]" aria-hidden />
        </>
      ) : null}
      <div className="relative">
        <p className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 text-center text-xs text-slate-300">
          <span className="inline-flex items-center gap-1.5">
            <span className="flex h-4 w-4 items-center justify-center rounded bg-white">
              <TeamLogo src={m.league.logo_url} alt="" size={12} />
            </span>
            {m.league.name}
          </span>
          {m.round ? <span>· {m.round}</span> : null}
          <span>· {dayTH(m.kickoff_at)}</span>
          {m.venue?.name ? <span>· {m.venue.name}</span> : null}
        </p>
        <div className="mt-5 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-6">
          <Team t={m.home} side="เจ้าบ้าน" />
          <div className="text-center">
            {showScore ? (
              <>
                <p className="text-4xl font-bold tabular-nums sm:text-5xl">
                  {m.goals_home}
                  <span className="mx-1.5 text-slate-500">–</span>
                  {m.goals_away}
                </p>
                <p className="mt-1.5 text-xs text-slate-300">
                  {live ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--color-live)] px-2 py-0.5 font-semibold text-white">
                      <span className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" aria-hidden />
                      สด {m.status_short === 'HT' ? 'พักครึ่ง' : `${m.elapsed}′`}
                    </span>
                  ) : (
                    'จบการแข่งขัน'
                  )}
                  {m.ht_home != null ? <span className="block pt-1">ครึ่งแรก {m.ht_home}-{m.ht_away}</span> : null}
                </p>
              </>
            ) : OFF[m.status_short] ? (
              <p className="text-base font-semibold text-rose-300">{OFF[m.status_short]}</p>
            ) : (
              <>
                <p className="text-3xl font-bold tabular-nums sm:text-4xl">{timeTH(m.kickoff_at)}</p>
                <p className="mt-1 text-xs text-slate-300">เวลาไทย</p>
              </>
            )}
          </div>
          <Team t={m.away} side="ทีมเยือน" />
        </div>
      </div>
    </section>
  );
}

function Team({ t, side }: { t: Data['match']['home']; side: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white p-2 sm:h-20 sm:w-20">
        <TeamLogo src={t.logo_url} alt="" size={56} />
      </span>
      <p className="line-clamp-2 text-sm font-semibold leading-tight sm:text-base">{t.name}</p>
      <p className="text-xs text-slate-400">{side}</p>
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
          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <table className="w-full min-w-[20rem] text-sm">
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
                    <td className="py-2 pr-2">{label}</td>
                    <td className="py-2 text-right tabular-nums text-slate-600">{odds(r!.opening_odds)}</td>
                    <td className="py-2 text-right font-semibold tabular-nums">
                      {odds(r!.current_odds)}
                      {Math.abs(move) >= 0.03 ? (
                        <span className={`ml-1 text-xs ${move < 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
                          <span aria-hidden>{move < 0 ? '▼' : '▲'}</span>
                          <span className="sr-only">{move < 0 ? 'ราคาลง' : 'ราคาขึ้น'}</span>
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-right text-xs text-slate-500">{r!.bookmakers}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
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
        <span className="min-w-0 truncate text-sm font-semibold">{name}</span>
        <FormPills results={[...rows].reverse().map((r) => r.result)} />
      </div>
      {rows.length ? (
        <>
          <ul className="space-y-1 text-sm text-slate-700">
            {rows.map((r) => (
              <li key={r.slug} className="flex justify-between gap-2">
                <span className="truncate">
                  {shortDayTH(r.kickoff_at)} · {r.venue === 'H' ? 'เหย้า' : 'เยือน'} vs {r.opponent}
                </span>
                <span className="shrink-0 tabular-nums">
                  {r.gf}-{r.ga}
                  {r.xgFor != null ? <span className="ml-2 text-xs text-slate-500">xG {r.xgFor.toFixed(2)}-{r.xgAgainst?.toFixed(2) ?? '–'}</span> : null}
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
      <div className="mb-3 flex justify-between gap-3 text-xs font-semibold">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-[var(--color-pitch)]" aria-hidden />
          <span className="truncate">{m.home.name}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{m.away.name}</span>
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-slate-500" aria-hidden />
        </span>
      </div>
      <div className="space-y-3">
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
              <div className="flex justify-between text-sm">
                <span className="font-semibold tabular-nums">{show(h)}</span>
                <span className="text-slate-500">{label}</span>
                <span className="font-semibold tabular-nums">{show(a)}</span>
              </div>
              <div className="mt-1 flex h-2 gap-0.5" aria-hidden>
                <div className="rounded-l-full bg-[var(--color-pitch)]" style={{ width: `${share}%` }} />
                <div className="flex-1 rounded-r-full bg-slate-500" />
              </div>
            </div>
          );
        })}
      </div>
      {goals.length ? (
        <ul className="mt-4 space-y-1 border-t border-slate-100 pt-3 text-sm text-slate-700">
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
                      {i.player_name} <span className="text-xs text-slate-500">· {i.type === 'Missing Fixture' ? 'ไม่ได้ลงเล่น' : i.type === 'Questionable' ? 'ไม่แน่นอน' : i.type} ({i.reason})</span>
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
                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-slate-500">{p.number}</span>
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
        <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <table className="w-full min-w-[22rem] text-sm">
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
                <td className="max-w-[9rem] truncate py-2 pr-2 text-left">{t.name}</td>
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
        </div>
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
            <li key={h.slug} className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-2">
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

/** 90-minute result of a finished match (what the model outlook is scored against). */
function result90(d: Data): 'HOME' | 'DRAW' | 'AWAY' | null {
  if (!d.finished) return null;
  const h = d.match.ft_home ?? d.match.goals_home;
  const a = d.match.ft_away ?? d.match.goals_away;
  if (h == null || a == null) return null;
  return h > a ? 'HOME' : h < a ? 'AWAY' : 'DRAW';
}

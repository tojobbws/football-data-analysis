import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CompassCard } from '@/components/compass-card';
import { MatchPreviewCard } from '@/components/match-preview';
import { ModelOutlookCard } from '@/components/model-outlook';
import { Badge, Card, Note } from '@/components/sheet';
import { TeamLogo } from '@/components/ui';
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
    description: `วิเคราะห์ ${home.name} vs ${away.name} (${league.name}) ${dayTH(kickoff_at)} — ฟอร์ม, xG, ตัวเจ็บ, แรงตลาด และเข็มทิศเกม`,
    alternates: { canonical: `/matches/${slug}` },
  };
}

/**
 * Match page as a quiet data sheet: typographic header, then cards with hairlines and tables.
 * Main column = the pick and the reading; side column = market, table, H2H.
 */
export default async function MatchPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const d = await matchBySlug(slug);
  if (!d) notFound();
  const { match: m } = d;
  // fog (NO_CLEAR_SIGNAL) rounds stay in the record (/performance) but are not shown here: only picks are
  const latest = d.rounds.at(-1) ?? null;
  const pick = latest?.kind === 'SIGNAL' ? latest : null;
  const earlierPicks = d.rounds.slice(0, -1).filter((c) => c.kind === 'SIGNAL');
  const noAnalysisYet = !latest;

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

  const sections = [
    pick || earlierPicks.length || noAnalysisYet ? { id: 'pick', label: 'เข็มทิศเกม' } : null,
    d.preview || (!d.finished && !OFF[m.status_short]) ? { id: 'analysis', label: 'วิเคราะห์' } : null,
    d.outlook?.sides_tested ? { id: 'model', label: 'โมเดล' } : null,
    d.finished && d.stats.length ? { id: 'stats', label: 'สถิติ' } : null,
    { id: 'form', label: 'ฟอร์ม' },
    { id: 'squad', label: 'ผู้เล่น' },
    { id: 'market', label: 'แรงตลาด' },
    { id: 'table', label: 'ตาราง' },
    { id: 'h2h', label: 'H2H' },
  ].filter((x): x is { id: string; label: string } => x != null);

  return (
    <div className="bg-white">
      <main className="mx-auto max-w-5xl px-4 pb-12 pt-5 sm:pt-8">
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
        <MatchHead d={d} />

        <nav aria-label="ส่วนต่าง ๆ ของหน้านี้" className="sticky top-14 z-20 -mx-4 mt-4 overflow-x-auto border-b border-zinc-100 bg-white px-4 py-2 [scrollbar-width:none] md:top-16">
          <ul className="inline-flex gap-1 rounded-lg bg-zinc-100 p-1">
            {sections.map((s) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="flex min-h-10 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium text-zinc-600 transition-colors duration-150 hover:bg-white hover:text-zinc-950 hover:shadow-[0_1px_2px_rgb(9_9_11/0.06)]"
                >
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-6 grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-6">
            {pick ? <CompassCard id="pick" c={pick} home={m.home.name} away={m.away.name} /> : null}
            {earlierPicks.length ? (
              <div id={pick ? undefined : 'pick'} className="scroll-mt-24 space-y-2">
                {earlierPicks.map((c) => (
                  <details key={c.public_id} className="group">
                    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 border-b border-zinc-200 text-sm text-zinc-700 [&::-webkit-details-marker]:hidden">
                      <span>
                        เข็มทิศเกมรอบก่อนหน้า <span className="font-mono text-xs text-zinc-500">{c.public_id}</span>
                      </span>
                      <span className="text-xs text-zinc-500 group-open:hidden">แสดง</span>
                      <span className="hidden text-xs text-zinc-500 group-open:inline">ซ่อน</span>
                    </summary>
                    <div className="pt-3">
                      <CompassCard c={c} home={m.home.name} away={m.away.name} />
                    </div>
                  </details>
                ))}
              </div>
            ) : null}
            {noAnalysisYet ? (
              <Card id="pick" title="เข็มทิศเกม" description="1 ตัวเลือกที่ข้อมูลสนับสนุนมากที่สุด เฉพาะคู่ที่ข้อมูลชี้ชัด">
                <p className="text-sm text-zinc-500">{FINISHED.includes(m.status_short) ? 'แมตช์นี้ไม่มีบทวิเคราะห์ที่เผยแพร่' : 'บทวิเคราะห์จะเผยแพร่ภายใน 24 ชม. ก่อนเตะ'}</p>
              </Card>
            ) : null}

            {d.preview ? (
              <MatchPreviewCard id="analysis" p={d.preview} home={m.home.name} away={m.away.name} result={score90(d)} modelTested={d.outlook?.sides_tested === true} />
            ) : !d.finished && !OFF[m.status_short] ? (
              <Card id="analysis" title="วิเคราะห์เกม">
                <p className="text-sm text-zinc-500">บทวิเคราะห์จะเผยแพร่ภายใน 48 ชม. ก่อนเตะ</p>
              </Card>
            ) : null}

            {d.outlook?.sides_tested ? <ModelOutlookCard id="model" o={d.outlook} home={m.home.name} away={m.away.name} result={result90(d)} /> : null}
          </div>

          <aside className="min-w-0 space-y-6 lg:sticky lg:top-32" aria-label="ข้อมูลประกอบ">
            <MarketSection d={d} />
            <StandingsSection d={d} />
            <H2HSection d={d} />
          </aside>
        </div>

        <div className="mt-6 space-y-6">
          {d.finished && d.stats.length ? <StatsSection d={d} /> : null}
          <FormSection d={d} />
          <SquadSection d={d} />
        </div>
      </main>
    </div>
  );
}

const OFF: Record<string, string> = { PST: 'เลื่อนการแข่งขัน', CANC: 'ยกเลิก', ABD: 'ยุติการแข่งขัน' };

// ---------------------------------------------------------------------------
// Header: type on white, no hero box
// ---------------------------------------------------------------------------

function MatchHead({ d }: { d: Data }) {
  const m = d.match;
  const live = LIVE.includes(m.status_short);
  const showScore = d.finished || live;
  return (
    <header className="border-b border-zinc-200 pb-6">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
        <span className="inline-flex items-center gap-1.5 font-medium text-zinc-700">
          <TeamLogo src={m.league.logo_url} alt="" size={16} />
          {m.league.name}
        </span>
        {m.round ? <><Sep />{m.round}</> : null}
        <Sep />
        {dayTH(m.kickoff_at)}
        {m.venue?.name ? <><Sep />{m.venue.name}</> : null}
      </p>

      <div className="mt-6 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 sm:gap-8">
        <TeamHead t={m.home} side="เจ้าบ้าน" />
        <div className="text-center">
          {showScore ? (
            <>
              <p className="text-4xl font-semibold tabular-nums tracking-tight text-zinc-950 sm:text-5xl">
                {m.goals_home}
                <span className="px-2 text-zinc-300">–</span>
                {m.goals_away}
              </p>
              <div className="mt-2 flex flex-col items-center gap-1 text-xs text-zinc-500">
                {live ? <Badge variant="live">สด {m.status_short === 'HT' ? 'พักครึ่ง' : `${m.elapsed}′`}</Badge> : <Badge variant="secondary">จบการแข่งขัน</Badge>}
                {m.ht_home != null ? <span className="tabular-nums">ครึ่งแรก {m.ht_home}–{m.ht_away}</span> : null}
              </div>
            </>
          ) : OFF[m.status_short] ? (
            <Badge variant="bad">{OFF[m.status_short]}</Badge>
          ) : (
            <>
              <p className="text-4xl font-semibold tabular-nums tracking-tight text-zinc-950 sm:text-5xl">{timeTH(m.kickoff_at)}</p>
              <p className="mt-1.5 text-xs text-zinc-500">เวลาไทย</p>
            </>
          )}
        </div>
        <TeamHead t={m.away} side="ทีมเยือน" right />
      </div>
    </header>
  );
}

function Sep() {
  return (
    <span className="text-zinc-300" aria-hidden>
      /
    </span>
  );
}

function TeamHead({ t, side, right = false }: { t: Data['match']['home']; side: string; right?: boolean }) {
  return (
    <div className={`flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4 ${right ? 'items-end text-right sm:flex-row-reverse' : 'items-start'}`}>
      <TeamLogo src={t.logo_url} alt="" size={48} />
      <div className="min-w-0">
        <p className="line-clamp-2 text-base font-semibold leading-tight tracking-tight text-zinc-950 sm:text-2xl">{t.name}</p>
        <p className="mt-1 text-xs text-zinc-500">{side}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Market
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
  const groups: Array<{ name: string; rows: Array<{ label: string; r: MarketRow | undefined }> }> = [
    { name: '1X2', rows: (['HOME', 'DRAW', 'AWAY'] as const).map((s) => ({ label: selectionLabel('MATCH_WINNER', s, null, m.home.name, m.away.name), r: mw.find((x) => x.selection === s) })) },
    {
      name: 'แฮนดิแคป',
      rows:
        ahLine != null
          ? [
              { label: selectionLabel('ASIAN_HANDICAP', 'HOME', ahLine, m.home.name, m.away.name), r: ah.find((x) => x.selection === 'HOME' && Number(x.line) === ahLine) },
              { label: selectionLabel('ASIAN_HANDICAP', 'AWAY', -ahLine || 0, m.home.name, m.away.name), r: ah.find((x) => x.selection === 'AWAY' && Number(x.line) === (-ahLine || 0)) },
            ]
          : [],
    },
    {
      name: 'สูง/ต่ำ',
      rows: ouLine != null ? (['OVER', 'UNDER'] as const).map((s) => ({ label: selectionLabel('OVER_UNDER', s, ouLine, m.home.name, m.away.name), r: ou.find((x) => x.selection === s && Number(x.line) === ouLine) })) : [],
    },
  ]
    .map((g) => ({ ...g, rows: g.rows.filter((x) => x.r) }))
    .filter((g) => g.rows.length);
  const last = d.market.reduce<string | null>((a, r) => (!a || r.last_quote_at > a ? r.last_quote_at : a), null);
  const books = d.market.length ? Math.max(...d.market.map((r) => r.bookmakers)) : 0;

  return (
    <Card id="market" title="แรงตลาด" description={last ? `ค่ากลางจากสูงสุด ${books} เจ้ามือ · อัปเดต ${dateTimeTH(last)}` : 'ราคาก่อนเตะจากหลายเจ้ามือ'}>
      {groups.length ? (
        <>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 text-xs text-zinc-500">
                <th className="pb-2 text-left font-medium">ตัวเลือก</th>
                <th className="pb-2 text-right font-medium">เปิด</th>
                <th className="pb-2 text-right font-medium">ล่าสุด</th>
                <th className="pb-2 pl-2 text-right font-medium">เปลี่ยน</th>
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.name} className="border-b border-zinc-100 last:border-0">
                <tr>
                  <th colSpan={4} className="pb-1 pt-3 text-left text-xs font-medium text-zinc-500">
                    {g.name}
                  </th>
                </tr>
                {g.rows.map(({ label, r }) => {
                  const o = Number(r!.opening_odds);
                  const c = Number(r!.current_odds);
                  const delta = o && c ? c - o : 0;
                  const moved = o ? Math.abs(delta) / o >= 0.03 : false;
                  return (
                    <tr key={label}>
                      <td className="max-w-[9rem] truncate py-1.5 pr-2 text-zinc-800">{label}</td>
                      <td className="py-1.5 text-right tabular-nums text-zinc-500">{odds(r!.opening_odds)}</td>
                      <td className="py-1.5 text-right font-semibold tabular-nums text-zinc-950">{odds(r!.current_odds)}</td>
                      <td className={`py-1.5 pl-2 text-right text-xs tabular-nums ${moved ? (delta < 0 ? 'font-medium text-emerald-700' : 'font-medium text-rose-700') : 'text-zinc-400'}`}>
                        {delta === 0 ? '0.00' : `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            ))}
          </table>
          <Note>ราคาลด (สีเขียว) = ตลาดให้น้ำหนักฝั่งนั้นมากขึ้น · ไฮไลต์เมื่อเปลี่ยนตั้งแต่ 3%</Note>
        </>
      ) : (
        <p className="text-sm text-zinc-500">ยังไม่มีข้อมูลราคาตลาดสำหรับแมตช์นี้</p>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Form / xG
// ---------------------------------------------------------------------------

function FormSection({ d }: { d: Data }) {
  const m = d.match;
  return (
    <Card id="form" title="ฟอร์ม 5 นัดล่าสุด" description="ทุกรายการ เรียงจากล่าสุด · xG เมื่อมีข้อมูล">
      <div className="grid gap-6 md:grid-cols-2">
        <FormTeam name={m.home.name} rows={d.form.home} />
        <FormTeam name={m.away.name} rows={d.form.away} />
      </div>
    </Card>
  );
}

const RESULT_TONE = {
  W: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  D: 'bg-zinc-50 text-zinc-700 ring-zinc-200',
  L: 'bg-rose-50 text-rose-800 ring-rose-200',
} as const;

function FormTeam({ name, rows }: { name: string; rows: FormRow[] }) {
  const xg = rows.filter((r) => r.xgFor != null);
  const avg = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : '–');
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-200 pb-2">
        <span className="min-w-0 truncate text-sm font-semibold text-zinc-950">{name}</span>
        <span className="flex gap-1" aria-label={`ผล 5 นัด: ${[...rows].reverse().map((r) => r.result).join(' ')}`}>
          {[...rows].reverse().map((r, i) => (
            <span key={i} className={`inline-flex h-5 w-5 items-center justify-center rounded-[4px] text-[11px] font-semibold ring-1 ring-inset ${RESULT_TONE[r.result]}`} aria-hidden>
              {r.result}
            </span>
          ))}
        </span>
      </div>
      {rows.length ? (
        <>
          <ul className="divide-y divide-zinc-100 text-sm">
            {rows.map((r) => (
              <li key={r.slug} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0 text-zinc-700">
                  <span className="text-xs text-zinc-500">{shortDayTH(r.kickoff_at)}</span> <span className="text-xs text-zinc-500">{r.venue === 'H' ? 'เหย้า' : 'เยือน'}</span> {r.opponent}
                </span>
                <span className="shrink-0 text-right tabular-nums">
                  <span className="font-medium text-zinc-950">{r.gf}–{r.ga}</span>
                  {r.xgFor != null ? <span className="ml-2 text-xs text-zinc-500">{r.xgFor.toFixed(2)}–{r.xgAgainst?.toFixed(2) ?? '–'}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          {xg.length ? (
            <p className="mt-2 text-xs text-zinc-500">
              xG เฉลี่ย ได้ <b className="font-medium tabular-nums text-zinc-700">{avg(xg.map((r) => r.xgFor!))}</b> · เสีย{' '}
              <b className="font-medium tabular-nums text-zinc-700">{avg(xg.filter((r) => r.xgAgainst != null).map((r) => r.xgAgainst!))}</b> ({xg.length} นัด)
            </p>
          ) : null}
        </>
      ) : (
        <p className="pt-2 text-sm text-zinc-500">ยังไม่มีข้อมูล</p>
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
    <Card id="stats" title="สถิติหลังเกม" description={`${m.home.name} (แท่งเข้ม) ซ้าย · ${m.away.name} ขวา`}>
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
                <span className="font-semibold tabular-nums text-zinc-950">{show(h)}</span>
                <span className="text-zinc-500">{label}</span>
                <span className="font-semibold tabular-nums text-zinc-950">{show(a)}</span>
              </div>
              <div className="mt-1 flex h-1.5 gap-0.5 overflow-hidden rounded-full" aria-hidden>
                <div className="bg-zinc-800" style={{ width: `${share}%` }} />
                <div className="flex-1 bg-zinc-300" />
              </div>
            </div>
          );
        })}
      </div>
      {goals.length ? (
        <ul className="mt-4 space-y-1 border-t border-zinc-100 pt-3 text-sm text-zinc-700">
          {goals.map((g, i) => (
            <li key={i} className={g.team_id === m.away.id ? 'text-right' : ''}>
              <span className="tabular-nums text-zinc-500">
                {g.elapsed}
                {g.extra ? `+${g.extra}` : ''}′
              </span>{' '}
              {g.player_name}
              {g.detail && g.detail !== 'Normal Goal' ? ` (${g.detail})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Players: absences + starting XI in one card
// ---------------------------------------------------------------------------

const ABSENCE: Record<string, string> = { 'Missing Fixture': 'ไม่ได้ลงเล่น', Questionable: 'ไม่แน่นอน' };

function SquadSection({ d }: { d: Data }) {
  const m = d.match;
  const starters = d.lineups.filter((p) => p.is_starter);
  return (
    <Card id="squad" title="ผู้เล่น" description={starters.length ? 'ตัวจริงยืนยันแล้ว' : 'ตัวจริงจะประกาศประมาณ 1 ชั่วโมงก่อนเตะ'}>
      <div className="grid gap-6 md:grid-cols-2">
        {[m.home, m.away].map((t) => {
          const out = d.injuries.filter((i) => i.team_id === t.id);
          const xi = starters.filter((p) => p.team_id === t.id);
          return (
            <div key={t.id} className="min-w-0">
              <p className="border-b border-zinc-200 pb-2 text-sm font-semibold text-zinc-950">{t.name}</p>
              <p className="mt-3 text-xs font-medium text-zinc-500">ตัวเจ็บ / ติดโทษ</p>
              {out.length ? (
                <ul className="mt-1 divide-y divide-zinc-100 text-sm">
                  {out.map((i, k) => (
                    <li key={k} className="flex items-baseline justify-between gap-3 py-1.5">
                      <span className="min-w-0 text-zinc-800">
                        {i.player_name} <span className="text-xs text-zinc-500">{i.reason}</span>
                      </span>
                      <span className={`shrink-0 text-xs ${i.type === 'Missing Fixture' ? 'font-medium text-zinc-800' : 'text-zinc-500'}`}>{ABSENCE[i.type ?? ''] ?? i.type}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 text-sm text-zinc-500">ไม่มีรายงาน</p>
              )}
              {xi.length ? (
                <>
                  <p className="mt-4 text-xs font-medium text-zinc-500">ตัวจริง</p>
                  <ol className="mt-1 grid grid-cols-1 gap-x-4 text-sm sm:grid-cols-2">
                    {xi.map((p, k) => (
                      <li key={k} className="flex gap-2 py-0.5">
                        <span className="w-5 shrink-0 text-right text-xs tabular-nums leading-5 text-zinc-500">{p.number}</span>
                        <span className="min-w-0 truncate text-zinc-800">{p.player_name}</span>
                      </li>
                    ))}
                  </ol>
                </>
              ) : null}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Standings / H2H
// ---------------------------------------------------------------------------

function StandingsSection({ d }: { d: Data }) {
  const m = d.match;
  const rows = [m.home, m.away].map((t) => ({ t, s: d.standings.find((s) => s.team_id === t.id) })).filter((x) => x.s);
  return (
    <Card id="table" title="ตารางคะแนน" description={m.league.name}>
      {rows.length ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs text-zinc-500">
              <th className="pb-2 text-left font-medium">#</th>
              <th className="pb-2 text-left font-medium">ทีม</th>
              <th className="pb-2 text-right font-medium">แข่ง</th>
              <th className="pb-2 text-right font-medium">+/-</th>
              <th className="pb-2 text-right font-medium">แต้ม</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 tabular-nums">
            {rows.map(({ t, s }) => (
              <tr key={t.id}>
                <td className="w-6 py-2 text-zinc-500">{s!.rank}</td>
                <td className="max-w-[8rem] truncate py-2 pr-2 text-zinc-800">
                  {t.name}
                  <span className="block text-xs text-zinc-500">
                    ชนะ {s!.win} เสมอ {s!.draw} แพ้ {s!.lose}
                  </span>
                </td>
                <td className="py-2 text-right text-zinc-600">{s!.played}</td>
                <td className="py-2 text-right text-zinc-600">{s!.goals_for - s!.goals_against > 0 ? '+' : ''}{s!.goals_for - s!.goals_against}</td>
                <td className="py-2 text-right font-semibold text-zinc-950">{s!.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="text-sm text-zinc-500">ยังไม่มีตารางคะแนน</p>
      )}
    </Card>
  );
}

function H2HSection({ d }: { d: Data }) {
  return (
    <Card id="h2h" title="เจอกันล่าสุด" description={d.h2h.length ? `${d.h2h.length} นัดในข้อมูลของเรา` : undefined}>
      {d.h2h.length ? (
        <ul className="-mx-2 divide-y divide-zinc-100 text-sm">
          {d.h2h.map((h) => {
            const hs = h.ft_home ?? h.goals_home;
            const as = h.ft_away ?? h.goals_away;
            const homeWon = hs != null && as != null && hs > as;
            const awayWon = hs != null && as != null && as > hs;
            return (
              <li key={h.slug}>
                <Link href={`/matches/${h.slug}`} className="grid grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-md px-2 py-2 transition-colors duration-150 hover:bg-zinc-50">
                  <span className="whitespace-nowrap text-xs text-zinc-500">{shortDayTH(h.kickoff_at)}</span>
                  <span className="min-w-0 leading-snug">
                    <span className={`block ${homeWon ? 'font-semibold text-zinc-950' : 'text-zinc-600'}`}>{h.home.name}</span>
                    <span className={`block ${awayWon ? 'font-semibold text-zinc-950' : 'text-zinc-600'}`}>{h.away.name}</span>
                  </span>
                  <span className="text-right font-semibold leading-snug tabular-nums text-zinc-950">
                    <span className="block">{hs ?? '–'}</span>
                    <span className="block">{as ?? '–'}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-zinc-500">ไม่มีประวัติการพบกันในข้อมูลของเรา</p>
      )}
    </Card>
  );
}

/** 90-minute score of a finished match (what the preview's predicted score is compared with). */
function score90(d: Data): { home: number; away: number } | null {
  if (!d.finished) return null;
  const h = d.match.ft_home ?? d.match.goals_home;
  const a = d.match.ft_away ?? d.match.goals_away;
  return h == null || a == null ? null : { home: h, away: a };
}

/** 90-minute result of a finished match (what the model outlook is scored against). */
function result90(d: Data): 'HOME' | 'DRAW' | 'AWAY' | null {
  const s = score90(d);
  if (!s) return null;
  return s.home > s.away ? 'HOME' : s.home < s.away ? 'AWAY' : 'DRAW';
}

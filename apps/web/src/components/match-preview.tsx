import type { ReactNode } from 'react';
import type { DataSupport, MatchPreview } from '@/lib/queries';
import { STATUS, pct, settle, type Status } from '@/lib/labels';
import type { MarketSelection } from '@fp/analysis';
import { dateTimeTH } from '@/lib/time';
import { Badge, Card, Note } from './sheet';
import { TeamLogo } from './primitives';

export const DATA_SUPPORT: Record<DataSupport, { label: string; variant: 'good' | 'warn' | 'bad' }> = {
  // enough for the analysis; what is still missing (H2H, lineups, injury reports) is listed apart
  GOOD: { label: 'ข้อมูลเพียงพอ', variant: 'good' },
  LIMITED: { label: 'ข้อมูลจำกัด', variant: 'warn' },
  THIN: { label: 'ข้อมูลน้อย', variant: 'bad' },
};

/** Older previews carried an "untested model" note; fan pages no longer show it (the record is untouched). */
const UNTESTED_NOTE = 'ยังไม่ผ่านการทดสอบ';

const STAGE: Record<MatchPreview['stage'], string> = { EARLY: 'ก่อนประกาศตัวจริง', LINEUP: 'หลังประกาศตัวจริง' };

export interface TeamContext {
  standing: { rank: number; points: number; played: number; goals_for: number; goals_against: number } | null;
  /** most recent first */
  form: Array<'W' | 'D' | 'L'>;
}

/**
 * วิเคราะห์เกม — the written preview. Reading material, not a pick: no compass colour, never in pick stats.
 * Numbers (probabilities, most likely score) are the model's; the prose is AI or template text, stored before kickoff.
 * With a pick on the page, the most likely score is tied back to it ("ถ้าจบ 2–0 … = เสมอตัว") so the two never read as rivals.
 * The score section leads with the goal bands (0–1 / 2 / 3+): a low top scoreline beside the outlook's over 2.5
 * read as a contradiction. Previews written before the bands (preview-v0.5) keep the scoreline and point to the outlook.
 * Previews from preview-v0.7 are written in sections and shown that way; older ones keep the four-part layout.
 * From preview-v0.8 the write-up has four parts (the match, each side, the model's numbers, the Game Compass);
 * its goal numbers come from the same totals matrix as the model outlook's over 2.5.
 */
export function MatchPreviewCard({
  p,
  home,
  away,
  result,
  modelTested,
  pick,
  pickNote,
  overInOutlook = false,
  teams,
  logos,
  gaps = [],
  info,
  id,
}: {
  p: MatchPreview;
  home: string;
  away: string;
  result?: { home: number; away: number } | null;
  modelTested: boolean;
  pick?: { label: string; sel: MarketSelection } | null;
  /** the pick's stored one-line note, shown under its label at the end of the write-up */
  pickNote?: string | null;
  overInOutlook?: boolean;
  /** table and recent results per side, for the stat cards and form chips of a sectioned preview */
  teams?: { home: TeamContext; away: TeamContext };
  /** club crests from the teams table (API-Football); a missing one falls back to a plain disc */
  logos?: { home: string | null; away: string | null };
  /** what the page does not have yet (dataGaps): shown quietly, never lowers the support level */
  gaps?: string[];
  /** preview-v1.0's pre-match block: competition, kickoff (Thai time) and venue from the fixture */
  info?: { league: string; kickoffAt: string; venue: string | null };
  id?: string;
}) {
  const notes = p.data_notes.filter((n) => !n.includes(UNTESTED_NOTE));
  // a LIMITED level whose only reason was the untested note reads as GOOD, like a preview written today
  const support = DATA_SUPPORT[p.data_support === 'LIMITED' && notes.length === 0 && p.data_notes.length > 0 ? 'GOOD' : p.data_support];
  const build = previewBuild(p.version);
  const v10 = build >= 100;
  const fourPart = build >= 8;
  const numbers = <ModelNumbers p={p} result={result} modelTested={modelTested} pick={pick} overInOutlook={overInOutlook} fourPart={fourPart} />;

  return (
    <Card id={id} title="วิเคราะห์เกม" description={`${STAGE[p.stage]} · ${dateTimeTH(p.created_at)}`} action={<Badge variant={support.variant}>{support.label}</Badge>}>
      {v10 ? (
        <V10Preview p={p} home={home} away={away} teams={teams} logos={logos} pick={pick} pickNote={pickNote} limits={notes} info={info} support={support.label} modelTested={modelTested} result={result} />
      ) : fourPart ? (
        <FourPartPreview p={p} home={home} away={away} teams={teams} logos={logos} pick={pick} pickNote={pickNote} limits={notes}>
          {numbers}
        </FourPartPreview>
      ) : p.attack_th != null ? (
        <SectionedPreview p={p} home={home} away={away} teams={teams} logos={logos} pick={pick} pickNote={pickNote} limits={notes}>
          {numbers}
        </SectionedPreview>
      ) : (
        <>
          {notes.length ? <p className="mb-3 text-xs leading-relaxed text-zinc-500">{notes.join(' · ')}</p> : null}
          <p className="max-w-prose text-[15px] leading-7 text-zinc-800">{p.overview_th}</p>
          <TeamTexts p={p} home={home} away={away} className="mt-5 border-t border-zinc-100 pt-4" />
          <div className="mt-5 border-t border-zinc-100 pt-4">{numbers}</div>
        </>
      )}

      {gaps.length ? <p className="mt-4 text-xs leading-relaxed text-zinc-500">ข้อมูลที่ยังไม่มี: {gaps.join(' · ')}</p> : null}
      <Note>
        {p.text_source === 'AI' ? 'เรียบเรียงโดย AI จากข้อมูลในระบบเท่านั้น ตัวเลขทุกตัวมาจากโมเดลและฐานข้อมูล' : 'สร้างจากตัวเลขในระบบโดยอัตโนมัติ'} · บันทึกก่อนเตะ แก้ไขไม่ได้ ·{' '}
        {fourPart ? 'เข็มทิศเกมเลือกโดยกฎของระบบ AI เป็นผู้อธิบายเท่านั้น ส่วนบทวิเคราะห์ไม่นับในผลงาน' : 'เป็นข้อมูลประกอบ ไม่ใช่เข็มทิศเกม และไม่นับในผลงาน'}
      </Note>
    </Card>
  );
}

/** "preview-v0.8" -> 8, "preview-v1.0" -> 100; anything else (older or unknown) -> 0 */
function previewBuild(version: string | undefined): number {
  const m = /^preview-v(\d+)\.(\d+)$/.exec(version ?? '');
  return m ? Number(m[1]) * 100 + Number(m[2]) : 0;
}

const CONFIDENCE: Record<NonNullable<MatchPreview['confidence']>, { label: string; variant: 'good' | 'warn' | 'bad' }> = {
  HIGH: { label: 'สูง', variant: 'good' },
  MEDIUM: { label: 'ปานกลาง', variant: 'warn' },
  LOW: { label: 'ต่ำ', variant: 'bad' },
};

/**
 * preview-v1.0, the layout of the 2026-10-20 brief: the pre-match facts, three points (the main
 * side's attack, its weak spots, the opponent), the model's most likely score in large type with its
 * reasons, and a game summary (สรุปเกม). The score keeps its honest name (สกอร์ที่โมเดลให้โอกาส
 * สูงสุด, never a forecast) and the summary's confidence comes from fixed rules. The Game Compass keeps
 * its own name and its own block: the summary is not a second pick.
 * preview-v1.1 keeps this frame in the order of a Thai press preview: a headline, each side in turn
 * with its form chips, the team news, the analysis, the score, then a list of facts read off the data.
 */
function V10Preview({ p, home, away, teams, logos, pick, pickNote, limits, info, support, modelTested, result }: { p: MatchPreview; home: string; away: string; teams?: { home: TeamContext; away: TeamContext }; logos?: { home: string | null; away: string | null }; pick?: { label: string; sel: MarketSelection } | null; pickNote?: string | null; limits: string[]; info?: { league: string; kickoffAt: string; venue: string | null }; support: string; modelTested: boolean; result?: { home: number; away: number } | null }) {
  const mainAway = p.main_side === 'AWAY';
  const main = { name: mainAway ? away : home, logo: mainAway ? logos?.away : logos?.home, form: (mainAway ? teams?.away : teams?.home)?.form ?? [] };
  const opp = { name: mainAway ? home : away, logo: mainAway ? logos?.home : logos?.away, form: (mainAway ? teams?.home : teams?.away)?.form ?? [] };
  const hasScore = p.predicted_home != null && p.predicted_away != null;
  const ph = p.p_home == null ? null : Number(p.p_home);
  const pa = p.p_away == null ? null : Number(p.p_away);
  const lean = ph == null || pa == null ? null : Math.abs(ph - pa) < 0.1 ? 'สูสี ตัวเลขของโมเดลไม่เอนไปทางใดชัด' : `${ph > pa ? home : away} มีแนวโน้มทำผลงานได้ดีกว่า`;
  const ifScore = pick && hasScore ? (settle(pick.sel, Number(p.predicted_home), Number(p.predicted_away)) as Status) : null;
  const factors = [p.key_factor_th, ...limits].filter((x): x is string => Boolean(x));
  const conf = p.confidence ? CONFIDENCE[p.confidence] : null;
  // preview-v1.1: each side in turn, the team news, the analysis and a facts list replace the three points
  const v11 = p.analysis_th != null;
  const points = [
    { n: 1, title: `เกมรุกของ ${main.name}`, text: p.attack_th, team: main },
    { n: 2, title: `จุดอ่อนและสิ่งที่ ${main.name} ต้องระวัง`, text: p.defence_th, team: null },
    { n: 3, title: `${opp.name} จะสร้างปัญหาได้แค่ไหน`, text: p.opponent_th, team: opp },
  ];

  return (
    <div className="space-y-5">
      {p.headline_th ? <p className="text-lg font-semibold leading-snug text-zinc-950 sm:text-xl">{p.headline_th}</p> : null}
      {info ? (
        <section aria-labelledby="pv-info">
          <SectionTitle id="pv-info">ข้อมูลก่อนเกม</SectionTitle>
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-zinc-500">รายการ</dt>
            <dd className="text-zinc-800">{info.league}</dd>
            <dt className="text-zinc-500">เวลาแข่ง</dt>
            <dd className="text-zinc-800">{dateTimeTH(info.kickoffAt)} (เวลาไทย)</dd>
            {info.venue ? (
              <>
                <dt className="text-zinc-500">สนาม</dt>
                <dd className="text-zinc-800">{info.venue}</dd>
              </>
            ) : null}
            <dt className="text-zinc-500">ข้อมูล</dt>
            <dd className="text-zinc-800">
              {support} · {STAGE[p.stage]} · บันทึก {dateTimeTH(p.created_at)}
            </dd>
          </dl>
          <p className="mt-3 max-w-prose text-base leading-7 text-zinc-800">{p.overview_th}</p>
        </section>
      ) : (
        <p className="max-w-prose text-base leading-7 text-zinc-800">{p.overview_th}</p>
      )}

      {v11 ? (
        <>
          <section aria-labelledby="pv-teams" className="border-t border-zinc-100 pt-4">
            <SectionTitle id="pv-teams">ฟอร์มของทั้งสองทีม</SectionTitle>
            <TeamTexts p={p} home={home} away={away} teams={teams} logos={logos} className="mt-3" />
          </section>
          {p.team_news_th ? (
            <section aria-labelledby="pv-news" className="border-t border-zinc-100 pt-4">
              <SectionTitle id="pv-news">สภาพความพร้อมของทีม</SectionTitle>
              <p className="mt-2 max-w-prose text-sm leading-relaxed text-zinc-700">{p.team_news_th}</p>
            </section>
          ) : null}
          <section aria-labelledby="pv-analysis" className="border-t border-zinc-100 pt-4">
            <SectionTitle id="pv-analysis">วิเคราะห์คู่นี้</SectionTitle>
            <p className="mt-2 max-w-prose text-[15px] leading-7 text-zinc-800">{p.analysis_th}</p>
          </section>
        </>
      ) : (
        <section aria-labelledby="pv-points" className="border-t border-zinc-100 pt-4">
          <SectionTitle id="pv-points">วิเคราะห์เกม 3 ประเด็น</SectionTitle>
          <ol className="mt-3 space-y-4">
            {points.map((x) => (
              <li key={x.n}>
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-950">
                  {x.team && logos ? <TeamLogo src={x.team.logo ?? null} alt="" size={20} /> : null}
                  <span>
                    {x.n}. {x.title}
                  </span>
                  {x.team?.form.length ? <FormChips results={x.team.form} /> : null}
                </p>
                {x.text ? <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-zinc-700">{x.text}</p> : null}
              </li>
            ))}
          </ol>
        </section>
      )}

      <section aria-labelledby="pv-score" className="border-t border-zinc-100 pt-4">
        <SectionTitle id="pv-score">สกอร์ที่โมเดลให้โอกาสสูงสุด</SectionTitle>
        {hasScore ? (
          <div className="mt-3 flex items-center justify-center gap-3 rounded-lg bg-zinc-50 px-3 py-4 sm:gap-5">
            <span className="flex min-w-0 flex-1 items-center justify-end gap-2 text-right text-sm font-semibold text-zinc-950">
              <span className="truncate">{home}</span>
              {logos ? <TeamLogo src={logos.home} alt="" size={28} /> : null}
            </span>
            <span className="shrink-0 text-3xl font-semibold tabular-nums tracking-tight text-zinc-950">
              {p.predicted_home}–{p.predicted_away}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold text-zinc-950">
              {logos ? <TeamLogo src={logos.away} alt="" size={28} /> : null}
              <span className="truncate">{away}</span>
            </span>
          </div>
        ) : null}
        {hasScore ? (
          <p className="mt-2 text-center text-xs text-zinc-500">
            โอกาสของสกอร์นี้ {pct(p.predicted_p)} · เป็นการประเมินก่อนเกม ยังมีสกอร์อื่นอีก {pct(1 - Number(p.predicted_p))}
            {p.expected_home != null ? ` · ประตูที่โมเดลคาด (xG) ${Number(p.expected_home).toFixed(2)}–${Number(p.expected_away).toFixed(2)}` : ''}
          </p>
        ) : null}
        {p.score_th ? <p className="mt-3 max-w-prose text-sm leading-relaxed text-zinc-700">{p.score_th}</p> : null}
        {ifScore ? (
          <p className="mt-2 text-xs text-zinc-600">
            ถ้าจบ {p.predicted_home}–{p.predicted_away} เข็มทิศเกม {pick!.label} = <b className="font-semibold text-zinc-950">{STATUS[ifScore].label}</b>
          </p>
        ) : null}
        {result && hasScore ? (
          <p className="mt-2 text-xs text-zinc-600">
            ผลจริง <b className="tabular-nums text-zinc-950">{result.home}–{result.away}</b>
          </p>
        ) : null}
        {hasScore && !modelTested ? <p className="mt-1 text-xs text-zinc-400">อยู่ระหว่างการวัดผล</p> : null}
      </section>

      {p.facts_th?.length ? (
        <section aria-labelledby="pv-facts" className="border-t border-zinc-100 pt-4">
          <SectionTitle id="pv-facts">ข้อมูลน่าสนใจ</SectionTitle>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-zinc-700">
            {p.facts_th.map((x) => (
              <li key={x} className="flex gap-2.5">
                <span className="mt-[0.6em] h-px w-2.5 shrink-0 bg-zinc-300" aria-hidden />
                <span>{x}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="pv-summary" className="border-t border-zinc-100 pt-4">
        <SectionTitle id="pv-summary">สรุปเกม</SectionTitle>
        <dl className="mt-2 divide-y divide-zinc-100 text-sm">
          {lean ? <SummaryRow k="แนวโน้มผล" v={lean} /> : null}
          {hasScore ? <SummaryRow k="สกอร์ที่โมเดลให้โอกาสสูงสุด" v={`${home} ${p.predicted_home}–${p.predicted_away} ${away} (${pct(p.predicted_p)})`} /> : null}
          {p.p_goals_3plus != null ? (
            <SummaryRow k="แนวโน้มประตู" v={`3 ประตูขึ้นไป ${pct(p.p_goals_3plus)}${p.p_btts != null ? ` · ทั้งสองทีมยิงได้ ${pct(p.p_btts)}` : ''}`} />
          ) : null}
          {factors.length ? <SummaryRow k="ปัจจัยสำคัญ" v={factors.join(' ')} /> : null}
          {conf ? (
            <div className="grid gap-1 py-2 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
              <dt className="text-zinc-500">ความมั่นใจ</dt>
              <dd className="text-zinc-800">
                <Badge variant={conf.variant}>{conf.label}</Badge>
                {p.confidence_notes.length ? <span className="ml-2 text-zinc-600">{p.confidence_notes.join(' · ')}</span> : null}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>

      {pick ? (
        <section aria-labelledby="pv-pick" className="border-t border-zinc-100 pt-4">
          <SectionTitle id="pv-pick">เข็มทิศเกม</SectionTitle>
          <p className="mt-2 text-xl font-semibold leading-tight text-zinc-950">{pick.label}</p>
          {pickNote ? <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-zinc-700">{pickNote}</p> : null}
          <a href="#pick" className="mt-1.5 inline-block text-sm text-zinc-500 underline underline-offset-2 hover:text-zinc-950">
            ดูเงื่อนไขและโอกาสของเข็มทิศเกม
          </a>
        </section>
      ) : null}
    </div>
  );
}

function SummaryRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="grid gap-1 py-2 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-3">
      <dt className="text-zinc-500">{k}</dt>
      <dd className="text-zinc-800">{v}</dd>
    </div>
  );
}

/**
 * preview-v0.8: four parts a fan reads in half a minute. The match and who has the edge, each side's
 * strength and worry, the model's numbers with what could change them, and the Game Compass (only
 * when there is a pick: fog is not shown on fan pages). The pick and its note come from the rules
 * engine and the pick-note job; this text never chooses one.
 */
function FourPartPreview({ p, home, away, teams, logos, pick, pickNote, limits, children }: { p: MatchPreview; home: string; away: string; teams?: { home: TeamContext; away: TeamContext }; logos?: { home: string | null; away: string | null }; pick?: { label: string } | null; pickNote?: string | null; limits: string[]; children: ReactNode }) {
  // what could change the picture, plus the data's own limits: one place for both
  const cautions = [p.key_factor_th, ...limits].filter((x): x is string => Boolean(x));

  return (
    <div className="space-y-5">
      <section aria-labelledby="pv-overview">
        <SectionTitle id="pv-overview">ภาพรวมเกม</SectionTitle>
        <p className="mt-2 max-w-prose text-base leading-7 text-zinc-800">{p.overview_th}</p>
      </section>

      <section aria-labelledby="pv-teams" className="border-t border-zinc-100 pt-4">
        <SectionTitle id="pv-teams">จุดแข็งและจุดเสี่ยง</SectionTitle>
        <TeamTexts p={p} home={home} away={away} teams={teams} logos={logos} className="mt-3" />
      </section>

      <section aria-labelledby="pv-model" className="border-t border-zinc-100 pt-4">
        <SectionTitle id="pv-model">สกอร์ที่โมเดลประเมิน</SectionTitle>
        <div className="mt-2">{children}</div>
        {cautions.length ? (
          <div className="mt-4">
            <p className="text-xs font-semibold text-zinc-950">ข้อควรระวัง</p>
            <ul className="mt-1.5 space-y-1.5 text-sm leading-relaxed text-zinc-700">
              {cautions.map((r) => (
                <li key={r} className="flex gap-2.5">
                  <span className="mt-[0.6em] h-px w-2.5 shrink-0 bg-zinc-300" aria-hidden />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {pick ? (
        <section aria-labelledby="pv-pick" className="border-t border-zinc-100 pt-4">
          <SectionTitle id="pv-pick">เข็มทิศเกม</SectionTitle>
          <p className="mt-2 text-xl font-semibold leading-tight text-zinc-950">{pick.label}</p>
          {pickNote ? <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-zinc-700">{pickNote}</p> : null}
          <a href="#pick" className="mt-1.5 inline-block text-sm text-zinc-500 underline underline-offset-2 hover:text-zinc-950">
            ดูเงื่อนไขและโอกาสของเข็มทิศเกม
          </a>
        </section>
      ) : null}
    </div>
  );
}

/**
 * preview-v0.7: the write-up in sections, after the layout the owner picked (overview with stat cards,
 * form with W/D/L chips, how the match may play out, the model's numbers, a closing line). Cards and
 * chips come from the database; the prose is the stored text. No winner is called here: the one view
 * of the match is the Game Compass above, which the model section points back to.
 */
function SectionedPreview({ p, home, away, teams, logos, pick, pickNote, limits, children }: { p: MatchPreview; home: string; away: string; teams?: { home: TeamContext; away: TeamContext }; logos?: { home: string | null; away: string | null }; pick?: { label: string } | null; pickNote?: string | null; limits: string[]; children: ReactNode }) {
  const play = [
    { k: 'เกมรุก', v: p.attack_th },
    { k: 'เกมรับ', v: p.defence_th },
    { k: 'เจอกันล่าสุด', v: p.h2h_th },
  ].filter((x): x is { k: string; v: string } => Boolean(x.v));
  // what could go wrong, plus the data's own limits: one place for both
  const risks = [p.key_factor_th, ...limits].filter((x): x is string => Boolean(x));

  return (
    <div className="space-y-5">
      <section aria-labelledby="pv-overview">
        <SectionTitle id="pv-overview">เกมนี้ใครดูดีกว่า?</SectionTitle>
        <p className="mt-2 max-w-prose text-base leading-7 text-zinc-800">{p.overview_th}</p>
      </section>

      <section aria-labelledby="pv-form" className="border-t border-zinc-100 pt-4">
        <SectionTitle id="pv-form">วิเคราะห์ทีมต่อทีม</SectionTitle>
        <TeamTexts p={p} home={home} away={away} teams={teams} logos={logos} className="mt-3" />
        {play.length ? (
          <ul className="mt-4 space-y-2 text-sm leading-relaxed text-zinc-700">
            {play.map((x) => (
              <li key={x.k} className="flex gap-2.5">
                <span className="mt-[0.6em] h-px w-2.5 shrink-0 bg-zinc-300" aria-hidden />
                <span>
                  <b className="font-semibold text-zinc-950">{x.k}</b> {x.v}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <section aria-labelledby="pv-model" className="border-t border-zinc-100 pt-4">
        <SectionTitle id="pv-model">รูปเกมและสกอร์ที่เป็นไปได้</SectionTitle>
        <div className="mt-2">{children}</div>
      </section>

      {pick ? (
        <section aria-labelledby="pv-pick" className="border-t border-zinc-100 pt-4">
          <SectionTitle id="pv-pick">ตัวเลือกที่น่าสนใจที่สุด</SectionTitle>
          <p className="mt-2 text-xl font-semibold leading-tight text-zinc-950">{pick.label}</p>
          {pickNote ? <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-zinc-700">{pickNote}</p> : null}
          <a href="#pick" className="mt-1.5 inline-block text-sm text-zinc-500 underline underline-offset-2 hover:text-zinc-950">
            ดูเหตุผลและเงื่อนไขของเข็มทิศเกม
          </a>
        </section>
      ) : null}

      {risks.length ? (
        <section aria-labelledby="pv-risk" className="border-t border-zinc-100 pt-4">
          <SectionTitle id="pv-risk">ความเสี่ยงและข้อจำกัด</SectionTitle>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-zinc-700">
            {risks.map((r) => (
              <li key={r} className="flex gap-2.5">
                <span className="mt-[0.6em] h-px w-2.5 shrink-0 bg-zinc-300" aria-hidden />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {p.summary_th ? (
        <p className="max-w-prose border-t border-zinc-100 pt-4 text-[15px] leading-7 text-zinc-800">
          <b className="font-semibold text-zinc-950">สรุป</b> {p.summary_th}
        </p>
      ) : null}
    </div>
  );
}

function SectionTitle({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="text-sm font-semibold text-zinc-950">
      {children}
    </h3>
  );
}

/** Each team's text side by side; with `teams`, its recent results as chips above the text. */
function TeamTexts({ p, home, away, teams, logos, className = '' }: { p: MatchPreview; home: string; away: string; teams?: { home: TeamContext; away: TeamContext }; logos?: { home: string | null; away: string | null }; className?: string }) {
  return (
    <div className={`grid gap-x-8 gap-y-5 sm:grid-cols-2 ${className}`}>
      {[
        { name: home, text: p.home_th, side: 'เจ้าบ้าน', logo: logos?.home ?? null, form: teams?.home.form ?? [] },
        { name: away, text: p.away_th, side: 'ทีมเยือน', logo: logos?.away ?? null, form: teams?.away.form ?? [] },
      ].map((t) => (
        <div key={t.side} className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            {logos ? <TeamLogo src={t.logo} alt="" size={24} /> : null}
            <span className="text-sm font-semibold text-zinc-950">{t.name}</span>
            <Badge variant="secondary">{t.side}</Badge>
          </p>
          {t.form.length ? <FormChips results={t.form} className="mt-2" /> : null}
          <p className="mt-1.5 text-sm leading-relaxed text-zinc-700">{t.text}</p>
        </div>
      ))}
    </div>
  );
}

const RESULT_TONE = {
  W: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  D: 'bg-zinc-50 text-zinc-700 ring-zinc-200',
  L: 'bg-rose-50 text-rose-800 ring-rose-200',
} as const;
const RESULT_TH = { W: 'ชนะ', D: 'เสมอ', L: 'แพ้' } as const;

/** W/D/L chips, oldest on the left and the latest match last, as on the form card. */
export function FormChips({ results, className = '' }: { results: Array<'W' | 'D' | 'L'>; className?: string }) {
  const ordered = [...results].reverse();
  return (
    <span className={`flex gap-1 ${className}`} role="img" aria-label={`ผล ${ordered.length} นัดล่าสุด จากเก่าไปใหม่: ${ordered.map((r) => RESULT_TH[r]).join(' ')}`}>
      {ordered.map((r, i) => (
        <span key={i} className={`inline-flex h-5 w-5 items-center justify-center rounded-[4px] text-[11px] font-semibold ring-1 ring-inset ${RESULT_TONE[r]}`} aria-hidden>
          {r}
        </span>
      ))}
    </span>
  );
}

/** The model's numbers: goal bands (or the single scoreline on rows before preview-v0.5) beside score_th. */
function ModelNumbers({ p, result, modelTested, pick, overInOutlook, fourPart = false }: { p: MatchPreview; result?: { home: number; away: number } | null; modelTested: boolean; pick?: { label: string; sel: MarketSelection } | null; overInOutlook: boolean; fourPart?: boolean }) {
  const hasScore = p.predicted_home != null && p.predicted_away != null;
  const ifScore = pick && hasScore ? (settle(pick.sel, Number(p.predicted_home), Number(p.predicted_away)) as Status) : null;
  const hit = result && hasScore ? (result.home === p.predicted_home && result.away === p.predicted_away ? 'ตรงสกอร์' : sameOutcome(result, p) ? 'ตรงผล' : 'ไม่ตรง') : null;
  const bands =
    p.p_goals_0_1 != null && p.p_goals_2 != null && p.p_goals_3plus != null
      ? [
          { key: 1, label: '0–1 ประตู', p: Number(p.p_goals_0_1) },
          { key: 2, label: '2 ประตู', p: Number(p.p_goals_2) },
          { key: 3, label: '3 ประตูขึ้นไป', p: Number(p.p_goals_3plus) },
        ]
      : null;
  const topBand = bands ? Math.max(...bands.map((b) => b.p)) : null;
  const resultBand = result ? Math.max(1, Math.min(3, result.home + result.away)) : null;

  return bands ? (
    <div className="grid gap-x-8 gap-y-3 sm:grid-cols-[15rem_minmax(0,1fr)]">
      <div>
        <p className="text-xs text-zinc-500">{fourPart ? 'โอกาสของจำนวนประตูรวม' : 'จำนวนประตูรวม'}</p>
        <dl className="mt-1 divide-y divide-zinc-100">
          {bands.map((b) => (
            <div key={b.key} className="flex items-center justify-between gap-3 py-1.5 text-sm">
              <dt className="flex min-w-0 items-center gap-2">
                <span className={b.p === topBand ? 'font-semibold text-zinc-950' : 'text-zinc-700'}>{b.label}</span>
                {resultBand === b.key ? <Badge variant="secondary">ผลจริง</Badge> : null}
              </dt>
              <dd className={`tabular-nums ${b.p === topBand ? 'font-semibold text-zinc-950' : 'text-zinc-600'}`}>{pct(b.p)}</dd>
            </div>
          ))}
        </dl>
        {hasScore ? (
          <div className="mt-3 border-t border-zinc-100 pt-3 text-xs leading-relaxed text-zinc-500">
            {fourPart ? (
              <p className="text-zinc-600">
                สกอร์ที่โมเดลให้โอกาสสูงสุด{' '}
                <b className="font-semibold tabular-nums text-zinc-950">
                  {p.predicted_home}–{p.predicted_away}
                </b>{' '}
                ({pct(p.predicted_p)})
              </p>
            ) : null}
            <ScoreDetails p={p} ifScore={ifScore} pick={pick} modelTested={modelTested} hit={hit} result={result} showXg={fourPart} />
          </div>
        ) : null}
      </div>
      <p className="max-w-prose text-sm leading-relaxed text-zinc-700 sm:pt-5">{p.score_th}</p>
    </div>
  ) : (
    <div className="grid gap-x-8 gap-y-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
      <div>
        <p className="text-xs text-zinc-500">สกอร์ที่เป็นไปได้มากที่สุด</p>
        {hasScore ? (
          <>
            <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-zinc-950">
              {p.predicted_home}–{p.predicted_away}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              โอกาส {pct(p.predicted_p)}
              {p.predicted_p != null ? ` · ยังมีสกอร์อื่นอีก ${pct(1 - Number(p.predicted_p))}` : ''}
            </p>
            <ScoreDetails p={p} ifScore={ifScore} pick={pick} modelTested={modelTested} hit={hit} result={result} />
          </>
        ) : (
          <p className="mt-1 text-sm text-zinc-600">ยังไม่มี — โมเดลมีข้อมูลไม่พอ</p>
        )}
      </div>
      <div className="max-w-prose space-y-2 text-sm leading-relaxed text-zinc-700 sm:pt-5">
        <p>{p.score_th}</p>
        {hasScore && overInOutlook ? (
          <p className="text-xs text-zinc-500">
            สกอร์เดียวที่สูงสุดมักเป็นสกอร์ต่ำ ส่วนโอกาสที่จะยิงรวม 3 ประตูขึ้นไป ดูได้ที่{' '}
            <a href="#model" className="underline underline-offset-2 hover:text-zinc-950">
              มุมมองโมเดล
            </a>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Under the scoreline: xG, what that score means for the pick, the measuring note, and the result once known. */
function ScoreDetails({ p, ifScore, pick, modelTested, hit, result, showXg = true }: { p: MatchPreview; ifScore: Status | null; pick?: { label: string } | null; modelTested: boolean; hit: string | null; result?: { home: number; away: number } | null; showXg?: boolean }) {
  return (
    <>
      {showXg && p.expected_home != null ? (
        <p className="mt-1 text-xs text-zinc-500">
          ประตูที่โมเดลคาด (xG) {Number(p.expected_home).toFixed(2)}–{Number(p.expected_away).toFixed(2)}
        </p>
      ) : null}
      {ifScore ? (
        <p className="mt-1 text-xs text-zinc-600">
          ถ้าจบ {p.predicted_home}–{p.predicted_away} เข็มทิศเกม {pick!.label} = <b className="font-semibold text-zinc-950">{STATUS[ifScore].label}</b>
        </p>
      ) : null}
      {modelTested ? null : <p className="mt-1 text-xs text-zinc-400">อยู่ระหว่างการวัดผล</p>}
      {hit ? (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
          ผลจริง <b className="tabular-nums text-zinc-950">{result!.home}–{result!.away}</b>
          <Badge variant={hit === 'ไม่ตรง' ? 'outline' : 'good'}>{hit}</Badge>
        </p>
      ) : null}
    </>
  );
}

function sameOutcome(r: { home: number; away: number }, p: MatchPreview): boolean {
  const sign = (a: number, b: number) => Math.sign(a - b);
  return sign(r.home, r.away) === sign(p.predicted_home!, p.predicted_away!);
}

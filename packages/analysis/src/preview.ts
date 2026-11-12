/**
 * 🔎 วิเคราะห์เกม — per-match preview, the deterministic half.
 *
 * Every number in a preview comes from here (model probabilities, expected goals, the most likely
 * scorelines, form, standings), never from the AI. This module also decides how much the data can
 * support an opinion (GOOD / LIMITED / THIN) and spells out WHY in Thai, e.g. a cross-league cup
 * with few cup matches, a team with little history, no xG for the competition. The AI (packages/ai)
 * only turns these facts into prose; when it is unavailable or its text fails the guards, the
 * template text built here is shown instead so every match still gets a write-up.
 */
import { noVig } from './candidates.js';
import { mixScoreMatrices } from './cross-league.js';
import { scoreMatrix } from './dixon-coles.js';
import { settle, type MarketSelection } from './settlement.js';

export const PREVIEW_VERSION = 'preview-v1.2';
export type PreviewStage = 'EARLY' | 'LINEUP';
export type DataSupport = 'GOOD' | 'LIMITED' | 'THIN';

export interface PreviewFormRow {
  venue: 'H' | 'A';
  result: 'W' | 'D' | 'L';
  goalsFor: number;
  goalsAgainst: number;
  xgFor: number | null;
  xgAgainst: number | null;
  opponent?: string | null;
  /** Thai calendar date (YYYY-MM-DD) */
  date?: string;
  competition?: string | null;
}

export interface VenueRecord {
  played: number | null;
  win: number | null;
  draw: number | null;
  lose: number | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
}

export interface PreviewStanding {
  rank: number | null;
  played: number | null;
  points: number | null;
  win: number | null;
  draw: number | null;
  lose: number | null;
  goalsFor: number | null;
  goalsAgainst: number | null;
  goalDiff?: number | null;
  /** the table zone as the data provider names it, e.g. "Promotion - Champions League (League phase)" */
  zone?: string | null;
  /** teams in the table (group) */
  teams?: number | null;
  home?: VenueRecord | null;
  away?: VenueRecord | null;
}

export interface KeyPlayer {
  name: string;
  goals: number;
  assists: number;
  appearances: number;
}

export interface PreviewTeam {
  name: string;
  form: PreviewFormRow[];
  /** totals over `form` — stated as facts so the text may quote them without doing arithmetic */
  formSummary: FormSummary | null;
  /** null when the team has not played in this table yet (a cup's first round): rank 30 with 0 played means nothing */
  standing: PreviewStanding | null;
  injuries: Array<{ player: string | null; type: string | null; reason: string | null; isKeyPlayer?: boolean; goals?: number | null; assists?: number | null }>;
  /** confirmed starting XI (names), null before the lineup is out */
  starters: string[] | null;
  /** time-weighted matches the model has for this team (Dixon-Coles `teamMatches`) */
  modelMatches: number | null;
  /** whole days since the team's last match (null without one) */
  restDays?: number | null;
  /** averages over the recent matches that have the statistic */
  averages?: { matches: number; shotsOnTarget: number | null; possession: number | null } | null;
  /** top players this season by goals + assists, every synced competition */
  keyPlayers?: KeyPlayer[];
  /** LINEUP stage only */
  lineup?: { formation: string | null; coach: string | null; keyPlayersNotStarting: string[] } | null;
}

export interface FormSummary {
  matches: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  /** averages over the matches that have xG */
  xgFor: number | null;
  xgAgainst: number | null;
}

export function formSummary(form: readonly PreviewFormRow[]): FormSummary | null {
  if (!form.length) return null;
  const xg = form.filter((r) => r.xgFor != null);
  const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
  return {
    matches: form.length,
    won: form.filter((r) => r.result === 'W').length,
    drawn: form.filter((r) => r.result === 'D').length,
    lost: form.filter((r) => r.result === 'L').length,
    goalsFor: form.reduce((a, r) => a + r.goalsFor, 0),
    goalsAgainst: form.reduce((a, r) => a + r.goalsAgainst, 0),
    xgFor: xg.length ? avg(xg.map((r) => r.xgFor!)) : null,
    xgAgainst: xg.length ? avg(xg.map((r) => r.xgAgainst ?? 0)) : null,
  };
}

/** Beyond this the gap is an off-season or a competition we do not sync, not rest: "พักมา 146 วัน" says nothing. */
const MAX_REST_DAYS = 14;

/** Whole days between the team's last match and this kickoff (null without a last match, or after a long gap). */
export function restDays(kickoffAt: Date, lastMatchAt: Date | null): number | null {
  if (!lastMatchAt) return null;
  const days = Math.floor((kickoffAt.getTime() - lastMatchAt.getTime()) / 86_400_000);
  return days <= MAX_REST_DAYS ? days : null;
}

/** Averages over the matches that have each statistic; null when no match has any. */
export function formAverages(rows: ReadonlyArray<{ shotsOnTarget: number | null; possession: number | null }>): PreviewTeam['averages'] {
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  const sot = rows.map((r) => r.shotsOnTarget).filter((x): x is number => x != null);
  const pos = rows.map((r) => r.possession).filter((x): x is number => x != null);
  const matches = Math.max(sot.length, pos.length);
  return matches ? { matches, shotsOnTarget: avg(sot), possession: avg(pos) } : null;
}

export interface PreviewModel {
  modelVersionId: string;
  computedAt: string;
  /** 1X2: the sides model (or the ensemble), as the model outlook card shows it */
  p: { home: number; draw: number; away: number };
  /** from the totals matrix since preview-v0.8, the one behind the outlook's over 2.5 and the goal bands */
  expectedGoals: { home: number; away: number };
  /** most likely scorelines of the same matrix as expectedGoals, best first */
  scorelines: Array<{ home: number; away: number; p: number }>;
  matchesUsed: number;
  xgShare: number;
  crossLeague: { cupMatchesUsed: number } | null;
  /** the league's 1X2 model passed its back-test (model:tune); false = still being measured */
  tested?: boolean;
  /** preview-v1.2: chance of 3 or more goals from the same matrix (goalBands.threePlus), set by the preview job only */
  pGoals3plus?: number | null;
}

/** The side the write-up is built around (preview-v1.0): the model's lean, or the home side when it is even. */
export interface PreviewFocus {
  mainSide: 'HOME' | 'AWAY';
  main: string;
  opponent: string;
}

export interface PreviewFacts {
  fixture: {
    home: string;
    away: string;
    league: string;
    leagueCountry: string | null;
    leagueType: string | null;
    round: string | null;
    kickoffAt: string;
    /** preview-v1.2: the kickoff in Thai words and Thai time (thaiKickoff), for the lead to copy */
    kickoffTh?: string;
    stage: PreviewStage;
    venue?: { name: string; city: string | null } | null;
    referee?: string | null;
  };
  home: PreviewTeam;
  away: PreviewTeam;
  model: PreviewModel | null;
  /** 1X2 consensus (median across bookmakers) */
  market: { home: MarketQuote | null; draw: MarketQuote | null; away: MarketQuote | null } | null;
  apiPrediction: { homePct: number | null; drawPct: number | null; awayPct: number | null; advice: string | null } | null;
  h2h: Array<{ kickoffAt: string; home: string; away: string; homeGoals: number; awayGoals: number }>;
  /** which way each source leans and where they disagree with the model (preview-v0.8; see compareViews) */
  views?: PreviewViews | null;
  /** preview-v1.0: the main side and its opponent (see previewFocus) */
  focus?: PreviewFocus | null;
}

export interface MarketQuote {
  opening: number;
  current: number;
  bookmakers: number;
}

/**
 * The write-up (preview-v1.2), in the shape of the khemthit-football-writer brief (owner, 2026-11-13):
 * a headline and a lead that opens on the match's story and says when and where (overview_th, also the
 * teaser on match lists), one short paragraph per side (home_th, away_th: how it is doing, two or three
 * numbers, the players to watch, confirmed absences), how the model and the market see it (analysis_th,
 * empty when neither has numbers) and a closing line on what to watch (summary_th). The parts the
 * system builds itself sit around these on the page: what is not known yet (dataGaps), the game summary
 * with its rules-based confidence, and the Game Compass with its win conditions.
 */
export interface PreviewText {
  headline_th: string;
  overview_th: string;
  home_th: string;
  away_th: string;
  analysis_th: string;
  summary_th: string;
}

const TH_DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/** "วันศุกร์ที่ 13 พ.ย. เวลา 02:45 น. (เวลาไทย)": Thai time, written out so the writer copies it rather than converting a timestamp. */
export function thaiKickoff(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 7 * 3_600_000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `วัน${TH_DAYS[d.getUTCDay()]}ที่ ${d.getUTCDate()} ${TH_MONTHS[d.getUTCMonth()]} เวลา ${hh}:${mm} น. (เวลาไทย)`;
}

export function previewFocus(f: PreviewFacts, views: PreviewViews | null = f.views ?? null): PreviewFocus {
  const away = views?.model === f.fixture.away;
  return away ? { mainSide: 'AWAY', main: f.fixture.away, opponent: f.fixture.home } : { mainSide: 'HOME', main: f.fixture.home, opponent: f.fixture.away };
}

// ---------------------------------------------------------------------------
// Views: where the model, the market and recent form point
// ---------------------------------------------------------------------------

/** A team name, or EVEN when the source does not lean either way. */
export type Lean = string;

export interface PreviewViews {
  /** null without the source */
  model: Lean | null;
  market: Lean | null;
  /** points per match over the recent results */
  recentForm: Lean | null;
  /** xG for minus xG against per match over the recent results */
  recentXg: Lean | null;
  /** the second rating model (Elo) beside the main one */
  otherModel: Lean | null;
  /** the market's 1X2 chances with the margin taken out (current consensus) */
  marketP: { home: number; draw: number; away: number } | null;
  /**
   * Where a source points the other way from the model, or the market's chance of the model's side
   * is far from the model's. The write-up has to say so (validatePreviewOutput).
   */
  disagreements: Disagreement[];
}

export type Disagreement = 'MARKET' | 'MARKET_GAP' | 'FORM' | 'XG' | 'OTHER_MODEL';

export const EVEN = 'EVEN';
/** below these gaps a source counts as not leaning */
const LEAN_P = 0.1;
const LEAN_PPG = 0.5;
const LEAN_XG = 0.3;
/** model vs market chance of the model's side, beyond which the gap itself is a disagreement */
const MARKET_GAP = 0.15;

const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/**
 * Which way each source leans, from facts already in the preview. Deterministic, so the guards can
 * hold the write-up to it: a model lean that the market or recent form contradicts must be said.
 */
export function compareViews(f: PreviewFacts, otherModel: { home: number; away: number } | null = null): PreviewViews {
  const { home, away } = f.fixture;
  const lean = (h: number, a: number, min: number): Lean => (Math.abs(h - a) < min ? EVEN : h > a ? home : away);
  const q = f.market;
  let marketP: PreviewViews['marketP'] = null;
  if (q?.home && q.draw && q.away) {
    const [h, d, a] = noVig([q.home.current, q.draw.current, q.away.current]);
    marketP = { home: r4(h!), draw: r4(d!), away: r4(a!) };
  }
  const summary = (t: PreviewTeam) => t.formSummary ?? formSummary(t.form);
  const ppg = (t: PreviewTeam) => {
    const s = summary(t);
    return s ? (3 * s.won + s.drawn) / s.matches : null;
  };
  const xgDiff = (t: PreviewTeam) => {
    const s = summary(t);
    return s?.xgFor != null && s.xgAgainst != null ? s.xgFor - s.xgAgainst : null;
  };
  const [ph, pa, xh, xa] = [ppg(f.home), ppg(f.away), xgDiff(f.home), xgDiff(f.away)];

  const views: PreviewViews = {
    model: f.model ? lean(f.model.p.home, f.model.p.away, LEAN_P) : null,
    market: marketP ? lean(marketP.home, marketP.away, LEAN_P) : null,
    recentForm: ph != null && pa != null ? lean(ph, pa, LEAN_PPG) : null,
    recentXg: xh != null && xa != null ? lean(xh, xa, LEAN_XG) : null,
    otherModel: otherModel ? lean(otherModel.home, otherModel.away, LEAN_P) : null,
    marketP,
    disagreements: [],
  };
  const m = views.model;
  if (f.model && m && m !== EVEN) {
    const against = (v: Lean | null) => v != null && v !== EVEN && v !== m;
    const side = m === home ? 'home' : 'away';
    if (against(views.market)) views.disagreements.push('MARKET');
    else if (marketP && Math.abs(f.model.p[side] - marketP[side]) >= MARKET_GAP) views.disagreements.push('MARKET_GAP');
    if (against(views.recentForm)) views.disagreements.push('FORM');
    if (against(views.recentXg)) views.disagreements.push('XG');
    if (against(views.otherModel)) views.disagreements.push('OTHER_MODEL');
  }
  return views;
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

/**
 * EARLY once the match is within `hoursAhead` of kickoff; LINEUP once the XIs are confirmed
 * (≤ 80 min before kickoff). Nothing within the last 15 minutes: previews are pre-match content.
 */
export function previewStageFor(kickoffAt: Date, now: Date, hasLineups: boolean, opts: { hoursAhead?: number } = {}): PreviewStage | null {
  const minutes = (kickoffAt.getTime() - now.getTime()) / 60_000;
  if (minutes < 15) return null;
  if (hasLineups && minutes <= 80) return 'LINEUP';
  if (minutes <= (opts.hoursAhead ?? 48) * 60) return 'EARLY';
  return null;
}

// ---------------------------------------------------------------------------
// Model: scorelines from the same score matrix the Probability Engine used
// ---------------------------------------------------------------------------

export interface ScoreMatrixInputs {
  lambda: number;
  mu: number;
  rho: number;
  /** cross-league cup: blend the cup-only matrix with the cross-league one (same as computeProbabilities) */
  crossLeague?: { lambda: number; mu: number; weightCupOnly: number } | null;
}

export function previewScoreMatrix(i: ScoreMatrixInputs): number[][] {
  const cupOnly = scoreMatrix(i.lambda, i.mu, i.rho);
  return i.crossLeague ? mixScoreMatrices(cupOnly, scoreMatrix(i.crossLeague.lambda, i.crossLeague.mu, i.rho), i.crossLeague.weightCupOnly) : cupOnly;
}

/**
 * The pick-consistent scoreline: the most likely score of the matrix among those on which the pick wins
 * outright. Only when no score wins outright does a half win, then a push, count. Same tie-break as
 * topScorelines. `p` is the score's own chance in the matrix, not conditional on the pick.
 */
export function pickScoreline(matrix: number[][], sel: MarketSelection): { home: number; away: number; p: number } | null {
  for (const want of ['WIN', 'HALF_WIN', 'PUSH'] as const) {
    let best: { home: number; away: number; p: number } | null = null;
    matrix.forEach((row, home) =>
      row.forEach((p, away) => {
        if (!(p > 0) || settle(sel, home, away) !== want) return;
        if (!best || p > best.p || (p === best.p && home + away < best.home + best.away)) best = { home, away, p };
      }),
    );
    if (best) return best;
  }
  return null;
}

/** Most likely scorelines, best first. */
export function topScorelines(matrix: number[][], n = 3): Array<{ home: number; away: number; p: number }> {
  const all: Array<{ home: number; away: number; p: number }> = [];
  matrix.forEach((row, home) => row.forEach((p, away) => all.push({ home, away, p })));
  return all.sort((a, b) => b.p - a.p || a.home + a.away - (b.home + b.away)).slice(0, n);
}

/** Chance of each goal band (total goals 0–1, 2, 3+); 3+ is over 2.5 of the same matrix. */
export interface GoalBands {
  upTo1: number;
  two: number;
  threePlus: number;
}

/**
 * Goal bands of the blended matrix, stored with the preview for the card. From preview-v1.2 the writer
 * also gets 3+ (the brief asks for it), as a chance of at least 3 goals: the over/under words stay banned,
 * since the AI once wrote this figure up as an over lean.
 */
export function goalBands(matrix: number[][]): GoalBands {
  const sum = [0, 0, 0];
  matrix.forEach((row, h) => row.forEach((p, a) => {
    const goals = h + a;
    sum[goals <= 1 ? 0 : goals === 2 ? 1 : 2]! += p;
  }));
  const total = sum[0]! + sum[1]! + sum[2]!;
  return { upTo1: sum[0]! / total, two: sum[1]! / total, threePlus: sum[2]! / total };
}

/** Expected goals of the blended matrix (= what the scorelines are drawn from). */
export function matrixExpectedGoals(matrix: number[][]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  matrix.forEach((row, h) => row.forEach((p, a) => {
    home += h * p;
    away += a * p;
  }));
  return { home, away };
}

// ---------------------------------------------------------------------------
// Data support
// ---------------------------------------------------------------------------

const MIN_TEAM_MODEL_MATCHES = 6;
const FEW_CUP_MATCHES = 60;

/**
 * How far the data can carry an opinion, with the reasons in Thai. Severity is the worst note:
 *  THIN    — no model, or the model sees very little of these teams (e.g. a cross-league cup early on)
 *  LIMITED — the model exists but is short on history for one team / blind to xG
 *  (whether the model passed `model:tune` is not a data gap: fan pages gate model numbers on it instead)
 *  GOOD    — everything the preview normally uses is present
 * Gaps that do not limit the analysis (no odds, no injury report, no H2H) are not noted: they read as
 * "the data is not ready" on the fan page (owner, 2026-10-15). The prompt keeps the AI from filling them in.
 */
export function assessDataSupport(f: PreviewFacts): { level: DataSupport; notes: string[] } {
  const notes: Array<{ level: DataSupport; text: string }> = [];
  const add = (level: DataSupport, text: string) => notes.push({ level, text });
  const m = f.model;
  const crossLeague = Boolean(m?.crossLeague);
  const internationalCup = !crossLeague && f.fixture.leagueType === 'Cup' && f.fixture.leagueCountry === 'World';

  if (!m) {
    add('THIN', 'ยังไม่มีตัวเลขจากโมเดลสำหรับคู่นี้ — รายการนี้มีนัดที่จบแล้วในฐานข้อมูลน้อยเกินไป');
  } else {
    if (m.crossLeague) {
      // cupMatchesUsed counts every past match of the competition, all seasons: hundreds is normal, and
      // "มีเพียง 900 นัด" (Liverpool–Villarreal, 2026-10-18) read as a gap that is not there
      const n = m.crossLeague.cupMatchesUsed;
      if (n < FEW_CUP_MATCHES) {
        add('THIN', `เป็นบอลถ้วยที่ทีมมาจากคนละลีก และนัดในถ้วยที่ใช้คำนวณมีเพียง ${n} นัด โมเดลจึงอาศัยผลงานในลีกของแต่ละทีมเป็นหลัก`);
      } else {
        add('LIMITED', 'เป็นบอลถ้วยที่ทีมมาจากคนละลีก โมเดลต้องเทียบความแข็งของแต่ละลีกก่อนเทียบทีม ตัวเลขจึงไม่แม่นเท่าคู่ที่อยู่ลีกเดียวกัน');
      }
    } else if (internationalCup) {
      add(
        m.matchesUsed < FEW_CUP_MATCHES ? 'THIN' : 'LIMITED',
        `เป็นบอลถ้วยระหว่างประเทศ ทีมมาจากคนละลีก โมเดลเห็นเฉพาะนัดในรายการนี้ (${m.matchesUsed} นัด) ไม่ได้เห็นฟอร์มในลีกของแต่ละทีม`,
      );
    }
    const low = [f.home, f.away].filter((t) => t.modelMatches != null && t.modelMatches < MIN_TEAM_MODEL_MATCHES);
    for (const t of low) add(low.length === 2 ? 'THIN' : 'LIMITED', `${t.name} มีผลงานในฐานข้อมูลของรายการนี้น้อย (น้ำหนักประมาณ ${Math.round(t.modelMatches!)} นัด) ตัวเลขของโมเดลจึงเอนเข้าหาค่าเฉลี่ยของลีก`);
  }

  for (const t of [f.home, f.away]) {
    if (t.form.length === 0) add('THIN', `${t.name} ไม่มีผลการแข่งขันล่าสุดในระบบ`);
    else if (t.form.length < 5) add('LIMITED', `${t.name} มีผลการแข่งขันล่าสุดในระบบเพียง ${t.form.length} นัด`);
  }
  const anyXg = [...f.home.form, ...f.away.form].some((r) => r.xgFor != null);
  if (!anyXg && (f.home.form.length || f.away.form.length)) add('LIMITED', 'ไม่มีข้อมูล xG ของรายการนี้ ประเมินจากประตูจริงเท่านั้น');

  const level: DataSupport = notes.some((n) => n.level === 'THIN') ? 'THIN' : notes.some((n) => n.level === 'LIMITED') ? 'LIMITED' : 'GOOD';
  return { level, notes: notes.map((n) => n.text) };
}

/**
 * What the page does not have yet, apart from the support level: none of these limits the model, so
 * none lowers the level (owner, 2026-10-15), but readers see them in one quiet line (owner, 2026-10-20).
 * An empty injury list means the provider reported nobody, not that nobody is injured.
 */
export function dataGaps(g: { h2hMatches: number; lineupsOut: boolean; injuryReports: number; pickLinePriced?: boolean | null }): string[] {
  const out: string[] = [];
  if (g.h2hMatches === 0) out.push('ไม่มีประวัติพบกันในฐานข้อมูลของเรา');
  if (!g.lineupsOut) out.push('ยังไม่ประกาศตัวจริง');
  if (g.injuryReports === 0) out.push('แหล่งข้อมูลไม่มีรายงานผู้เล่นบาดเจ็บ ซึ่งไม่ได้แปลว่าไม่มีใครเจ็บ');
  if (g.pickLinePriced === false) out.push('ราคาล่าสุดไม่มีเส้นของเข็มทิศเกมครบทั้งสองฝั่ง');
  return out;
}

export const DATA_SUPPORT_TH: Record<DataSupport, string> = {
  GOOD: 'ข้อมูลเพียงพอ',
  LIMITED: 'ข้อมูลจำกัด',
  THIN: 'ข้อมูลน้อย',
};

// ---------------------------------------------------------------------------
// Confidence (preview-v1.0): fixed rules over the data, never the AI's call
// ---------------------------------------------------------------------------

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';
export const CONFIDENCE_TH: Record<Confidence, string> = { LOW: 'ต่ำ', MEDIUM: 'ปานกลาง', HIGH: 'สูง' };
/** below this gap between the model's two sides the lean is only slight */
const CLEAR_LEAN = 0.2;

/**
 * How far the summary can be trusted, with the reasons in Thai. LOW when the model has no numbers,
 * the data is thin, the league's model is still being measured or the market favours the other side.
 * MEDIUM when the data is limited, the lean is slight, or form, xG, the market's size of the gap or
 * the second model point elsewhere. HIGH only when none of these holds. Never a percentage.
 */
export function confidenceLevel(f: PreviewFacts, support: { level: DataSupport }): { level: Confidence; notes: string[] } {
  const m = f.model;
  if (!m) return { level: 'LOW', notes: ['โมเดลยังไม่มีตัวเลขสำหรับคู่นี้'] };
  const v = f.views ?? compareViews(f);
  const low: string[] = [];
  if (support.level === 'THIN') low.push('ข้อมูลของคู่นี้มีน้อย');
  if (m.tested === false) low.push('โมเดลยังอยู่ระหว่างการวัดผลในรายการนี้');
  if (v.disagreements.includes('MARKET')) low.push('ตลาดให้น้ำหนักอีกฝั่ง');
  if (low.length) return { level: 'LOW', notes: low };

  const medium: string[] = [];
  if (support.level === 'LIMITED') medium.push('ข้อมูลบางส่วนจำกัด');
  if (v.model === EVEN) medium.push('ตัวเลขของโมเดลสูสี');
  else if (Math.abs(m.p.home - m.p.away) < CLEAR_LEAN) medium.push('โมเดลเอนเพียงเล็กน้อย');
  if (v.disagreements.includes('MARKET_GAP')) medium.push('ตลาดเห็นทางเดียวกันแต่ให้โอกาสน้อยกว่าโมเดลมาก');
  if (v.disagreements.includes('FORM') || v.disagreements.includes('XG')) medium.push('ผลงานช่วงหลังสวนกับตัวเลขของโมเดล');
  if (v.disagreements.includes('OTHER_MODEL')) medium.push('โมเดลอีกตัวของเรามองต่าง');
  if (medium.length) return { level: 'MEDIUM', notes: medium };
  return { level: 'HIGH', notes: ['ข้อมูลเพียงพอ โมเดลผ่านการทดสอบ และตลาดกับผลงานช่วงหลังชี้ไปทางเดียวกัน'] };
}

/** Chance that both teams score, from the same matrix as the goal bands. */
export function bothTeamsScore(matrix: number[][]): number {
  let both = 0;
  let total = 0;
  matrix.forEach((row, h) => row.forEach((p, a) => {
    total += p;
    if (h > 0 && a > 0) both += p;
  }));
  return total > 0 ? both / total : 0;
}

// ---------------------------------------------------------------------------
// Template text (fallback when the AI is unavailable or fails the guards)
// ---------------------------------------------------------------------------

const pct = (x: number) => `${Math.round(x * 100)}%`;
const n2 = (x: number) => x.toFixed(2);

/** The data's own limits are listed beside the write-up on the page, so the template does not repeat them. */
export function buildTemplateText(f: PreviewFacts, _support: { level: DataSupport; notes: string[] }): PreviewText {
  const { home, away, league, round } = f.fixture;
  const m = f.model;
  const views = f.views ?? compareViews(f);
  const where = `${league}${round ? ` ${round}` : ''}`;
  const when = f.fixture.kickoffTh ?? thaiKickoff(f.fixture.kickoffAt);
  const venue = f.fixture.venue?.name ? ` ที่ ${f.fixture.venue.name}` : '';
  const last = f.h2h[0];

  // the story the data tells first: the last meeting, else the table, else the plain fixture
  const headline = last ? `${home} พบ ${away} อีกครั้ง หลังเกมล่าสุดจบ ${last.homeGoals}-${last.awayGoals}` : `${home} พบ ${away} ใน ${league}`;
  const overview = `${last ? `เกมล่าสุดที่เจอกัน ${last.home} ${last.homeGoals}-${last.awayGoals} ${last.away} ` : ''}${home} พบ ${away} ใน ${where} ${when}${venue}`;

  let analysis = '';
  if (m) {
    analysis = `โมเดลให้ ${home} ชนะ ${pct(m.p.home)} เสมอ ${pct(m.p.draw)} ${away} ชนะ ${pct(m.p.away)}`;
    if (views.marketP) {
      const side = views.model === away ? 'away' : 'home';
      if (views.disagreements.includes('MARKET')) analysis += ` ส่วนตลาดให้น้ำหนัก ${views.market} มากกว่า (${home} ${pct(views.marketP.home)} ${away} ${pct(views.marketP.away)})`;
      else if (views.disagreements.includes('MARKET_GAP')) analysis += ` ตลาดมองไปทางเดียวกันแต่ให้ ${side === 'home' ? home : away} เพียง ${pct(views.marketP[side])} จึงเผื่อโอกาสพลิกไว้มากกว่า`;
      else analysis += ' และตลาดมองไปทางเดียวกัน';
    }
    if (m.pGoals3plus != null) analysis += ` โมเดลให้โอกาส ${pct(m.pGoals3plus)} ที่เกมนี้จะมีอย่างน้อย 3 ประตู`;
  } else if (views.marketP) {
    analysis = `ตลาดให้ ${home} ชนะ ${pct(views.marketP.home)} เสมอ ${pct(views.marketP.draw)} ${away} ชนะ ${pct(views.marketP.away)}`;
  }

  return {
    headline_th: headline,
    overview_th: overview,
    home_th: `${attackText(f.home)} · ${defenceText(f.home, 'home').replace(`${home}: `, '')}${absenceText(f.home)}`,
    away_th: `${attackText(f.away)} · ${defenceText(f.away, 'away').replace(`${away}: `, '')}${absenceText(f.away)}`,
    analysis_th: analysis,
    summary_th: closingText(f, views),
  };
}

/** A side's confirmed absences (up to three names), as a clause for its paragraph. */
function absenceText(t: PreviewTeam): string {
  if (!t.injuries.length) return '';
  const names = t.injuries.map((i) => i.player).filter(Boolean).slice(0, 3).join(', ');
  return ` · มีรายงานตัวเจ็บ/ติดโทษ ${t.injuries.length} คน${names ? ` (${names})` : ''}`;
}

/** The closing line: what to watch, from the model's lean; never a caveat about the data. */
function closingText(f: PreviewFacts, views: PreviewViews): string {
  const { home, away } = f.fixture;
  const lean = views.model ?? views.market;
  if (!lean || lean === EVEN) return `ตัวเลขของ ${home} กับ ${away} ใกล้กัน เกมนี้น่าจะตัดสินกันที่ใครใช้โอกาสได้คุ้มกว่า`;
  const other = lean === home ? away : home;
  return `ตัวเลขเอียงไปทาง ${lean} สิ่งที่ต้องดูคือ ${other} จะหยุดเกมรุกของ ${lean} ได้แค่ไหน`;
}

function attackText(t: PreviewTeam): string {
  const parts: string[] = [];
  const s = t.formSummary ?? formSummary(t.form);
  if (s) {
    parts.push(`${s.matches} นัดล่าสุด ชนะ ${s.won} เสมอ ${s.drawn} แพ้ ${s.lost} ยิงได้ ${s.goalsFor} ประตู`);
    if (s.xgFor != null) parts.push(`xG เฉลี่ย ${n2(s.xgFor)}`);
  } else {
    parts.push('ไม่มีผลการแข่งขันล่าสุดในระบบ');
  }
  if (t.averages?.shotsOnTarget != null) parts.push(`ยิงเข้ากรอบเฉลี่ย ${t.averages.shotsOnTarget} ครั้ง`);
  const top = t.keyPlayers?.[0];
  if (top) parts.push(`ตัวหลักเกมรุก ${top.name} (${top.goals} ประตู ${top.assists} แอสซิสต์)`);
  if (t.starters?.length) parts.push('ประกาศตัวจริงแล้ว');
  return `${t.name}: ${parts.join(' · ')}`;
}

function defenceText(t: PreviewTeam, where: 'home' | 'away'): string {
  const parts: string[] = [];
  const s = t.formSummary ?? formSummary(t.form);
  if (s) {
    parts.push(`เสีย ${s.goalsAgainst} ประตูใน ${s.matches} นัดล่าสุด`);
    if (s.xgAgainst != null) parts.push(`xG เสียเฉลี่ย ${n2(s.xgAgainst)}`);
  }
  const v = t.standing?.[where];
  if (v?.played) parts.push(`${where === 'home' ? 'ในบ้าน' : 'นอกบ้าน'}เสีย ${v.goalsAgainst} ประตูจาก ${v.played} นัด`);
  // absences follow in absenceText
  if (t.restDays != null) parts.push(`พักมา ${t.restDays} วัน`);
  return `${t.name}: ${parts.length ? parts.join(' · ') : 'ไม่มีข้อมูลเกมรับล่าสุดในระบบ'}`;
}

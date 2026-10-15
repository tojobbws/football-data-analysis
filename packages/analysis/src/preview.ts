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
import { mixScoreMatrices } from './cross-league.js';
import { scoreMatrix } from './dixon-coles.js';

export const PREVIEW_VERSION = 'preview-v0.6';
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
}

export interface PreviewTeam {
  name: string;
  form: PreviewFormRow[];
  /** totals over `form` — stated as facts so the text may quote them without doing arithmetic */
  formSummary: FormSummary | null;
  standing: { rank: number | null; played: number | null; points: number | null; win: number | null; draw: number | null; lose: number | null; goalsFor: number | null; goalsAgainst: number | null } | null;
  injuries: Array<{ player: string | null; type: string | null; reason: string | null }>;
  /** confirmed starting XI (names), null before the lineup is out */
  starters: string[] | null;
  /** time-weighted matches the model has for this team (Dixon-Coles `teamMatches`) */
  modelMatches: number | null;
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

export interface PreviewModel {
  modelVersionId: string;
  computedAt: string;
  p: { home: number; draw: number; away: number };
  expectedGoals: { home: number; away: number };
  /** most likely scorelines, best first */
  scorelines: Array<{ home: number; away: number; p: number }>;
  matchesUsed: number;
  xgShare: number;
  crossLeague: { cupMatchesUsed: number } | null;
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
    stage: PreviewStage;
  };
  home: PreviewTeam;
  away: PreviewTeam;
  model: PreviewModel | null;
  /** 1X2 consensus (median across bookmakers) */
  market: { home: MarketQuote | null; draw: MarketQuote | null; away: MarketQuote | null } | null;
  apiPrediction: { homePct: number | null; drawPct: number | null; awayPct: number | null; advice: string | null } | null;
  h2h: Array<{ kickoffAt: string; home: string; away: string; homeGoals: number; awayGoals: number }>;
}

export interface MarketQuote {
  opening: number;
  current: number;
  bookmakers: number;
}

export interface PreviewText {
  overview_th: string;
  home_th: string;
  away_th: string;
  score_th: string;
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
 * Goal bands of the blended matrix. Stored with the preview for the card only, never put in the
 * facts the AI sees: 3+ is the over 2.5 figure, which the AI once wrote up as an over lean.
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
      const few = m.crossLeague.cupMatchesUsed < FEW_CUP_MATCHES;
      add(
        few ? 'THIN' : 'LIMITED',
        `เป็นบอลถ้วยที่ทีมมาจากคนละลีก นัดในถ้วยที่ใช้คำนวณมีเพียง ${m.crossLeague.cupMatchesUsed} นัด โมเดลจึงอาศัยผลงานในลีกของแต่ละทีมมาเทียบกัน ทำให้ข้อมูลที่เปรียบเทียบกันได้ตรง ๆ มีน้อย`,
      );
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

export const DATA_SUPPORT_TH: Record<DataSupport, string> = {
  GOOD: 'ข้อมูลครบ',
  LIMITED: 'ข้อมูลจำกัด',
  THIN: 'ข้อมูลน้อย',
};

// ---------------------------------------------------------------------------
// Template text (fallback when the AI is unavailable or fails the guards)
// ---------------------------------------------------------------------------

const pct = (x: number) => `${Math.round(x * 100)}%`;
const n2 = (x: number) => x.toFixed(2);

export function buildTemplateText(f: PreviewFacts, support: { level: DataSupport; notes: string[] }): PreviewText {
  const { home, away, league, round } = f.fixture;
  const m = f.model;
  const where = `${league}${round ? ` ${round}` : ''}`;

  let overview = `${home} พบ ${away} ใน ${where}`;
  if (m) {
    const fav = m.p.home > m.p.away ? home : away;
    const gap = Math.abs(m.p.home - m.p.away);
    overview += ` โมเดลให้ ${home} ชนะ ${pct(m.p.home)} เสมอ ${pct(m.p.draw)} ${away} ชนะ ${pct(m.p.away)}`;
    overview += gap < 0.1 ? ' — เป็นเกมที่สูสีตามตัวเลข' : ` — ตัวเลขเอียงไปทาง ${fav}`;
    if (f.market?.home && f.market.away) {
      const mkt = f.market.home.current < f.market.away.current ? home : away;
      overview += mkt === fav ? ' และตลาดมองไปทางเดียวกัน' : ` ขณะที่ตลาดให้น้ำหนัก ${mkt} มากกว่า`;
    }
  } else {
    overview += ' โมเดลยังไม่มีตัวเลขสำหรับคู่นี้ จึงอ่านเกมจากฟอร์มและสถิติที่มีเท่านั้น';
  }
  if (support.level !== 'GOOD') overview += ` (${DATA_SUPPORT_TH[support.level]}: ${support.notes[0]})`;

  const score = m
    ? (() => {
        const [best, ...rest] = m.scorelines;
        if (!best) return 'โมเดลยังไม่มีสกอร์ที่เป็นไปได้มากที่สุด';
        let s = `สกอร์ที่โมเดลให้โอกาสสูงสุดคือ ${home} ${best.home}-${best.away} ${away} (${pct(best.p)})`;
        if (rest.length) s += ` รองลงมา ${rest.map((r) => `${r.home}-${r.away} (${pct(r.p)})`).join(' และ ')}`;
        s += ` ประตูคาดหวัง ${n2(m.expectedGoals.home)} ต่อ ${n2(m.expectedGoals.away)}`;
        return s;
      })()
    : 'ยังไม่มีสกอร์ที่เป็นไปได้มากที่สุด เพราะโมเดลไม่มีข้อมูลพอสำหรับรายการนี้';

  return { overview_th: overview, home_th: teamText(f.home), away_th: teamText(f.away), score_th: score };
}

function teamText(t: PreviewTeam): string {
  const parts: string[] = [];
  const s = t.formSummary ?? formSummary(t.form);
  if (s) {
    parts.push(`${s.matches} นัดล่าสุด ชนะ ${s.won} เสมอ ${s.drawn} แพ้ ${s.lost} ยิงได้ ${s.goalsFor} เสีย ${s.goalsAgainst}`);
    if (s.xgFor != null) parts.push(`xG เฉลี่ย ${n2(s.xgFor)} เสีย ${n2(s.xgAgainst ?? 0)}`);
  } else {
    parts.push('ไม่มีผลการแข่งขันล่าสุดในระบบ');
  }
  if (t.standing?.rank != null) parts.push(`อยู่อันดับ ${t.standing.rank}${t.standing.points != null ? ` (${t.standing.points} แต้ม)` : ''}`);
  if (t.injuries.length) {
    const names = t.injuries.map((i) => i.player).filter(Boolean).slice(0, 3).join(', ');
    parts.push(`มีรายงานตัวเจ็บ/ติดโทษ ${t.injuries.length} คน${names ? ` (${names})` : ''}`);
  }
  if (t.starters?.length) parts.push('ประกาศตัวจริงแล้ว');
  return `${t.name}: ${parts.join(' · ')}`;
}

/**
 * Phase 6 — formatting for published analysis (deterministic, data-only Thai text).
 * No LLM here: every sentence is built from stored numbers, so the published reason
 * can never contain a claim the data does not support. (AI wording = Phase 6b.)
 */

export type PublishRound = 'EARLY' | 'PREMATCH' | 'LINEUP';

export const BRAND = {
  SIGNAL: '🧭 เข็มทิศเกม',
  NO_SIGNAL: '🌫️ หมอกข้อมูล',
  AGREE: '🤝 เสียงตรงกัน',
  IMPACT: '🩹 ตัวขาด',
  MARKET: '📈 แรงตลาด',
} as const;

const STRENGTH_TH: Record<string, string> = { STRONG: 'STRONG (ข้อมูลหนักแน่น)', MEDIUM: 'MEDIUM', LEAN: 'LEAN (สัญญาณอ่อน)' };

export const REASON_TH: Record<string, string> = {
  TOO_CLOSE_TO_KICKOFF: 'ใกล้เวลาแข่งเกินไป',
  LOW_TEAM_DATA: 'ข้อมูลของทีมยังน้อยเกินไป',
  MAJOR_ABSENCE_UNMODELLED: 'มีผู้เล่นหลักขาดที่โมเดลยังประเมินผลกระทบไม่ได้',
  MARKET_NOT_PICKABLE: 'เข็มทิศเกมเลือกเฉพาะแฮนดิแคปและสูง/ต่ำ',
  MARKET_GATED_OFF: 'โมเดลยังไม่ผ่านการทดสอบย้อนหลังในตลาด/ลีกนี้',
  NO_MODEL_PRICE: 'ไม่มีราคาจากโมเดลสำหรับเส้นนี้',
  THIN_MARKET: 'ข้อมูลราคาตลาดไม่พอ',
  ODDS_OUT_OF_RANGE: 'ราคาอยู่นอกช่วงที่วิเคราะห์',
  EDGE_BELOW_MIN: 'โมเดลกับตลาดมองใกล้เคียงกัน',
  EV_BELOW_MIN: 'ความคุ้มค่าเชิงสถิติไม่พอ',
  EDGE_TOO_LARGE: 'โมเดลกับตลาดต่างกันมากผิดปกติ (อาจมีข้อมูลที่โมเดลไม่รู้)',
  MAIN_LINE_UNAVAILABLE: 'ยังไม่มีเส้นหลักของตลาดที่เชื่อถือได้',
  NOT_MAIN_LINE: 'ไม่ใช่เส้นหลักของตลาด',
};

const MAIN_LINE_TH: Record<string, string> = { ASIAN_HANDICAP: 'แฮนดิแคปเส้นหลัก', OVER_UNDER: 'สูง/ต่ำเส้นหลัก' };

const fmtLine = (x: number) => (x > 0 ? `+${x}` : x === 0 ? '0' : `${x}`);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** "Arsenal +0.75", "Liverpool ชนะ", "เสมอ", "Over 2.5" */
export function selectionLabel(market: string, selection: string, line: number | null, home: string, away: string): string {
  const team = selection === 'HOME' ? home : selection === 'AWAY' ? away : null;
  if (market === 'MATCH_WINNER') return selection === 'DRAW' ? 'เสมอ' : `${team} ชนะ`;
  if (market === 'ASIAN_HANDICAP') return `${team} ${fmtLine(line ?? 0)}`;
  if (market === 'OVER_UNDER') return `${selection === 'OVER' ? 'Over' : 'Under'} ${line}`;
  return `${selection}${line === null ? '' : ' ' + line}`;
}

export interface MissingPlayer {
  name: string | null;
  attackShare: number;
  defenceShare: number;
  weight: number;
}

export interface ReasonInput {
  kind: 'SIGNAL' | 'NO_CLEAR_SIGNAL';
  round: PublishRound;
  /** why a PREMATCH round was published; absent = the league re-tune (ADR 0005) */
  prematchCause?: PrematchCause | null;
  home: string;
  away: string;
  pick?: {
    label: string;
    modelProbability: number;
    marketProbability: number;
    odds: number;
    nBookmakers: number;
    strength: string | null;
    agreement: boolean | null;
    gateZ: number | null;
    modelSource: string;
    /** the pick is on the market's main line (rules-v0.6); absent for older runs */
    onMainLine?: boolean | null;
  } | null;
  rejectReasons?: Partial<Record<string, number>>;
  /** main-line rules (v0.6): why each main line gave no pick; preferred over the counts in rejectReasons */
  fogReasons?: Array<{ market: string | null; reason: string }> | null;
  impact?: { home: { attackLoss: number; defenceLoss: number; missing: MissingPlayer[] }; away: { attackLoss: number; defenceLoss: number; missing: MissingPlayer[] } } | null;
  marketMove?: { opening: number; current: number } | null;
}

function impactLine(team: string, t: { attackLoss: number; defenceLoss: number; missing: MissingPlayer[] }): string | null {
  const names = t.missing.filter((m) => m.name).slice(0, 3).map((m) => m.name);
  if (!names.length || Math.max(t.attackLoss, t.defenceLoss) < 0.05) return null;
  const parts = [];
  if (t.attackLoss >= 0.05) parts.push(`พลังรุก −${Math.round(t.attackLoss * 100)}%`);
  if (t.defenceLoss >= 0.05) parts.push(`เกมรับ −${Math.round(t.defenceLoss * 100)}%`);
  return `${BRAND.IMPACT} ${team} ขาด ${names.join(', ')} (${parts.join(', ')})`;
}

/** Thai explanation, built only from stored numbers. */
export function buildReason(r: ReasonInput): string {
  const lines: string[] = [];
  const when =
    r.round === 'LINEUP'
      ? 'หลังประกาศรายชื่อตัวจริง'
      : r.round === 'PREMATCH'
        ? r.prematchCause === 'RULES_CHANGED'
          ? 'ก่อนเตะ หลังปรับกติกาให้วิเคราะห์เฉพาะเส้นหลักของตลาด'
          : 'ก่อนเตะ หลังปรับโมเดลของลีก'
        : 'ล่วงหน้าก่อนเกม';

  if (r.kind === 'SIGNAL' && r.pick) {
    const p = r.pick;
    const diff = (p.modelProbability - p.marketProbability) * 100;
    lines.push(`${BRAND.SIGNAL}: ${p.label} (${when})`);
    lines.push(`โมเดลให้โอกาส ${pct(p.modelProbability)} ขณะที่ตลาดประเมิน ${pct(p.marketProbability)} (ต่างกัน +${diff.toFixed(1)} จุด)`);
    if (p.agreement === true) lines.push(`✓ ${BRAND.AGREE}: โมเดล Elo มองทิศเดียวกัน`);
    else if (p.agreement === false) lines.push('• โมเดล Elo มองต่าง — ใช้ความระมัดระวัง');
    if (p.gateZ !== null) lines.push(`✓ โมเดลผ่านการทดสอบย้อนหลังในลีกนี้ (z = ${p.gateZ.toFixed(1)})`);
    lines.push(`✓ ${p.onMainLine ? 'เส้นหลักของตลาด · ' : ''}อ้างอิงราคาจาก ${p.nBookmakers} เจ้า (ราคากลาง ${p.odds.toFixed(2)})`);
    if (p.modelSource === 'DC+IMPACT') lines.push('✓ ปรับตามผู้เล่นที่ขาดแล้ว');
  } else {
    lines.push(`${BRAND.NO_SIGNAL} (${when})`);
    lines.push('ไม่มีตลาดใดมีข้อมูลสนับสนุนเพียงพอ ณ เวลาที่วิเคราะห์');
    const fog = (r.fogReasons ?? []).slice(0, 2).map((f) => (f.market ? `${MAIN_LINE_TH[f.market] ?? f.market}: ` : '') + (REASON_TH[f.reason] ?? f.reason));
    const top = fog.length ? fog : Object.entries(r.rejectReasons ?? {})
      .filter(([k]) => k !== 'MARKET_NOT_PICKABLE' && k !== 'NOT_MAIN_LINE') // policies, not something this match lacked
      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
      .slice(0, 2)
      .map(([k]) => REASON_TH[k] ?? k);
    if (top.length) lines.push(`เหตุผลหลัก: ${top.join(' / ')}`);
  }

  if (r.impact) {
    const h = impactLine(r.home, r.impact.home);
    const a = impactLine(r.away, r.impact.away);
    if (h) lines.push(h);
    if (a) lines.push(a);
  }
  if (r.marketMove && Math.abs(r.marketMove.current - r.marketMove.opening) >= 0.03) {
    lines.push(`${BRAND.MARKET}: ราคาขยับจาก ${r.marketMove.opening.toFixed(2)} เป็น ${r.marketMove.current.toFixed(2)}`);
  }
  if (r.kind === 'SIGNAL' && r.pick?.strength) lines.push(`ระดับสัญญาณ: ${STRENGTH_TH[r.pick.strength] ?? r.pick.strength}`);
  return lines.join('\n');
}

/**
 * Which round (if any) should be published now.
 * EARLY  : kickoff within (earlyMinHours, earlyHours]
 * LINEUP : lineups of both teams known and kickoff within [lineupMinMinutes, lineupMaxMinutes]
 */
export type PrematchCause = 'GATES_RETUNED' | 'RULES_CHANGED';

export interface PrematchInput {
  kickoffAt: Date;
  now: Date;
  /** `rulesVersion`: the pick rules the EARLY round was published under */
  early: { kind: string; publishedAt: Date; rulesVersion?: string | null } | null;
  gateTunedAt: Date | null;
  lineupPublished: boolean;
  prematchPublished: boolean;
  /** the pick rules in force now; omitted = only the re-tune cause applies */
  rulesVersion?: string;
  minMinutes?: number;
}

/**
 * PREMATCH: one extra round, published whatever the decision (pick or fog), once, at least 15 minutes
 * before kickoff and before any LINEUP round. It adds a row to the record; nothing published is changed.
 *  - GATES_RETUNED (ADR 0005): the EARLY round was fog published before the league's gates were re-tuned.
 *  - RULES_CHANGED (ADR 0009): the EARLY round was published under pick rules that have since been replaced.
 */
export function prematchCause(p: PrematchInput): PrematchCause | null {
  if (p.prematchPublished || p.lineupPublished || !p.early) return null;
  if ((p.kickoffAt.getTime() - p.now.getTime()) / 60_000 < (p.minMinutes ?? 15)) return null;
  if (p.rulesVersion && p.early.rulesVersion && p.early.rulesVersion !== p.rulesVersion) return 'RULES_CHANGED';
  if (p.early.kind === 'NO_CLEAR_SIGNAL' && p.gateTunedAt && p.gateTunedAt.getTime() > p.early.publishedAt.getTime()) return 'GATES_RETUNED';
  return null;
}

export function prematchDue(p: PrematchInput): boolean {
  return prematchCause(p) !== null;
}

export function publishRoundFor(
  kickoffAt: Date,
  now: Date,
  hasLineups: boolean,
  opts: { earlyHours?: number; earlyMinHours?: number; lineupMinMinutes?: number; lineupMaxMinutes?: number } = {},
): PublishRound | null {
  const minutes = (kickoffAt.getTime() - now.getTime()) / 60_000;
  if (hasLineups && minutes >= (opts.lineupMinMinutes ?? 15) && minutes <= (opts.lineupMaxMinutes ?? 80)) return 'LINEUP';
  if (minutes <= (opts.earlyHours ?? 24) * 60 && minutes > (opts.earlyMinHours ?? 3) * 60) return 'EARLY';
  return null;
}

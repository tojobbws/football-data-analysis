/**
 * Competition stage from API-Football's free-text `round` ("Round of 16", "League Stage - 3", "2nd Qualifying Round" ...).
 * The stage decides which rules apply (legs, extra time, penalties), so it is parsed once, here,
 * and unknown text becomes OTHER instead of a guess.
 */
export type Stage =
  | 'PRELIMINARY'
  | 'QUALIFYING_1'
  | 'QUALIFYING_2'
  | 'QUALIFYING_3'
  | 'PLAYOFF'
  | 'LEAGUE_PHASE'
  | 'GROUP'
  | 'KNOCKOUT_PLAYOFF'
  | 'ROUND_OF_32'
  | 'ROUND_OF_16'
  | 'QUARTER_FINAL'
  | 'SEMI_FINAL'
  | 'THIRD_PLACE'
  | 'FINAL'
  | 'REGULAR_SEASON'
  | 'OTHER';

export interface ParsedRound {
  stage: Stage;
  /** matchday for league-style stages ("League Stage - 3" -> 3), else null */
  matchday: number | null;
}

export function parseRound(round: string | null | undefined): ParsedRound {
  const r = (round ?? '').trim().toLowerCase();
  const md = (re: RegExp, stage: Stage): ParsedRound | null => {
    const m = re.exec(r);
    return m ? { stage, matchday: Number(m[1]) } : null;
  };
  const is = (re: RegExp, stage: Stage): ParsedRound | null => (re.test(r) ? { stage, matchday: null } : null);
  const q = /^([1-3])(?:st|nd|rd) qualifying round/.exec(r);
  if (q) return { stage: `QUALIFYING_${q[1]}` as Stage, matchday: null };
  return (
    is(/^preliminary round/, 'PRELIMINARY') ??
    is(/^knockout round play-?offs?/, 'KNOCKOUT_PLAYOFF') ??
    is(/^play-?offs?( round)?(\s|$|\/)/, 'PLAYOFF') ??
    is(/^round of 32/, 'ROUND_OF_32') ??
    is(/^round of 16|^8th finals/, 'ROUND_OF_16') ??
    is(/^quarter-?finals?/, 'QUARTER_FINAL') ??
    is(/^semi-?finals?/, 'SEMI_FINAL') ??
    is(/^(3rd place|third place)/, 'THIRD_PLACE') ??
    is(/^final$/, 'FINAL') ??
    md(/^league stage - (\d+)/, 'LEAGUE_PHASE') ??
    md(/^league [a-d] - (\d+)/, 'LEAGUE_PHASE') ??
    md(/^group [a-z0-9]+ - (\d+)/, 'GROUP') ??
    md(/^regular season - (\d+)/, 'REGULAR_SEASON') ?? { stage: 'OTHER', matchday: null }
  );
}

/** Thai label for the match page. Unknown rounds show the provider's own text. */
export function stageLabelTh(round: string | null | undefined): string {
  const { stage, matchday } = parseRound(round);
  const n = matchday == null ? '' : ` นัดที่ ${matchday}`;
  switch (stage) {
    case 'PRELIMINARY':
      return 'รอบเบื้องต้น';
    case 'QUALIFYING_1':
    case 'QUALIFYING_2':
    case 'QUALIFYING_3':
      return `รอบคัดเลือกรอบที่ ${stage.slice(-1)}`;
    case 'PLAYOFF':
      return 'รอบเพลย์ออฟ';
    case 'LEAGUE_PHASE':
      return `ลีกเฟส${n}`;
    case 'GROUP':
      return `รอบแบ่งกลุ่ม${n}`;
    case 'KNOCKOUT_PLAYOFF':
      return 'รอบเพลย์ออฟน็อกเอาต์';
    case 'ROUND_OF_32':
      return 'รอบ 32 ทีม';
    case 'ROUND_OF_16':
      return 'รอบ 16 ทีม';
    case 'QUARTER_FINAL':
      return 'รอบก่อนรองชนะเลิศ';
    case 'SEMI_FINAL':
      return 'รอบรองชนะเลิศ';
    case 'THIRD_PLACE':
      return 'ชิงอันดับ 3';
    case 'FINAL':
      return 'รอบชิงชนะเลิศ';
    case 'REGULAR_SEASON':
      return `ฤดูกาลปกติ${n}`;
    default:
      return (round ?? '').trim();
  }
}

import type { OddsItem } from './types.js';

export type Market = 'MATCH_WINNER' | 'ASIAN_HANDICAP' | 'OVER_UNDER' | 'OTHER';
export type Selection = 'HOME' | 'DRAW' | 'AWAY' | 'OVER' | 'UNDER';

export interface ParsedSelection {
  selection: Selection;
  /** Line of this selection as quoted (AH: Home -0.75 -> -0.75, OU: 2.5) */
  line: number | null;
  /** AH line from the home team's perspective (Away +0.75 -> -0.75) */
  homeLine: number | null;
}

export interface OddsRow {
  fixtureId: number;
  bookmakerId: number;
  bookmakerName: string;
  market: Market;
  apiBetId: number;
  apiBetName: string;
  selection: Selection;
  line: number | null;
  homeLine: number | null;
  rawValue: string;
  odds: number;
  sourceUpdatedAt: string;
}

export interface NormaliseOddsResult {
  rows: OddsRow[];
  /** Values we could not parse (logged, never silently guessed) */
  skipped: Array<{ fixtureId: number; bookmakerId: number; bet: string; value: string; reason: string }>;
}

/** Map API bet names to our market codes. Matching by name is more stable than by id across plans. */
export function classifyMarket(betName: string): Market {
  const n = betName.trim().toLowerCase();
  if (n === 'match winner' || n === '1x2' || n === 'fulltime result') return 'MATCH_WINNER';
  if (n === 'asian handicap') return 'ASIAN_HANDICAP';
  if (n === 'goals over/under' || n === 'over/under') return 'OVER_UNDER';
  return 'OTHER';
}

/** "-0.25" | "+0.5" | "0" | "-0, -0.5" (split quarter line) -> number */
export function parseLine(raw: string): number | null {
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const nums = parts.map((p) => Number(p.replace(/^\+/, '')));
  if (nums.some((x) => !Number.isFinite(x))) return null;
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
  // only quarter steps are valid lines
  return Math.abs(avg * 4 - Math.round(avg * 4)) < 1e-9 ? Math.round(avg * 4) / 4 : null;
}

export function parseSelection(market: Market, value: string | number): ParsedSelection | null {
  const v = String(value).trim();

  if (market === 'MATCH_WINNER') {
    const m = v.toLowerCase();
    if (m === 'home' || m === '1') return { selection: 'HOME', line: null, homeLine: null };
    if (m === 'draw' || m === 'x') return { selection: 'DRAW', line: null, homeLine: null };
    if (m === 'away' || m === '2') return { selection: 'AWAY', line: null, homeLine: null };
    return null;
  }

  if (market === 'ASIAN_HANDICAP') {
    // API-Football quotes BOTH sides with the HOME handicap:
    //   "Home -0.5" = home -0.5        "Away -0.5" = the other side of that line = away +0.5
    // (verified on live data: "Home -0.5" 1.78 pairs with "Away -0.5" 2.02, overround ~5.7%)
    const m = /^(home|away)\s*(.*)$/i.exec(v);
    if (!m) return null;
    const side = m[1]!.toLowerCase() === 'home' ? 'HOME' : 'AWAY';
    const rest = m[2]!.trim();
    const parsed = rest === '' ? 0 : parseLine(rest);
    if (parsed === null) return null;
    const homeLine = parsed === 0 ? 0 : parsed; // avoid -0
    const ownLine = side === 'HOME' ? homeLine : homeLine === 0 ? 0 : -homeLine;
    return { selection: side, line: ownLine, homeLine };
  }

  if (market === 'OVER_UNDER') {
    const m = /^(over|under)\s+(\d+(?:\.\d+)?)$/i.exec(v);
    if (!m) return null;
    const line = Number(m[2]);
    return { selection: m[1]!.toLowerCase() === 'over' ? 'OVER' : 'UNDER', line, homeLine: null };
  }

  return null;
}

/**
 * Flatten an `/odds` response item into rows for `odds_history`.
 * Only markets in `markets` are kept.
 */
export function normaliseOdds(item: OddsItem, markets: readonly Market[] = ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER']): NormaliseOddsResult {
  const rows: OddsRow[] = [];
  const skipped: NormaliseOddsResult['skipped'] = [];
  const sourceUpdatedAt = new Date(item.update).toISOString();

  for (const bk of item.bookmakers ?? []) {
    for (const bet of bk.bets ?? []) {
      const market = classifyMarket(bet.name);
      if (!markets.includes(market)) continue;
      for (const val of bet.values ?? []) {
        const rawValue = String(val.value).trim();
        const odds = Number(val.odd);
        const base = { fixtureId: item.fixture.id, bookmakerId: bk.id, bet: bet.name, value: rawValue };
        if (!Number.isFinite(odds) || odds < 1) {
          skipped.push({ ...base, reason: `invalid odd "${val.odd}"` });
          continue;
        }
        const parsed = parseSelection(market, rawValue);
        if (!parsed) {
          skipped.push({ ...base, reason: 'unparseable selection' });
          continue;
        }
        rows.push({
          fixtureId: item.fixture.id,
          bookmakerId: bk.id,
          bookmakerName: bk.name,
          market,
          apiBetId: bet.id,
          apiBetName: bet.name,
          selection: parsed.selection,
          line: parsed.line,
          homeLine: parsed.homeLine,
          rawValue,
          odds,
          sourceUpdatedAt,
        });
      }
    }
  }
  return { rows, skipped };
}

/**
 * Convert decimal odds of a complete market (e.g. [home, draw, away]) into
 * no-vig implied probabilities (proportional method). Returns probabilities summing to 1.
 */
export function impliedProbabilities(decimalOdds: readonly number[]): { probabilities: number[]; overround: number } {
  if (decimalOdds.length < 2 || decimalOdds.some((o) => !(o > 1))) {
    throw new Error('impliedProbabilities: need >= 2 odds, all > 1');
  }
  const raw = decimalOdds.map((o) => 1 / o);
  const sum = raw.reduce((a, b) => a + b, 0);
  return { probabilities: raw.map((p) => p / sum), overround: sum - 1 };
}

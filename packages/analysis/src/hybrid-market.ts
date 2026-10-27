/**
 * Market snapshot for the Hybrid AI engine (docs/adr/0010-hybrid-ai-picks.md): the four choices it may make,
 * each on the market's main line as it stands at the decision time.
 *
 *   AH favourite / AH underdog — both sides of the main Asian handicap line
 *   Over / Under              — both sides of the main over/under line
 *
 * The main lines are the same ones the legacy rules use (`mainLines`: ≥ 3 fresh bookmakers, closest to
 * 50/50), so a choice is never moved to a far line. Prices are the median across fresh bookmakers and the
 * probability is the de-margined consensus. Only quotes known at `now` count (`consensus`).
 */
import { consensus, DEFAULT_RULES, mainLines, type DecisionRules, type MainLine, type OddsQuote } from './candidates.js';

export type HybridSide = 'FAVORITE' | 'UNDERDOG' | 'OVER' | 'UNDER';

export interface HybridOption {
  side: HybridSide;
  market: 'ASIAN_HANDICAP' | 'OVER_UNDER';
  /** HOME / AWAY for AH, OVER / UNDER for O/U */
  selection: string;
  /** the selection's own line (AH: the side's handicap, e.g. underdog +1.25; O/U: the total) */
  line: number;
  odds: number;
  marketProbability: number;
}

export interface HybridMarketSide {
  status: MainLine['status'] | 'NO_FAVOURITE';
  /** AH: the home team's line; O/U: the total */
  line: number | null;
  nBookmakers: number;
  updatedAt: string | null;
  ageHours: number | null;
  options: HybridOption[];
}

export interface HybridMarket {
  asOf: string;
  ah: HybridMarketSide & { favourite: 'HOME' | 'AWAY' | null };
  ou: HybridMarketSide;
  /** de-margined 1X2 consensus, context only */
  x12: { home: number; draw: number; away: number; nBookmakers: number } | null;
}

const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export function hybridMarket(quotes: readonly OddsQuote[], now: Date, rules: Pick<DecisionRules, 'maxOddsAgeHours' | 'minMainLineBookmakers' | 'maxMainLineOffEven'> = DEFAULT_RULES): HybridMarket {
  const mains = mainLines(quotes, now, rules);
  const mw = consensus(quotes, now, rules.maxOddsAgeHours).filter((c) => c.market === 'MATCH_WINNER');
  const x12 = mw.length === 3
    ? {
        home: r(mw.find((c) => c.selection === 'HOME')!.marketProbability, 5),
        draw: r(mw.find((c) => c.selection === 'DRAW')!.marketProbability, 5),
        away: r(mw.find((c) => c.selection === 'AWAY')!.marketProbability, 5),
        nBookmakers: Math.min(...mw.map((c) => c.nBookmakers)),
      }
    : null;
  const age = (m: MainLine) => (m.updatedAt ? r((now.getTime() - Date.parse(m.updatedAt)) / 3_600_000, 2) : null);
  const base = (m: MainLine): HybridMarketSide => ({ status: m.status, line: m.line, nBookmakers: m.nBookmakers, updatedAt: m.updatedAt, ageHours: age(m), options: [] });

  const ahMain = mains.ASIAN_HANDICAP;
  const ah: HybridMarket['ah'] = { ...base(ahMain), favourite: null };
  if (ahMain.status === 'OK' && ahMain.line !== null && ahMain.odds && ahMain.firstProbability !== null) {
    const h = ahMain.line;
    const pHome = ahMain.firstProbability;
    // the favourite gives goals; on a level line, the side the market rates higher (then the 1X2)
    const favourite: 'HOME' | 'AWAY' | null =
      h < 0 ? 'HOME' : h > 0 ? 'AWAY' : pHome > 0.5 ? 'HOME' : pHome < 0.5 ? 'AWAY' : x12 && x12.home !== x12.away ? (x12.home > x12.away ? 'HOME' : 'AWAY') : null;
    if (favourite === null) ah.status = 'NO_FAVOURITE';
    else {
      ah.favourite = favourite;
      const home: HybridOption = { side: favourite === 'HOME' ? 'FAVORITE' : 'UNDERDOG', market: 'ASIAN_HANDICAP', selection: 'HOME', line: h, odds: ahMain.odds.first, marketProbability: r(pHome, 5) };
      const away: HybridOption = { side: favourite === 'AWAY' ? 'FAVORITE' : 'UNDERDOG', market: 'ASIAN_HANDICAP', selection: 'AWAY', line: h === 0 ? 0 : -h, odds: ahMain.odds.second, marketProbability: r(1 - pHome, 5) };
      ah.options = favourite === 'HOME' ? [home, away] : [away, home];
    }
  }

  const ouMain = mains.OVER_UNDER;
  const ou = base(ouMain);
  if (ouMain.status === 'OK' && ouMain.line !== null && ouMain.odds && ouMain.firstProbability !== null) {
    ou.options = [
      { side: 'OVER', market: 'OVER_UNDER', selection: 'OVER', line: ouMain.line, odds: ouMain.odds.first, marketProbability: r(ouMain.firstProbability, 5) },
      { side: 'UNDER', market: 'OVER_UNDER', selection: 'UNDER', line: ouMain.line, odds: ouMain.odds.second, marketProbability: r(1 - ouMain.firstProbability, 5) },
    ];
  }
  return { asOf: now.toISOString(), ah, ou, x12 };
}

/** The four choices that exist at this moment (none on a market without a usable main line). */
export function hybridOptions(m: HybridMarket): HybridOption[] {
  return [...m.ah.options, ...m.ou.options];
}

/**
 * Hybrid AI (ADR 0010): the input holds only computed, verified data; an answer is used only when it is a
 * consistent choice that exists in the market snapshot, with no banned word and no invented number.
 */
import { describe, expect, it } from 'vitest';
import { hybridMarket, hybridOptions, type OddsQuote } from '@fp/analysis';
import { buildHybridInput, validateHybridOutput, type HybridSource, type TeamMatch } from '../src/index.js';

const NOW = new Date('2026-10-24T08:00:00Z');
const quotes: OddsQuote[] = [1, 2, 3].flatMap((b) => [
  { bookmakerId: b, market: 'ASIAN_HANDICAP' as const, selection: 'HOME', line: -1.25, homeLine: -1.25, odds: 2.02, updatedAt: new Date('2026-10-24T07:00:00Z') },
  { bookmakerId: b, market: 'ASIAN_HANDICAP' as const, selection: 'AWAY', line: 1.25, homeLine: -1.25, odds: 1.86, updatedAt: new Date('2026-10-24T07:00:00Z') },
  { bookmakerId: b, market: 'OVER_UNDER' as const, selection: 'OVER', line: 2.75, homeLine: null, odds: 1.95, updatedAt: new Date('2026-10-24T07:00:00Z') },
  { bookmakerId: b, market: 'OVER_UNDER' as const, selection: 'UNDER', line: 2.75, homeLine: null, odds: 1.9, updatedAt: new Date('2026-10-24T07:00:00Z') },
]);
const market = hybridMarket(quotes, NOW);
const options = hybridOptions(market);

const match = (i: number, over: Partial<TeamMatch> = {}): TeamMatch => ({
  kickoffAt: new Date(NOW.getTime() - (i + 1) * 7 * 86_400_000).toISOString(),
  competition: 'Premier League',
  venue: i % 2 ? 'AWAY' : 'HOME',
  opponent: `Team ${i}`,
  opponentRank: 5 + i,
  opponentTableSize: 20,
  goalsFor: 2,
  goalsAgainst: i % 3 === 0 ? 1 : 0,
  xgFor: 1.8,
  xgAgainst: 0.7,
  shotsOnTargetFor: 6,
  shotsOnTargetAgainst: 2,
  shotsFor: 15,
  shotsAgainst: 7,
  ...over,
});
const src: HybridSource = {
  fixture: { id: 1, home: 'Arsenal', away: 'Everton', league: 'Premier League', kickoffAt: new Date('2026-10-24T14:00:00Z') },
  predictionAt: NOW,
  publishRound: 'EARLY',
  recent: { home: Array.from({ length: 10 }, (_, i) => match(i)), away: Array.from({ length: 7 }, (_, i) => match(i, { goalsFor: 1, goalsAgainst: 1, xgFor: null })) },
  standings: { home: { rank: 1, tableSize: 20, played: 9, points: 22, goalDiff: 14 }, away: null },
  injuries: [{ team: 'AWAY', player: 'J. Doe', type: 'Missing Fixture', reason: 'Knee Injury' }],
  lineup: null,
  market,
  legacy: { options: { FAVORITE: 0.4414, UNDERDOG: 0.5586, OVER: 0.4458, UNDER: 0.5542 }, x12: { home: 0.645, draw: 0.2392, away: 0.1158 } },
};
const input = buildHybridInput(src);

const answer = (over: Record<string, unknown> = {}) => ({
  team_assessment_th: 'Arsenal ชนะ 10 นัดล่าสุดเกือบทั้งหมด',
  match_outlook_th: 'Arsenal น่าจะคุมเกม',
  market_comparison_th: 'ตลาดให้ Arsenal ต่อ 1.25',
  options_review: [{ option: 'FAVORITE', supporting_evidence: ['ยิงเฉลี่ย 2 ประตู'], counter_evidence: ['Everton เสมอบ่อย'], assessment: 'STRONG' }],
  market: 'AH',
  side: 'FAVORITE',
  main_line: -1.25,
  confidence: 'MEDIUM',
  supporting_evidence: ['Arsenal ยิงเฉลี่ย 2 ประตูใน 10 นัด'],
  counter_evidence: ['Everton เสมอ 7 นัดล่าสุด'],
  risk_factors: ['ยังไม่มีรายชื่อตัวจริง'],
  missing_data: ['ไม่มี xG ของ Everton'],
  summary_th: 'ฟอร์มและการยิงของ Arsenal หนักแน่นกว่าที่ราคา 2.02 สะท้อน',
  ...over,
});

describe('buildHybridInput', () => {
  it('keeps at most 10 matches, says how many there are, and lists what is missing', () => {
    const home = input.home_team as { last_10: { matches: number; goals_for_avg: number; xg_matches: number }; last_5: { matches: number }; home_matches_in_last_10: { matches: number } };
    const away = input.away_team as { last_10: { matches: number; xg_for_avg: number | null }; rest_days_before_this_match: number };
    expect(home.last_10).toMatchObject({ matches: 10, goals_for_avg: 2, xg_matches: 10 });
    expect(home.last_5.matches).toBe(5);
    expect(home.home_matches_in_last_10.matches).toBe(5);
    expect(away.last_10).toMatchObject({ matches: 7, xg_for_avg: null });
    expect(away.rest_days_before_this_match).toBe(7);
    const missing = (input.data_quality as { missing: string[] }).missing;
    expect(missing).toContain('Everton: 7 of 10 recent matches');
    expect(missing).toContain('no xG for 7 recent matches');
    expect(missing).toContain('lineups not confirmed yet');
  });
  it('gives the four options on the main lines with their prices and no-vig probability', () => {
    const ahView = (input.market as { asian_handicap: { favourite: string; options: Array<{ option: string; team_or_total: string; line: number; odds_median: number }> } }).asian_handicap;
    expect(ahView.favourite).toBe('Arsenal');
    expect(ahView.options.map((o) => [o.option, o.team_or_total, o.line, o.odds_median])).toEqual([
      ['FAVORITE', 'Arsenal', -1.25, 2.02],
      ['UNDERDOG', 'Everton', 1.25, 1.86],
    ]);
  });
});

describe('validateHybridOutput', () => {
  it('accepts a consistent pick on an existing option and maps it to its selection and price', () => {
    const v = validateHybridOutput(answer(), input, options);
    expect(v.violations).toEqual([]);
    expect(v.decision?.option).toMatchObject({ side: 'FAVORITE', market: 'ASIAN_HANDICAP', selection: 'HOME', line: -1.25, odds: 2.02 });
    expect(v.decision?.confidence).toBe('MEDIUM');
  });
  it('accepts the underdog getting goals on its own line', () => {
    const v = validateHybridOutput(answer({ side: 'UNDERDOG', main_line: 1.25 }), input, options);
    expect(v.decision?.option).toMatchObject({ selection: 'AWAY', line: 1.25 });
  });
  it('accepts NO_PICK only as NONE, null line and no confidence', () => {
    expect(validateHybridOutput(answer({ market: 'NONE', side: 'NO_PICK', main_line: null, confidence: 'NONE' }), input, options).decision).toMatchObject({ side: 'NO_PICK', option: null, confidence: null });
    expect(validateHybridOutput(answer({ market: 'AH', side: 'NO_PICK', main_line: null, confidence: 'NONE' }), input, options).ok).toBe(false);
  });
  it('rejects a side that does not belong to its market, a line that is not the main line, and a missing option', () => {
    expect(validateHybridOutput(answer({ market: 'OU' }), input, options).violations).toContain('side FAVORITE does not belong to market OU');
    expect(validateHybridOutput(answer({ main_line: -1.5 }), input, options).violations).toContain('main_line -1.5 is not the FAVORITE line -1.25');
    expect(validateHybridOutput(answer({ side: 'OVER', market: 'OU', main_line: 2.75 }), input, options.filter((o) => o.market !== 'OVER_UNDER')).violations).toContain('option OVER is not available in the market snapshot');
    expect(validateHybridOutput(answer({ confidence: 'NONE' }), input, options).ok).toBe(false);
  });
  it('rejects banned words, invented numbers and a broken schema', () => {
    expect(validateHybridOutput(answer({ summary_th: 'คู่นี้ทีเด็ด' }), input, options).violations).toContain('banned word "ทีเด็ด"');
    expect(validateHybridOutput(answer({ summary_th: 'Arsenal มีโอกาสชนะ 78%' }), input, options).violations).toContain('number not in input: 78%');
    expect(validateHybridOutput({ side: 'FAVORITE' }, input, options).ok).toBe(false);
    expect(validateHybridOutput(answer({ side: 'HOME' }), input, options).ok).toBe(false);
  });
});

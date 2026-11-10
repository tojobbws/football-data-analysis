/**
 * Hybrid AI (ADR 0010): the input holds only computed, verified data; an answer is used only when it is a
 * consistent choice that exists in the market snapshot, with no banned word and no invented number.
 */
import { describe, expect, it } from 'vitest';
import { hybridMarket, hybridOptions, type OddsQuote } from '@fp/analysis';
import {
  allowedNumbers,
  buildHybridInput,
  expectedMetrics,
  expectedPoints,
  HYBRID_MAJORITY,
  HYBRID_PROMPT_VERSION,
  HYBRID_SYSTEM_PROMPT,
  HYBRID_VOTES,
  majorityVote,
  PENALTY_XG,
  validateHybridOutput,
  type HybridSource,
  type TeamMatch,
} from '../src/index.js';
import type { RegularStarters, StartersCompetitionKind } from '@fp/analysis';

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
  it('carries every number named in a key as a value too, so the AI may quote it', () => {
    // the AI reads "matches_in_last_14_days" as "14 days": a number only in a key fails the number guard (2026-10-27)
    const named: number[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          for (const m of k.matchAll(/\d+(?:_\d+)?/g)) named.push(Number(m[0].replace('_', '.')));
          walk(x);
        }
    };
    walk(input);
    expect(named.length).toBeGreaterThan(0);
    const allowed = allowedNumbers(input);
    expect(named.filter((n) => !allowed.includes(n))).toEqual([]);
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

describe('input v2 flags (audit gaps G1, G2): off by default, never change the v1 input', () => {
  it('leaves the v1 input byte-identical when the v2 fields are not given', () => {
    const again = buildHybridInput({ ...src });
    expect(JSON.stringify(again)).toBe(JSON.stringify(input));
    const dq = (input as { data_quality: Record<string, unknown> }).data_quality;
    expect(dq).not.toHaveProperty('injuries_coverage');
    expect(dq).not.toHaveProperty('opponent_rank_basis');
  });

  it('says so when the league provides no injury data, so an empty list is not read as "nobody is out"', () => {
    const v2 = buildHybridInput({ ...src, injuries: [], injuriesCoverage: 'unavailable_for_league', opponentRankBasis: 'as_of_results' }) as {
      data_quality: { injuries_coverage: string; opponent_rank_basis: string; injuries_reported: number; missing: string[] };
    };
    expect(v2.data_quality.injuries_coverage).toBe('unavailable_for_league');
    expect(v2.data_quality.opponent_rank_basis).toBe('as_of_results');
    expect(v2.data_quality.injuries_reported).toBe(0);
    expect(v2.data_quality.missing.some((x) => x.includes('no injury data'))).toBe(true);
  });

  it('records coverage without a warning when the league reports injuries (an empty list is then real)', () => {
    const v2 = buildHybridInput({ ...src, injuries: [], injuriesCoverage: 'available' }) as { data_quality: { injuries_coverage: string; missing: string[] } };
    expect(v2.data_quality.injuries_coverage).toBe('available');
    expect(v2.data_quality.missing.some((x) => x.includes('no injury data'))).toBe(false);
  });

  it('still accepts an answer that was valid on the v1 input (the new block adds no number to quote or trip over)', () => {
    const v2 = buildHybridInput({ ...src, injuriesCoverage: 'unavailable_for_league', opponentRankBasis: 'as_of_results' });
    expect(validateHybridOutput(answer(), v2, options).ok).toBe(validateHybridOutput(answer(), input, options).ok);
  });
});

describe('next_match (since prompt hybrid-ai-v1.2): the next fixture of each team, computed from stored kickoff times', () => {
  const next = { kickoffAt: '2026-10-27T19:45:00.000Z', competition: 'UEFA Champions League', venue: 'AWAY' as const };
  type Built = { home_team: { next_match?: Record<string, unknown> | null }; away_team: { next_match?: Record<string, unknown> | null }; data_quality: { missing: string[]; next_match_scope?: string } };

  it('adds no next_match key at all when the schedule was not looked up', () => {
    const b = buildHybridInput({ ...src }) as Built;
    expect(b.home_team).not.toHaveProperty('next_match');
    expect(b.data_quality).not.toHaveProperty('next_match_scope');
  });

  it('gives the days after this match (computed, 1 decimal), the date, competition and venue', () => {
    const b = buildHybridInput({ ...src, nextMatch: { home: next, away: null } }) as Built;
    // this match is 2026-10-24 14:00, the next one 2026-10-27 19:45: 3 days 5 h 45 min = 3.2 days
    expect(b.home_team.next_match).toEqual({ days_after_this_match: 3.2, date_utc: '2026-10-27', competition: 'UEFA Champions League', venue: 'AWAY' });
  });

  it('says so when a team has no next fixture in the tracked competitions, and that it does not mean none exists', () => {
    const b = buildHybridInput({ ...src, nextMatch: { home: next, away: null } }) as Built;
    expect(b.away_team.next_match).toBeNull();
    expect(b.data_quality.missing).toContain('Everton: no next fixture in the competitions we track');
    expect(b.data_quality.missing.some((x) => x.startsWith('Arsenal: no next fixture'))).toBe(false);
    expect(b.data_quality.next_match_scope).toContain('does not mean the team has no fixture');
  });

  it('keeps the quoted day count inside the numbers the AI may quote (the number guard)', () => {
    const withNext = buildHybridInput({ ...src, nextMatch: { home: next, away: next } });
    const quote = answer({ supporting_evidence: ['Arsenal มีเกมถัดไปอีก 3.2 วันหลังเกมนี้'] });
    expect(validateHybridOutput(quote, withNext, options).ok).toBe(true);
    expect(validateHybridOutput(quote, input, options).ok).toBe(false); // without the field, 3.2 would be an invented number
  });

  it('names the field in the system prompt (no confidence level in the Thai text)', () => {
    expect(HYBRID_SYSTEM_PROMPT).toContain('next_match');
    expect(HYBRID_SYSTEM_PROMPT).toContain('Never state how confident you are');
  });
});

describe('opponent positions as of the match date (input v2): what the AI is told when some are missing', () => {
  type Built = { data_quality: { missing: string[] }; home_team: { recent_matches: Array<{ opponent_table_position: string | null }> } };

  it('counts the recent matches without an opponent position (cup, split league) in data_quality.missing', () => {
    const recent = { home: Array.from({ length: 10 }, (_, i) => match(i, i < 3 ? { opponentRank: null, opponentTableSize: null } : {})), away: Array.from({ length: 10 }, (_, i) => match(i)) };
    const b = buildHybridInput({ ...src, recent, opponentRankBasis: 'as_of_results' }) as Built;
    expect(b.data_quality.missing.some((x) => x.startsWith('no opponent table position for 3 recent matches'))).toBe(true);
    expect(b.home_team.recent_matches.filter((m) => m.opponent_table_position === null).length).toBe(3);
  });

  it('says nothing when every opponent has a position, and nothing in the v1 input', () => {
    const full = { home: Array.from({ length: 10 }, (_, i) => match(i)), away: Array.from({ length: 10 }, (_, i) => match(i)) };
    expect((buildHybridInput({ ...src, recent: full, opponentRankBasis: 'as_of_results' }) as Built).data_quality.missing.some((x) => x.includes('opponent table position'))).toBe(false);
    const holes = { home: Array.from({ length: 10 }, (_, i) => match(i, { opponentRank: null, opponentTableSize: null })), away: full.away };
    expect((buildHybridInput({ ...src, recent: holes }) as Built).data_quality.missing.some((x) => x.includes('opponent table position'))).toBe(false); // v1: no basis given, no note
  });
});

describe('expected-goals metrics (prompt v1.5): computed here from stored statistics and events, never by the AI', () => {
  const full = (i: number, over: Partial<TeamMatch> = {}) =>
    match(i, { status: 'FT', fullGoalsFor: 2, fullGoalsAgainst: i % 3 === 0 ? 1 : 0, penaltiesFor: 0, penaltiesAgainst: 0, ownGoalsFor: 0, goalsPreventedFor: 0.2, ...over });
  type Window = Record<string, number | null>;
  type Built = {
    home_team: { recent_matches: Array<Record<string, unknown>>; last_10: Window; last_5: Window; home_matches_in_last_10: Window };
    away_team: { last_10: Window };
    data_quality: { missing: string[]; expected_goals_metrics?: { penalty_xg: number } };
  };
  const withMetrics = (recent = { home: Array.from({ length: 10 }, (_, i) => full(i)), away: Array.from({ length: 10 }, (_, i) => full(i)) }) =>
    buildHybridInput({ ...src, recent, xgMetrics: true }) as unknown as Built;

  it('xPTS: 1 point for a sure 0-0, 3 for a sure win, and the two sides of a match share 3 minus the draw chance', () => {
    expect(expectedPoints(0, 0)).toBeCloseTo(1, 9);
    expect(expectedPoints(8, 0)).toBeGreaterThan(2.99);
    const draw = expectedPoints(0, 0) - 1 + (3 - expectedPoints(1.4, 1.1) - expectedPoints(1.1, 1.4)); // = P(draw) of 1.4 v 1.1
    expect(draw).toBeGreaterThan(0.2);
    expect(draw).toBeLessThan(0.35);
    expect(expectedPoints(1.8, 0.7)).toBeGreaterThan(expectedPoints(0.7, 1.8));
  });

  it('one match: npxG takes the provider penalty xG off per penalty, shooting performance leaves the opponent own goals out', () => {
    expect(PENALTY_XG).toBe(0.79);
    const x = expectedMetrics(match(0, { status: 'FT', xgFor: 1.8, xgAgainst: 0.7, fullGoalsFor: 2, penaltiesFor: 1, penaltiesAgainst: 0, ownGoalsFor: 1, goalsPreventedFor: -0.4 }));
    expect(x).toEqual({ xg_difference: 1.1, npxg_for: 1.01, npxg_against: 0.7, shooting_performance: -0.8, xpts: Math.round(expectedPoints(1.8, 0.7) * 100) / 100, goals_prevented: -0.4 });
  });

  it('a metric is null when its input is missing: no xG, no events, extra time (xG covers 120 minutes), no goals prevented', () => {
    expect(expectedMetrics(full(0, { xgFor: null }))).toEqual({ xg_difference: null, npxg_for: null, npxg_against: 0.7, shooting_performance: null, xpts: null, goals_prevented: 0.2 });
    // the v1 source shape (no event fields at all) gives only the xG difference
    expect(expectedMetrics(match(0))).toEqual({ xg_difference: 1.1, npxg_for: null, npxg_against: null, shooting_performance: null, xpts: null, goals_prevented: null });
    expect(expectedMetrics(full(0, { status: 'AET' })).xpts).toBeNull();
    expect(expectedMetrics(full(0, { penaltiesFor: 3, xgFor: 2 })).npxg_for).toBe(0); // never below 0
  });

  it('adds the metrics to each recent match and window, each window with the matches it rests on', () => {
    const recent = { home: Array.from({ length: 10 }, (_, i) => full(i, i < 2 ? { goalsPreventedFor: null } : {})), away: Array.from({ length: 10 }, (_, i) => full(i)) };
    const b = withMetrics(recent);
    expect(b.home_team.recent_matches[0]).toMatchObject({ xg_difference: 1.1, npxg_for: 1.8, npxg_against: 0.7, shooting_performance: 0.2, goals_prevented: null });
    // goals 2 from xG 1.8 in each of 10 matches: +0.2 per match, +2 in all
    expect(b.home_team.last_10).toMatchObject({ xg_difference_avg: 1.1, npxg_for_avg: 1.8, npxg_matches: 10, shooting_performance_total: 2, shooting_performance_matches: 10, xpts_matches: 10, goals_prevented_total: 1.6, goals_prevented_matches: 8 });
    expect(b.home_team.last_10.points_avg_same_matches).toBe(3); // won all ten
    expect(b.home_team.last_5.xpts_matches).toBe(5);
    expect(b.home_team.home_matches_in_last_10.npxg_matches).toBe(5);
    expect(b.data_quality.missing).toContain('no goals prevented for 2 recent matches');
    expect(b.data_quality.expected_goals_metrics?.penalty_xg).toBe(0.79);
  });

  it('says which matches lack events or went to extra time', () => {
    const recent = { home: Array.from({ length: 10 }, (_, i) => full(i, i === 0 ? { penaltiesFor: null, penaltiesAgainst: null, ownGoalsFor: null } : i === 1 ? { status: 'AET' } : {})), away: Array.from({ length: 10 }, (_, i) => full(i)) };
    const b = withMetrics(recent);
    expect(b.data_quality.missing).toContain('no npxG for 1 recent matches that have xG (no match events stored)');
    expect(b.data_quality.missing).toContain('no xPTS for 1 recent matches that went to extra time');
    expect(b.home_team.last_10.xpts_matches).toBe(9);
  });

  it('off by default: without the flag the input is unchanged, even when the matches carry the new fields', () => {
    const recent = { home: Array.from({ length: 10 }, (_, i) => match(i)), away: src.recent.away };
    const rich = { home: recent.home.map((m, i) => ({ ...m, ...full(i), xgFor: m.xgFor })), away: src.recent.away };
    expect(JSON.stringify(buildHybridInput({ ...src, recent: rich }))).toBe(JSON.stringify(buildHybridInput({ ...src, recent })));
    expect(JSON.stringify(input)).not.toContain('npxg');
  });

  it('the AI may quote a computed metric, and still cannot invent one', () => {
    const b = withMetrics() as unknown as Record<string, unknown>;
    const xpts = (b as unknown as Built).home_team.last_10.xpts_avg!;
    expect(validateHybridOutput(answer({ supporting_evidence: [`Arsenal มี xPTS เฉลี่ย ${xpts} และ npxG เฉลี่ย 1.8`] }), b, options).ok).toBe(true);
    expect(validateHybridOutput(answer({ supporting_evidence: ['Arsenal มี xPTS เฉลี่ย 2.47'] }), b, options).violations).toContain('number not in input: 2.47');
  });

  it('names the metrics in the system prompt', () => {
    for (const k of ['expected_goals_metrics', 'npxg_for', 'shooting_performance', 'xpts', 'points_avg_same_matches', 'goals_prevented']) expect(HYBRID_SYSTEM_PROMPT).toContain(k);
  });
});

describe('prompt v1.6 (ADR 0013): no Dixon-Coles voice, majority of three answers', () => {
  it('shows the AI no Dixon-Coles price, in the input or the prompt', () => {
    expect(input).not.toHaveProperty('legacy_statistical_model');
    expect(JSON.stringify(input)).not.toMatch(/dixon|legacy/i);
    expect(HYBRID_SYSTEM_PROMPT).not.toMatch(/legacy_statistical_model|dixon/i);
  });

  it('asks three times and needs two that agree', () => {
    expect(HYBRID_VOTES).toBe(3);
    expect(HYBRID_MAJORITY).toBe(2);
  });

  it('takes the choice two or three answers gave, with the first answer that gave it', () => {
    expect(majorityVote(['OVER', 'UNDERDOG', 'UNDERDOG'])).toEqual({ side: 'UNDERDOG', votes: 2, first: 1 });
    expect(majorityVote(['FAVORITE', 'FAVORITE', 'FAVORITE'])).toEqual({ side: 'FAVORITE', votes: 3, first: 0 });
    // NO_PICK is a choice like any other
    expect(majorityVote(['NO_PICK', 'OVER', 'NO_PICK'])).toEqual({ side: 'NO_PICK', votes: 2, first: 0 });
    // an answer that is not valid (null) is not a vote
    expect(majorityVote([null, 'UNDER', 'UNDER'])).toEqual({ side: 'UNDER', votes: 2, first: 1 });
  });

  it('has no majority when the answers all differ or too few are valid', () => {
    expect(majorityVote(['OVER', 'UNDER', 'NO_PICK'])).toBeNull();
    expect(majorityVote([null, 'OVER', null])).toBeNull();
    expect(majorityVote([null, null, null])).toBeNull();
  });
});

describe('prompt v1.7 (ADR 0016): recent starters before the lineup', () => {
  const day = (d: number) => new Date(Date.UTC(2026, 9, d, 15));
  const starters = (of: number, players: Array<[number, string, number, boolean | null]>, cup: { fixtureId: number; kickoffAt: Date } | null = null): RegularStarters => ({
    of,
    from: of ? day(1) : null,
    to: of ? day(20) : null,
    previousCupRound: cup,
    players: players.map(([playerId, name, starts, startedPreviousCupRound]) => ({ playerId, name, starts, startedPreviousCupRound, lastStartAt: starts ? day(20) : null })),
  });
  type Built = {
    injuries: Array<Record<string, unknown>>;
    recent_starters: { window_lineups: number; basis: string; domestic_cup?: string; home: Record<string, unknown>; away: { players: Array<Record<string, unknown>> } };
    data_quality: { missing: string[] };
  };
  const withStarters = (kind: StartersCompetitionKind, home: RegularStarters, away: RegularStarters) =>
    buildHybridInput({ ...src, injuries: [{ team: 'AWAY', player: 'J. Doe', type: 'Missing Fixture', reason: 'Knee Injury', playerId: 77 }], regularStarters: { kind, home, away } }) as unknown as Built;

  it('the prompt version is v1.7, and the prompt explains the block and that it is not the coming lineup', () => {
    expect(HYBRID_PROMPT_VERSION).toBe('hybrid-ai-v1.7');
    for (const k of ['recent_starters', 'recent_starts', 'started_previous_cup_round', 'never state or guess who will start']) expect(HYBRID_SYSTEM_PROMPT).toContain(k);
  });

  it("lists each team's starts with the window as a value, and gives each injury its starts (the player id stays out)", () => {
    const b = withStarters('LEAGUE', starters(5, [[10, 'A. Home', 5, null]]), starters(5, [[77, 'J. Doe', 4, null], [78, 'K. Sub', 1, null]]));
    expect(b.recent_starters.window_lineups).toBe(5);
    expect(b.recent_starters.domestic_cup).toBeUndefined();
    expect(b.recent_starters.home).toEqual({ lineups: 5, from_date_utc: '2026-10-01', to_date_utc: '2026-10-20', players: [{ player: 'A. Home', starts: 5 }] });
    expect(b.recent_starters.away.players).toEqual([{ player: 'J. Doe', starts: 4 }, { player: 'K. Sub', starts: 1 }]);
    expect(b.injuries).toEqual([{ team: 'AWAY', player: 'J. Doe', type: 'Missing Fixture', reason: 'Knee Injury', recent_starts: 4, recent_lineups: 5 }]);
    // the AI may then write "started 4 of 5" (number guard)
    expect(allowedNumbers(b)).toEqual(expect.arrayContaining([4, 5]));
  });

  it('an injured player who did not start in the window has 0 starts', () => {
    const b = withStarters('LEAGUE', starters(5, []), starters(5, [[78, 'K. Sub', 1, null]]));
    expect(b.injuries[0]).toMatchObject({ recent_starts: 0, recent_lineups: 5 });
  });

  it("a domestic cup marks the previous round's XI and says why", () => {
    const b = withStarters('DOMESTIC_CUP', starters(5, [[10, 'A. Home', 0, true]], { fixtureId: 9, kickoffAt: day(5) }), starters(5, [[77, 'J. Doe', 5, false]]));
    expect(b.recent_starters.domestic_cup).toContain('rotate');
    expect(b.recent_starters.home).toMatchObject({ previous_cup_round_date_utc: '2026-10-05', players: [{ player: 'A. Home', starts: 0, started_previous_cup_round: true }] });
    expect(b.recent_starters.away).toMatchObject({ previous_cup_round_date_utc: null, players: [{ player: 'J. Doe', starts: 5, started_previous_cup_round: false }] });
  });

  it('few stored lineups are listed as missing data', () => {
    const b = withStarters('NATIONAL_TEAM', starters(2, []), starters(5, []));
    expect(b.data_quality.missing).toContain('Arsenal: only 2 stored lineups for recent_starters');
  });

  it('without regularStarters the input is unchanged (no block, injuries as before)', () => {
    const plain = buildHybridInput({ ...src }) as { injuries: unknown[] };
    expect(plain).not.toHaveProperty('recent_starters');
    expect(plain.injuries).toEqual([{ team: 'AWAY', player: 'J. Doe', type: 'Missing Fixture', reason: 'Knee Injury' }]);
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BIG_MATCH_MIN_SCORE, DEFAULT_LEAGUE_IMPORTANCE, buildRegistry, leagueImportance, popularityScore, rankBigMatches, scoreMatch, thaiMatches, type RankableMatch } from '../src/index.js';

const reg = buildRegistry(
  [
    { team_id: 541, season: 0, popularity: 100 }, // Real Madrid
    { team_id: 529, season: 0, popularity: 100 }, // Barcelona
    { team_id: 2780, season: 0, popularity: 60 }, // Buriram
    { team_id: 2786, season: 0, popularity: 55 }, // Muangthong
    { team_id: 1, season: 0, popularity: 20 },
    { team_id: 541, season: 2027, popularity: 70 }, // a season override
  ],
  [
    { league_id: 140, season: 0, importance: 90, is_thai: false },
    { league_id: 296, season: 0, importance: 70, is_thai: true },
    { league_id: 3, season: 0, importance: 80, is_thai: false },
  ],
  [{ team_a_id: 541, team_b_id: 529, name: 'El Clásico', weight: 15 }],
);

const m = (id: number, leagueId: number, homeId: number, awayId: number, season?: number): RankableMatch => ({ id, leagueId, homeId, awayId, season });

describe('popularityScore', () => {
  it('stays within 0-100 and rises with each input', () => {
    const base = { homePopularity: 50, awayPopularity: 50, leagueImportance: 50, derbyBonus: 0 };
    const s = popularityScore(base);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
    expect(popularityScore({ ...base, homePopularity: 80 })).toBeGreaterThan(s);
    expect(popularityScore({ ...base, leagueImportance: 90 })).toBeGreaterThan(s);
    expect(popularityScore({ ...base, derbyBonus: 10 })).toBeGreaterThan(s);
    expect(popularityScore({ homePopularity: 100, awayPopularity: 100, leagueImportance: 100, derbyBonus: 15 })).toBe(100);
    expect(popularityScore({ homePopularity: 0, awayPopularity: 0, leagueImportance: 0, derbyBonus: 0 })).toBe(0);
  });

  it('does not care which side is the bigger team, and caps the derby bonus', () => {
    const a = popularityScore({ homePopularity: 90, awayPopularity: 20, leagueImportance: 60, derbyBonus: 0 });
    const b = popularityScore({ homePopularity: 20, awayPopularity: 90, leagueImportance: 60, derbyBonus: 0 });
    expect(a).toBe(b);
    expect(popularityScore({ homePopularity: 10, awayPopularity: 10, leagueImportance: 10, derbyBonus: 99 })).toBe(popularityScore({ homePopularity: 10, awayPopularity: 10, leagueImportance: 10, derbyBonus: 15 }));
  });
});

describe('scoreMatch / rankBigMatches', () => {
  it('lists El Clásico first, marked as a derby, and leaves out unknown teams', () => {
    const matches = [m(1, 140, 1, 1), m(2, 140, 541, 529), m(3, 3, 541, 1)];
    const ranked = rankBigMatches(matches, reg);
    expect(ranked.map((r) => r.match.id)).toEqual([2, 3]);
    expect(ranked[0]!.derby).toBe('El Clásico');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked.every((r) => r.score >= BIG_MATCH_MIN_SCORE)).toBe(true);
  });

  it('finds the rivalry whichever team is at home', () => {
    expect(scoreMatch(m(1, 140, 529, 541), reg).derby).toBe('El Clásico');
  });

  it('a season-specific row overrides the every-season row only for that season', () => {
    const base = scoreMatch(m(1, 3, 541, 1), reg).score;
    expect(scoreMatch(m(1, 3, 541, 1, 2027), reg).score).toBeLessThan(base);
    expect(scoreMatch(m(1, 3, 541, 1, 2026), reg).score).toBe(base);
  });

  it('a league missing from the registry gets the default importance, never an error', () => {
    expect(scoreMatch(m(1, 99999, 541, 529), reg).score).toBeGreaterThan(0);
  });

  it('keeps input order on ties and honours the limit', () => {
    const matches = [m(10, 140, 541, 1), m(11, 140, 541, 1), m(12, 140, 541, 1)];
    expect(rankBigMatches(matches, reg, { min: 0, limit: 2 }).map((r) => r.match.id)).toEqual([10, 11]);
  });
});

describe('leagueImportance', () => {
  it('reads the registry and falls back to the default for an unlisted league', () => {
    expect(leagueImportance(reg, 140, 2026)).toBe(90);
    expect(leagueImportance(reg, 48, 2026)).toBe(DEFAULT_LEAGUE_IMPORTANCE);
  });
});

describe('thaiMatches', () => {
  it('keeps only matches in leagues flagged Thai, in order', () => {
    const matches = [m(1, 140, 541, 529), m(2, 296, 2780, 2786), m(3, 296, 1, 1)];
    expect(thaiMatches(matches, reg).map((x) => x.id)).toEqual([2, 3]);
  });
});

/**
 * Popularity only orders what the site shows. It must never reach a probability, an edge, a pick,
 * the featured list or the AI: none of that code may so much as mention the registry.
 */
describe('popularity never touches probabilities, edges, picks or the featured list', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const dirs = ['packages/analysis/src', 'workers/analysis/src', 'packages/ai/src', 'packages/football/src', 'workers/odds-sync/src'];
  const files = (dir: string): string[] =>
    statSync(dir, { throwIfNoEntry: false })?.isDirectory()
      ? readdirSync(dir).flatMap((f) => {
          const p = join(dir, f);
          return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
        })
      : [];
  const sources = dirs.flatMap((d) => files(join(root, d)));
  const FORBIDDEN = /popularity|rankBigMatches|scoreMatch|team_popularity|league_importance|rivalr|big[_ -]?match/i;

  it('scans the model, pick, featured and AI code', () => {
    expect(sources.length).toBeGreaterThan(30);
    expect(sources.some((f) => f.replace(/\\/g, '/').endsWith('packages/analysis/src/featured.ts'))).toBe(true);
    expect(sources.some((f) => f.replace(/\\/g, '/').endsWith('packages/analysis/src/candidates.ts'))).toBe(true);
  });

  it('none of it mentions popularity, the registry or big matches', () => {
    const offenders = sources.filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8'))).map((f) => f.replace(root, ''));
    expect(offenders).toEqual([]);
  });
});

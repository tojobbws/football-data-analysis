import { describe, expect, it } from 'vitest';
import {
  assessDataSupport,
  buildTemplateText,
  matrixExpectedGoals,
  previewScoreMatrix,
  previewStageFor,
  topScorelines,
  type PreviewFacts,
  type PreviewTeam,
} from '../src/preview.js';

const team = (name: string, over: Partial<PreviewTeam> = {}): PreviewTeam => ({
  name,
  form: [
    { venue: 'H', result: 'W', goalsFor: 2, goalsAgainst: 0, xgFor: 1.8, xgAgainst: 0.6 },
    { venue: 'A', result: 'D', goalsFor: 1, goalsAgainst: 1, xgFor: 1.1, xgAgainst: 1.3 },
    { venue: 'H', result: 'L', goalsFor: 0, goalsAgainst: 1, xgFor: 0.9, xgAgainst: 1.4 },
    { venue: 'A', result: 'W', goalsFor: 3, goalsAgainst: 1, xgFor: 2.2, xgAgainst: 0.8 },
    { venue: 'H', result: 'W', goalsFor: 1, goalsAgainst: 0, xgFor: 1.5, xgAgainst: 0.5 },
  ],
  formSummary: null, // the template derives it from `form` when the job did not fill it
  standing: { rank: 3, played: 8, points: 17, win: 5, draw: 2, lose: 1, goalsFor: 14, goalsAgainst: 6 },
  injuries: [{ player: 'A. Player', type: 'Missing Fixture', reason: 'Knee Injury' }],
  starters: null,
  modelMatches: 22,
  ...over,
});

const facts = (over: Partial<PreviewFacts> = {}): PreviewFacts => ({
  fixture: { home: 'Arsenal', away: 'Chelsea', league: 'Premier League', leagueCountry: 'England', leagueType: 'League', round: 'Regular Season - 9', kickoffAt: '2026-10-10T14:00:00Z', stage: 'EARLY' },
  home: team('Arsenal'),
  away: team('Chelsea'),
  model: {
    modelVersionId: 'ensemble-v0.1',
    computedAt: '2026-10-09T10:00:00Z',
    p: { home: 0.52, draw: 0.24, away: 0.24 },
    expectedGoals: { home: 1.7, away: 1.0 },
    scorelines: [
      { home: 1, away: 0, p: 0.12 },
      { home: 2, away: 0, p: 0.1 },
      { home: 1, away: 1, p: 0.09 },
    ],
    overUnder: { line: 2.5, pOver: 0.55 },
    matchesUsed: 400,
    xgShare: 0.95,
    crossLeague: null,
  },
  market: { home: { opening: 1.8, current: 1.75, bookmakers: 6 }, draw: { opening: 3.8, current: 3.9, bookmakers: 6 }, away: { opening: 4.2, current: 4.4, bookmakers: 6 } },
  apiPrediction: null,
  h2h: [{ kickoffAt: '2026-03-01T15:00:00Z', home: 'Chelsea', away: 'Arsenal', homeGoals: 1, awayGoals: 2 }],
  ...over,
});

describe('previewStageFor', () => {
  const ko = new Date('2026-10-10T14:00:00Z');
  const at = (minutesBefore: number) => new Date(ko.getTime() - minutesBefore * 60_000);
  it('EARLY within the window, LINEUP once XIs are confirmed, nothing in the last 15 minutes', () => {
    expect(previewStageFor(ko, at(72 * 60), false)).toBeNull();
    expect(previewStageFor(ko, at(40 * 60), false)).toBe('EARLY');
    expect(previewStageFor(ko, at(60), false)).toBe('EARLY');
    expect(previewStageFor(ko, at(60), true)).toBe('LINEUP');
    expect(previewStageFor(ko, at(90), true)).toBe('EARLY');
    expect(previewStageFor(ko, at(10), true)).toBeNull();
    expect(previewStageFor(ko, at(-5), false)).toBeNull();
  });
});

describe('scorelines', () => {
  it('ranks the most likely scorelines of the blended matrix', () => {
    const matrix = previewScoreMatrix({ lambda: 1.7, mu: 1.0, rho: -0.05 });
    const top = topScorelines(matrix, 3);
    expect(top).toHaveLength(3);
    expect(top[0]!.p).toBeGreaterThanOrEqual(top[1]!.p);
    expect(top[1]!.p).toBeGreaterThanOrEqual(top[2]!.p);
    // home favoured: every top scoreline has the home side level or ahead, and low totals
    for (const s of top) {
      expect(s.home).toBeGreaterThanOrEqual(s.away);
      expect(s.home + s.away).toBeLessThanOrEqual(3);
    }
    const eg = matrixExpectedGoals(matrix);
    expect(eg.home).toBeCloseTo(1.7, 1);
    expect(eg.away).toBeCloseTo(1.0, 1);
  });

  it('cross-league blend moves the expected goals towards the cross-league model', () => {
    const cupOnly = matrixExpectedGoals(previewScoreMatrix({ lambda: 1.0, mu: 1.0, rho: 0 }));
    const blended = matrixExpectedGoals(previewScoreMatrix({ lambda: 1.0, mu: 1.0, rho: 0, crossLeague: { lambda: 2.0, mu: 0.5, weightCupOnly: 0.5 } }));
    expect(blended.home).toBeGreaterThan(cupOnly.home);
    expect(blended.away).toBeLessThan(cupOnly.away);
  });
});

describe('assessDataSupport', () => {
  it('GOOD when everything is there', () => {
    const s = assessDataSupport(facts());
    expect(s.level).toBe('GOOD');
    expect(s.notes).toEqual([]);
  });

  it('THIN for a cross-league cup with few cup matches, with the reason spelled out', () => {
    const s = assessDataSupport(
      facts({
        fixture: { ...facts().fixture, league: 'ASEAN Club Championship', leagueCountry: 'World', leagueType: 'Cup' },
        model: { ...facts().model!, matchesUsed: 40, crossLeague: { cupMatchesUsed: 40 } },
      }),
    );
    expect(s.level).toBe('THIN');
    expect(s.notes[0]).toContain('บอลถ้วยที่ทีมมาจากคนละลีก');
    expect(s.notes[0]).toContain('40 นัด');
  });

  it('LIMITED for an international cup without the cross-league model, THIN when the model is missing', () => {
    const cup = facts({ fixture: { ...facts().fixture, league: 'UEFA Champions League', leagueCountry: 'World', leagueType: 'Cup' }, model: { ...facts().model!, matchesUsed: 120 } });
    expect(assessDataSupport(cup)).toMatchObject({ level: 'LIMITED' });
    expect(assessDataSupport(cup).notes[0]).toContain('บอลถ้วยระหว่างประเทศ');
    const none = assessDataSupport(facts({ model: null }));
    expect(none.level).toBe('THIN');
    expect(none.notes[0]).toContain('ยังไม่มีตัวเลขจากโมเดล');
  });

  it('team history and xG gaps lower the level; odds / injuries / h2h gaps are only noted', () => {
    const one = assessDataSupport(facts({ away: team('Chelsea', { modelMatches: 2 }) }));
    expect(one.level).toBe('LIMITED');
    expect(one.notes[0]).toContain('Chelsea');
    const both = assessDataSupport(facts({ home: team('Arsenal', { modelMatches: 3 }), away: team('Chelsea', { modelMatches: 2 }) }));
    expect(both.level).toBe('THIN');

    const noXg = facts();
    for (const t of [noXg.home, noXg.away]) t.form = t.form.map((r) => ({ ...r, xgFor: null, xgAgainst: null }));
    expect(assessDataSupport(noXg)).toMatchObject({ level: 'LIMITED' });
    expect(assessDataSupport(noXg).notes).toContainEqual(expect.stringContaining('xG'));

    const minor = assessDataSupport(facts({ market: null, h2h: [], home: team('Arsenal', { injuries: [] }), away: team('Chelsea', { injuries: [] }) }));
    expect(minor.level).toBe('GOOD');
    expect(minor.notes).toHaveLength(3);
  });

  it('short or missing recent form', () => {
    expect(assessDataSupport(facts({ away: team('Chelsea', { form: facts().away.form.slice(0, 2) }) }))).toMatchObject({ level: 'LIMITED' });
    expect(assessDataSupport(facts({ away: team('Chelsea', { form: [] }) }))).toMatchObject({ level: 'THIN' });
  });
});

describe('buildTemplateText', () => {
  it('writes every number from the facts and flags limited data', () => {
    const f = facts();
    const t = buildTemplateText(f, assessDataSupport(f));
    expect(t.overview_th).toContain('Arsenal ชนะ 52%');
    expect(t.overview_th).toContain('ตัวเลขเอียงไปทาง Arsenal');
    expect(t.overview_th).toContain('ตลาดมองไปทางเดียวกัน');
    expect(t.home_th).toContain('ชนะ 3 เสมอ 1 แพ้ 1');
    expect(t.home_th).toContain('อันดับ 3');
    expect(t.home_th).toContain('A. Player');
    expect(t.score_th).toContain('Arsenal 1-0 Chelsea (12%)');
    expect(t.score_th).toContain('ประตูคาดหวัง 1.70 ต่อ 1.00 โอกาสเกิน 2.5 ประตู 55%');

    const thin = facts({ model: null });
    const tt = buildTemplateText(thin, assessDataSupport(thin));
    expect(tt.overview_th).toContain('ข้อมูลน้อย');
    expect(tt.score_th).toContain('ยังไม่มีสกอร์คาดการณ์');
  });
});

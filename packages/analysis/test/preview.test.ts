import { describe, expect, it } from 'vitest';
import {
  assessDataSupport,
  buildTemplateText,
  bothTeamsScore,
  compareViews,
  confidenceLevel,
  dataGaps,
  previewFocus,
  EVEN,
  goalBands,
  matrixExpectedGoals,
  previewScoreMatrix,
  previewStageFor,
  restDays,
  topScorelines,
  type PreviewFacts,
  type PreviewTeam,
} from '../src/preview.js';
import { priceSelection } from '../src/markets.js';

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

describe('goalBands', () => {
  it('splits total goals into 0-1 / 2 / 3+, summing to 1', () => {
    const b = goalBands(previewScoreMatrix({ lambda: 1.7, mu: 1.0, rho: -0.05 }));
    expect(b.upTo1 + b.two + b.threePlus).toBeCloseTo(1, 9);
    for (const p of [b.upTo1, b.two, b.threePlus]) expect(p).toBeGreaterThan(0);
  });

  it('3+ can be the likeliest band while the top scoreline is a low score (Liverpool–City, xG 1.48–1.57)', () => {
    const matrix = previewScoreMatrix({ lambda: 1.48, mu: 1.57, rho: -0.05 });
    const b = goalBands(matrix);
    expect(topScorelines(matrix, 1)[0]!.home + topScorelines(matrix, 1)[0]!.away).toBeLessThanOrEqual(2);
    expect(b.threePlus).toBeGreaterThan(0.5);
    expect(b.threePlus).toBeGreaterThan(b.two);
    expect(b.threePlus).toBeGreaterThan(b.upTo1);
  });

  it('3+ equals over 2.5 priced from the same matrix', () => {
    const matrix = previewScoreMatrix({ lambda: 1.3, mu: 1.1, rho: -0.08 });
    const over = priceSelection(matrix, { market: 'OVER_UNDER', selection: 'OVER', line: 2.5 });
    expect(goalBands(matrix).threePlus).toBeCloseTo(over.probability, 6);
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
    expect(s.notes[0]).toContain('มีเพียง 40 นัด');
  });

  it('LIMITED for a cross-league cup with a long history, without calling hundreds of matches few', () => {
    const s = assessDataSupport(facts({ fixture: { ...facts().fixture, league: 'UEFA Champions League', leagueCountry: 'World', leagueType: 'Cup' }, model: { ...facts().model!, crossLeague: { cupMatchesUsed: 900 } } }));
    expect(s.level).toBe('LIMITED');
    expect(s.notes[0]).toContain('บอลถ้วยที่ทีมมาจากคนละลีก');
    expect(s.notes[0]).not.toContain('900');
    expect(s.notes[0]).not.toContain('เพียง');
  });

  it('LIMITED for an international cup without the cross-league model, THIN when the model is missing', () => {
    const cup = facts({ fixture: { ...facts().fixture, league: 'UEFA Champions League', leagueCountry: 'World', leagueType: 'Cup' }, model: { ...facts().model!, matchesUsed: 120 } });
    expect(assessDataSupport(cup)).toMatchObject({ level: 'LIMITED' });
    expect(assessDataSupport(cup).notes[0]).toContain('บอลถ้วยระหว่างประเทศ');
    const none = assessDataSupport(facts({ model: null }));
    expect(none.level).toBe('THIN');
    expect(none.notes[0]).toContain('ยังไม่มีตัวเลขจากโมเดล');
  });

  it('team history and xG gaps lower the level; odds / injuries / h2h gaps are not noted at all', () => {
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
    expect(minor.notes).toEqual([]);
  });

  it('short or missing recent form', () => {
    expect(assessDataSupport(facts({ away: team('Chelsea', { form: facts().away.form.slice(0, 2) }) }))).toMatchObject({ level: 'LIMITED' });
    expect(assessDataSupport(facts({ away: team('Chelsea', { form: [] }) }))).toMatchObject({ level: 'THIN' });
  });
});

describe('compareViews', () => {
  it('model, market and recent form all lean the same way: no disagreement', () => {
    const v = compareViews(facts());
    expect(v).toMatchObject({ model: 'Arsenal', market: 'Arsenal', recentForm: EVEN, recentXg: EVEN, otherModel: null, disagreements: [] });
    // the market's 1X2 with the margin taken out, summing to 1
    expect(v.marketP!.home + v.marketP!.draw + v.marketP!.away).toBeCloseTo(1, 3);
    expect(v.marketP!.home).toBeCloseTo(0.542, 2);
  });

  it('sources that point away from the model are listed (Liverpool–Villarreal: model 80%, market 63%, Villarreal the better recent xG)', () => {
    const better = { venue: 'H' as const, result: 'W' as const, goalsFor: 2, goalsAgainst: 0, xgFor: 2.4, xgAgainst: 0.8 };
    const f = facts({
      fixture: { ...facts().fixture, home: 'Liverpool', away: 'Villarreal' },
      home: team('Liverpool'),
      away: team('Villarreal', { form: Array(5).fill(better) }),
      model: { ...facts().model!, p: { home: 0.8024, draw: 0.0854, away: 0.1122 } },
      market: { home: { opening: 1.47, current: 1.53, bookmakers: 10 }, draw: { opening: 4.6, current: 4.6, bookmakers: 10 }, away: { opening: 6.1, current: 5.72, bookmakers: 10 } },
    });
    const v = compareViews(f, { home: 0.3, away: 0.45 });
    expect(v.model).toBe('Liverpool');
    expect(v.market).toBe('Liverpool');
    expect(v.recentForm).toBe('Villarreal');
    expect(v.recentXg).toBe('Villarreal');
    expect(v.otherModel).toBe('Villarreal');
    expect(v.marketP!.home).toBeCloseTo(0.625, 2);
    expect(v.disagreements).toEqual(['MARKET_GAP', 'FORM', 'XG', 'OTHER_MODEL']);

    // the market on the other side is a plain MARKET disagreement (and no gap on top of it)
    const flipped = compareViews({ ...f, market: { home: { opening: 3, current: 3.2, bookmakers: 6 }, draw: { opening: 3.4, current: 3.4, bookmakers: 6 }, away: { opening: 2.2, current: 2.1, bookmakers: 6 } } });
    expect(flipped.disagreements[0]).toBe('MARKET');
    expect(flipped.disagreements).not.toContain('MARKET_GAP');
  });

  it('an even model has nothing to disagree with; missing sources are null', () => {
    const v = compareViews(facts({ model: { ...facts().model!, p: { home: 0.36, draw: 0.3, away: 0.34 } }, market: null }));
    expect(v).toMatchObject({ model: EVEN, market: null, marketP: null, disagreements: [] });
    expect(compareViews(facts({ model: null })).model).toBeNull();
  });
});

describe('dataGaps', () => {
  it('no H2H, no lineup, no injury report, no price on the pick line: each listed, none of them changes the level', () => {
    expect(dataGaps({ h2hMatches: 0, lineupsOut: false, injuryReports: 0, pickLinePriced: false })).toEqual([
      'ไม่มีประวัติพบกันในฐานข้อมูลของเรา',
      'ยังไม่ประกาศตัวจริง',
      'แหล่งข้อมูลไม่มีรายงานผู้เล่นบาดเจ็บ ซึ่งไม่ได้แปลว่าไม่มีใครเจ็บ',
      'ราคาล่าสุดไม่มีเส้นของเข็มทิศเกมครบทั้งสองฝั่ง',
    ]);
    const f = facts({ h2h: [], home: team('Arsenal', { injuries: [] }), away: team('Chelsea', { injuries: [] }) });
    expect(assessDataSupport(f).level).toBe('GOOD');
  });

  it('nothing missing, or no pick (null): no line', () => {
    expect(dataGaps({ h2hMatches: 3, lineupsOut: true, injuryReports: 2, pickLinePriced: true })).toEqual([]);
    expect(dataGaps({ h2hMatches: 3, lineupsOut: true, injuryReports: 2, pickLinePriced: null })).toEqual([]);
  });
});

describe('previewFocus', () => {
  it("the model's lean is the main side; an even model or no model falls back to the home side", () => {
    expect(previewFocus(facts(), compareViews(facts()))).toEqual({ mainSide: 'HOME', main: 'Arsenal', opponent: 'Chelsea' });
    const awayLean = facts({ model: { ...facts().model!, p: { home: 0.2, draw: 0.25, away: 0.55 } } });
    expect(previewFocus(awayLean, compareViews(awayLean))).toEqual({ mainSide: 'AWAY', main: 'Chelsea', opponent: 'Arsenal' });
    const even = facts({ model: { ...facts().model!, p: { home: 0.36, draw: 0.3, away: 0.34 } } });
    expect(previewFocus(even, compareViews(even)).mainSide).toBe('HOME');
    expect(previewFocus(facts({ model: null })).mainSide).toBe('HOME');
  });
});

describe('confidenceLevel', () => {
  const tested = (over: Partial<PreviewFacts> = {}) => {
    const f = facts({ ...over, model: { ...facts().model!, tested: true, ...(over.model ?? {}) } });
    f.views = compareViews(f);
    return f;
  };

  it('HIGH only when the data is enough, the model is tested, its lean is clear and nothing points elsewhere', () => {
    const clear = tested({ model: { ...facts().model!, tested: true, p: { home: 0.6, draw: 0.22, away: 0.18 } }, market: { home: { opening: 1.6, current: 1.6, bookmakers: 6 }, draw: { opening: 4, current: 4, bookmakers: 6 }, away: { opening: 5.5, current: 5.5, bookmakers: 6 } } });
    expect(confidenceLevel(clear, { level: 'GOOD' })).toMatchObject({ level: 'HIGH' });
    // the same match on limited data
    expect(confidenceLevel(clear, { level: 'LIMITED' })).toEqual({ level: 'MEDIUM', notes: ['ข้อมูลบางส่วนจำกัด'] });
  });

  it('MEDIUM for a slight lean, the market far from the model, or recent form against it', () => {
    // 52% vs 24%: a clear lean, but the market (54%) and form agree -> only the slight-lean rule does not fire
    expect(confidenceLevel(tested(), { level: 'GOOD' }).level).toBe('HIGH');
    const slight = tested({ model: { ...facts().model!, tested: true, p: { home: 0.42, draw: 0.3, away: 0.28 } } });
    expect(confidenceLevel(slight, { level: 'GOOD' })).toEqual({ level: 'MEDIUM', notes: ['โมเดลเอนเพียงเล็กน้อย'] });
    const gap = tested({ model: { ...facts().model!, tested: true, p: { home: 0.72, draw: 0.16, away: 0.12 } } });
    expect(confidenceLevel(gap, { level: 'GOOD' }).notes).toContain('ตลาดเห็นทางเดียวกันแต่ให้โอกาสน้อยกว่าโมเดลมาก');
  });

  it('LOW without a model, on thin data, while the model is still being measured, or when the market favours the other side', () => {
    expect(confidenceLevel(facts({ model: null }), { level: 'THIN' })).toEqual({ level: 'LOW', notes: ['โมเดลยังไม่มีตัวเลขสำหรับคู่นี้'] });
    expect(confidenceLevel(tested(), { level: 'THIN' }).level).toBe('LOW');
    const untested = facts({ model: { ...facts().model!, tested: false } });
    expect(confidenceLevel(untested, { level: 'GOOD' })).toEqual({ level: 'LOW', notes: ['โมเดลยังอยู่ระหว่างการวัดผลในรายการนี้'] });
    const flipped = tested({ market: { home: { opening: 3, current: 3.2, bookmakers: 6 }, draw: { opening: 3.4, current: 3.4, bookmakers: 6 }, away: { opening: 2.2, current: 2.1, bookmakers: 6 } } });
    expect(confidenceLevel(flipped, { level: 'GOOD' }).notes).toContain('ตลาดให้น้ำหนักอีกฝั่ง');
  });
});

describe('bothTeamsScore', () => {
  it('the chance that neither side keeps a clean sheet, from the same matrix as the goal bands', () => {
    const m = [
      [0.1, 0.1],
      [0.2, 0.6],
    ];
    expect(bothTeamsScore(m)).toBeCloseTo(0.6, 12);
    const real = previewScoreMatrix({ lambda: 1.5, mu: 1.2, rho: -0.05 });
    expect(bothTeamsScore(real)).toBeGreaterThan(0.3);
    expect(bothTeamsScore(real)).toBeLessThan(1 - goalBands(real).upTo1);
  });
});

describe('buildTemplateText', () => {
  it('v1.1 parts: headline, each side in turn, team news, analysis and facts, every number from the facts', () => {
    const f = facts();
    const t = buildTemplateText(f, assessDataSupport(f));
    expect(Object.keys(t)).toEqual(['headline_th', 'overview_th', 'home_th', 'away_th', 'team_news_th', 'analysis_th', 'facts_th']);
    expect(t.headline_th).toContain('Arsenal พบ Chelsea');
    expect(t.overview_th).toContain('Arsenal ชนะ 52%');
    expect(t.overview_th).toContain('ตัวเลขเอียงไปทาง Arsenal');
    expect(t.overview_th).toContain('ตลาดมองไปทางเดียวกัน');
    expect(t.home_th).toContain('Arsenal: 5 นัดล่าสุด ชนะ 3 เสมอ 1 แพ้ 1 ยิงได้ 7 ประตู');
    expect(t.home_th).toContain('เสีย 3 ประตูใน 5 นัดล่าสุด');
    expect(t.away_th.startsWith('Chelsea: ')).toBe(true);
    // absences are the team news part's, not a side's
    expect(t.team_news_th).toContain('A. Player');
    expect(t.home_th).not.toContain('A. Player');
    expect(t.team_news_th).toContain('ยังไม่ประกาศรายชื่อตัวจริง');
    expect(t.analysis_th).toContain('โมเดลคาดประตู (xG) Arsenal 1.70 ต่อ Chelsea 1.00');
    expect(t.analysis_th).toContain('Arsenal 1-0 Chelsea (12%)');
    expect(t.facts_th.length).toBeGreaterThan(0);
    expect(t.facts_th.length).toBeLessThanOrEqual(5);
    for (const x of t.facts_th) expect(x).not.toMatch(/%/);
    for (const x of [...Object.values(t).filter((v): v is string => typeof v === 'string'), ...t.facts_th]) expect(x).not.toMatch(/[—–]/);
  });

  it('no model: says so in the overview and the analysis', () => {
    const thin = facts({ model: null });
    const t = buildTemplateText(thin, assessDataSupport(thin));
    expect(t.overview_th).toContain('โมเดลยังไม่มีตัวเลข');
    expect(t.analysis_th).toContain('ยังไม่มีสกอร์ที่เป็นไปได้มากที่สุด');
  });

  it('a market far from the model, a missing key player, a rest gap and recent form against the model are named', () => {
    const f = facts({
      home: team('Arsenal', { restDays: 3, form: Array(5).fill({ venue: 'H', result: 'L', goalsFor: 0, goalsAgainst: 2, xgFor: 0.7, xgAgainst: 1.9 }) }),
      away: team('Chelsea', { restDays: 6, injuries: [{ player: 'C. Palmer', type: 'Missing Fixture', reason: 'Injury', isKeyPlayer: true, goals: 5, assists: 3 }] }),
      model: { ...facts().model!, p: { home: 0.72, draw: 0.16, away: 0.12 } },
    });
    f.views = compareViews(f);
    const t = buildTemplateText(f, assessDataSupport(f));
    expect(t.overview_th).toContain('ตลาดมองไปทางเดียวกันแต่ให้โอกาสเพียง 54%');
    expect(t.analysis_th).toContain('Chelsea ขาด C. Palmer');
    expect(t.analysis_th).toContain('ผลงานช่วงหลัง Chelsea ทำได้ดีกว่า ซึ่งสวนกับตัวเลขของโมเดล');
    expect(t.analysis_th).toContain('Arsenal มีเวลาพักน้อยกว่า');
    expect(t.team_news_th).toContain('Chelsea มีรายงานตัวเจ็บ/ติดโทษ 1 คน (C. Palmer)');
  });
});

describe('restDays', () => {
  it('whole days since the last match; nothing after an off-season-length gap or without a last match', () => {
    const ko = new Date('2026-10-18T01:00:00Z');
    expect(restDays(ko, new Date('2026-10-14T19:00:00Z'))).toBe(3);
    expect(restDays(ko, new Date('2026-10-04T01:00:00Z'))).toBe(14);
    expect(restDays(ko, new Date('2026-05-25T10:00:00Z'))).toBeNull();
    expect(restDays(ko, null)).toBeNull();
  });

  it('counts elapsed time, so a kickoff across Thai midnight is no extra day (Al Diriyah: 17 Oct 18:00 UTC = 18 Oct 01:00 TH, then 20 Oct 15:00 UTC)', () => {
    expect(restDays(new Date('2026-10-20T15:00:00Z'), new Date('2026-10-17T18:00:00Z'))).toBe(2);
    // the same two kickoffs written with a +07:00 offset give the same answer
    expect(restDays(new Date('2026-10-20T22:00:00+07:00'), new Date('2026-10-18T01:00:00+07:00'))).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import { validatePickNote } from '../src/pick-note.js';
import { allowedPercents, validatePreviewOutput, withoutThousandsSeparators } from '../src/preview.js';

const input = {
  fixture: { home: 'Arsenal', away: 'Chelsea', league: 'Premier League', stage: 'EARLY' },
  home: { name: 'Arsenal', form: [{ result: 'W', goalsFor: 2, goalsAgainst: 0, xgFor: 1.8 }], standing: { rank: 3, points: 17 }, injuries: [], starters: null, modelMatches: 22, restDays: 4 },
  away: { name: 'Chelsea', form: [], standing: { rank: 9, points: 11 }, injuries: [], starters: null, modelMatches: 20, restDays: 6 },
  model: { p: { home: 0.52, draw: 0.24, away: 0.24 }, expectedGoals: { home: 1.7, away: 1.0 }, scorelines: [{ home: 1, away: 0, p: 0.12 }, { home: 2, away: 0, p: 0.1 }] },
  views: { model: 'Arsenal', market: 'Arsenal', recentForm: 'EVEN', recentXg: null, otherModel: null, marketP: { home: 0.5, draw: 0.27, away: 0.23 }, disagreements: [] as string[] },
  h2h: [{ home: 'Chelsea', away: 'Arsenal', homeGoals: 1, awayGoals: 2 }],
  data_support: { level: 'GOOD', notes_th: [] },
};

const ok = {
  headline_th: 'Arsenal ฟอร์มดีรับมือ Chelsea',
  overview_th: 'โมเดลให้ Arsenal ชนะ 52% ขณะที่ Chelsea ได้ 24% ตลาดมองไปทางเดียวกันที่ 50%',
  home_th: 'Arsenal ฟอร์มดี นัดล่าสุดชนะ 2-0 ด้วย xG 1.8 อยู่อันดับ 3 และพักมา 4 วัน แต่ข้อมูลเกมรับยังมีแค่นัดเดียว',
  away_th: 'Chelsea อยู่อันดับ 9 และพักมา 6 วัน ยังไม่มีผลล่าสุดในระบบ จึงอ่านได้แค่จากตารางคะแนนเท่านั้น',
  team_news_th: 'ยังไม่ประกาศรายชื่อตัวจริงของทั้งสองทีม',
  analysis_th: 'Arsenal ฟอร์มช่วงหลังดีกว่า โมเดลคาดประตู 1.7 ต่อ 1.0 สกอร์ที่โมเดลให้โอกาสสูงสุดคือ 1-0 (12%) รองลงมา 2-0',
  facts_th: ['Arsenal อยู่อันดับ 3 มี 17 คะแนน', 'Chelsea อยู่อันดับ 9 มี 11 คะแนน', 'เจอกันครั้งล่าสุด Chelsea แพ้ Arsenal 1-2'],
};

describe('validatePreviewOutput: data fully there, numbers consistent', () => {
  it('accepts text whose numbers, percentages and scorelines all trace back to the input', () => {
    const v = validatePreviewOutput(ok, input);
    expect(v.violations).toEqual([]);
    expect(v.text).toEqual(ok);
  });

  it('a stray semicolon is turned into a space instead of costing a retry, in a fact too', () => {
    const v = validatePreviewOutput({ ...ok, overview_th: 'โมเดลให้ Arsenal ชนะ 52%; ขณะที่ Chelsea ได้ 24% ตลาดมองไปทางเดียวกัน', facts_th: [...ok.facts_th.slice(0, 2), 'Arsenal; อยู่อันดับ 3 ของตาราง'] }, input);
    expect(v.ok).toBe(true);
    expect(v.text!.overview_th).toBe('โมเดลให้ Arsenal ชนะ 52% ขณะที่ Chelsea ได้ 24% ตลาดมองไปทางเดียวกัน');
    expect(v.text!.facts_th[2]).toBe('Arsenal อยู่อันดับ 3 ของตาราง');
  });
});

describe('validatePreviewOutput: numbers, lines and scorelines that are not in the facts', () => {
  it('rejects invented numbers, foreign scorelines and gambling words, keeping every reason', () => {
    const v = validatePreviewOutput({ ...ok, overview_th: 'Arsenal น่าจะชนะ 65% แทงได้เลย Chelsea ลำบาก', analysis_th: 'สกอร์ที่โมเดลมองน่าจะออก 3-1 หรือ 2-0 ก็ได้ ตามตัวเลขประตูคาดหวัง 1.7 ต่อ 1.0 ของโมเดล' }, input);
    expect(v.ok).toBe(false);
    expect(v.text).toBeNull();
    expect(v.violations).toEqual(expect.arrayContaining(['overview_th: number not in input: 65%', 'banned word "แทง"', 'analysis_th: scoreline not from the model: 3-1']));
    expect(v.violations).not.toContainEqual(expect.stringContaining('2-0'));
  });

  it('a percentage must be a chance: xG 1.7 is not "17%", a rank is not a percent', () => {
    expect(allowedPercents(input)).toEqual(expect.arrayContaining([52, 24, 12, 10, 50, 27, 23]));
    expect(validatePreviewOutput({ ...ok, overview_th: 'Arsenal มีโอกาส 17% ที่จะยิงสองลูก Chelsea ลำบาก' }, input).violations).toContain('overview_th: percent is not a chance in the input: 17%');
    expect(validatePreviewOutput({ ...ok, overview_th: 'Arsenal อันดับ 3 มีโอกาส 3% ส่วน Chelsea อันดับ 9' }, input).violations).toContain('overview_th: percent is not a chance in the input: 3%');
  });

  it('no handicap, over/under or odds talk: that is the Game Compass note\'s job', () => {
    const v = validatePreviewOutput({ ...ok, analysis_th: `${ok.analysis_th} เหมาะกับ Over มากกว่า Under และแฮนดิแคปน่าสนใจ` }, input);
    expect(v.violations).toEqual(expect.arrayContaining(['analysis_th: market word', 'banned word "แฮนดิแคป"']));
    // totals are not facts of the preview: an over 2.5 figure is invented
    expect(validatePreviewOutput({ ...ok, home_th: `${ok.home_th} โอกาสเกิน 2.5 ประตูอยู่ที่ 55%` }, input).ok).toBe(false);
  });

  it('the analysis may only quote the model\'s scorelines, the headline and the facts only past results', () => {
    expect(validatePreviewOutput({ ...ok, analysis_th: `${ok.analysis_th} ใกล้เคียงกับที่เคยชนะ 2-1` }, input).violations).toEqual(['analysis_th: scoreline not from the model: 2-1']);
    expect(validatePreviewOutput({ ...ok, away_th: `${ok.away_th} นัดล่าสุดที่เจอกัน Chelsea แพ้ 1-2 ที่บ้าน` }, input).ok).toBe(true);
    expect(validatePreviewOutput({ ...ok, home_th: `${ok.home_th} และเพิ่งชนะ 3-0` }, input).violations).toEqual(['home_th: scoreline not in input: 3-0']);
    expect(validatePreviewOutput({ ...ok, facts_th: [...ok.facts_th, 'Arsenal มีสกอร์ 1-0 เป็นตัวเลือกแรกของโมเดล'] }, input).violations).toEqual(['facts_th: scoreline not in input: 1-0']);
  });

  it('the headline and the facts carry no chance and no model number', () => {
    expect(validatePreviewOutput({ ...ok, facts_th: [...ok.facts_th, 'Arsenal มีโอกาสชนะ 52%'] }, input).violations).toEqual(expect.arrayContaining(['facts_th: no chance belongs here: 52%', 'facts_th: number not in input: 52%']));
    expect(validatePreviewOutput({ ...ok, headline_th: 'Arsenal ลุ้นชนะ 52%' }, input).violations).toContain('headline_th: no chance belongs here: 52%');
    expect(validatePreviewOutput({ ...ok, facts_th: [...ok.facts_th, 'Arsenal คาดยิง 1.7 ประตู'] }, input).violations).toEqual(['facts_th: number not in input: 1.7']);
  });

  it('each side may only quote its own numbers, the team news only the two sides\'', () => {
    // Chelsea's rank (9) and rest days (6) are facts, but not about Arsenal; the model's 52% belongs to the overview
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal อยู่อันดับ 9 และพักมา 6 วัน ฟอร์มยังไม่ชัดนักจากข้อมูลที่มีในระบบตอนนี้' }, input).violations).toEqual(['home_th: number not in input: 9', 'home_th: number not in input: 6']);
    expect(validatePreviewOutput({ ...ok, away_th: `${ok.away_th} โมเดลให้ 52%` }, input).violations).toEqual(['away_th: number not in input: 52%']);
    expect(validatePreviewOutput({ ...ok, team_news_th: 'ยังไม่ประกาศรายชื่อตัวจริง Arsenal อันดับ 3 Chelsea อันดับ 9' }, input).ok).toBe(true);
    expect(validatePreviewOutput({ ...ok, team_news_th: 'ยังไม่ประกาศรายชื่อตัวจริง โมเดลให้ 52%' }, input).violations).toEqual(['team_news_th: number not in input: 52%']);
  });
});

describe('validatePreviewOutput: teams named as the input names them', () => {
  it('the overview names both teams, each side its own team, the headline and every fact at least one', () => {
    expect(validatePreviewOutput({ ...ok, overview_th: 'อาร์เซนอลมีโอกาสชนะ 52% ส่วนเชลซีได้ 24% ตลาดมองตรงกัน' }, input).violations).toEqual([
      'overview_th: does not name Arsenal',
      'overview_th: does not name Chelsea',
    ]);
    expect(validatePreviewOutput({ ...ok, home_th: ok.home_th.replace('Arsenal', 'เจ้าบ้าน') }, input).violations).toEqual(['home_th: does not name Arsenal']);
    expect(validatePreviewOutput({ ...ok, headline_th: 'ศึกใหญ่กลางสัปดาห์' }, input).violations).toEqual(['headline_th: names neither team']);
    expect(validatePreviewOutput({ ...ok, facts_th: [...ok.facts_th, 'เจ้าบ้านอยู่อันดับ 3 ของตาราง'] }, input).violations).toEqual(['facts_th: names neither team: เจ้าบ้านอยู่อันดับ 3 ของตาราง']);
  });
});

describe('validatePreviewOutput: no confirmed lineup', () => {
  it('at EARLY the lineup may only be called not out yet, and an empty injury list is no full squad', () => {
    expect(validatePreviewOutput({ ...ok, home_th: `${ok.home_th} ส่งตัวจริงชุดใหญ่` }, input).violations).toEqual(['home_th: lineup claim before the lineups are out']);
    expect(validatePreviewOutput({ ...ok, team_news_th: 'Chelsea มาแบบเต็มทีม ยังไม่ประกาศรายชื่อตัวจริง' }, input).violations).toEqual(['banned word "เต็มทีม"']);
    // saying they are not out yet is fine, however it is phrased
    for (const said of ['ยังไม่ประกาศรายชื่อตัวจริง', 'ก่อนประกาศตัวจริง', 'ตัวจริงยังไม่ออก', 'รายชื่อตัวจริงของทั้งสองทีมยังไม่ประกาศ']) {
      expect(validatePreviewOutput({ ...ok, team_news_th: `ไม่มีรายงานตัวเจ็บ และ${said}` }, input).ok).toBe(true);
    }
    // at LINEUP the starters are facts
    const lineup = { ...input, fixture: { ...input.fixture, stage: 'LINEUP' } };
    expect(validatePreviewOutput({ ...ok, home_th: `${ok.home_th} ส่งตัวจริงชุดใหญ่` }, lineup).ok).toBe(true);
  });
});

describe('validatePreviewOutput: sources that disagree', () => {
  const split = { ...input, views: { ...input.views, recentForm: 'Chelsea', disagreements: ['MARKET_GAP', 'FORM'] } };

  it('a disagreement listed in views has to be stated in the overview or the analysis', () => {
    const quiet = {
      ...ok,
      overview_th: 'โมเดลให้ Arsenal ชนะ 52% และ Chelsea ได้ 24% เกมนี้เอียงไปทางเจ้าบ้าน',
      analysis_th: 'โมเดลคาดประตู 1.7 ต่อ 1.0 สกอร์ที่โมเดลให้โอกาสสูงสุดคือ 1-0 (12%) รองลงมา 2-0 เจ้าบ้านมีภาษีดีกว่า',
    };
    expect(validatePreviewOutput(quiet, split).violations).toEqual(['disagreement not stated: market', 'disagreement not stated: recent form']);
    const honest = { ...quiet, overview_th: 'โมเดลให้ Arsenal ชนะ 52% แต่ตลาดให้แค่ 50% และฟอร์มช่วงหลัง Chelsea ดีกว่า' };
    expect(validatePreviewOutput(honest, split).ok).toBe(true);
  });

  it('thin data allows no strong claims', () => {
    const thin = { ...input, data_support: { level: 'THIN', notes_th: ['x'] } };
    const strong = { ...ok, overview_th: 'Arsenal ได้เปรียบชัดตามตัวเลขโมเดล 52% ส่วน Chelsea 24%' };
    expect(validatePreviewOutput(strong, thin).violations).toEqual(['overview_th: strong claim on thin data "ได้เปรียบชัด"']);
    expect(validatePreviewOutput(strong, input).ok).toBe(true);
  });
});

describe('validatePreviewOutput: no model', () => {
  it('text from the football facts only passes; model numbers do not exist to quote', () => {
    const none = { ...input, model: null, views: { ...input.views, model: null, disagreements: [] } };
    const text = { ...ok, overview_th: 'Arsenal อันดับ 3 พบ Chelsea อันดับ 9 ตลาดเอนมาทางเจ้าบ้าน', analysis_th: 'โมเดลยังไม่มีตัวเลขสำหรับคู่นี้ จึงอ่านเกมจากฟอร์มของ Arsenal และ Chelsea เท่านั้น' };
    expect(validatePreviewOutput(text, none).ok).toBe(true);
    expect(validatePreviewOutput(ok, none).violations).toEqual(expect.arrayContaining(['overview_th: number not in input: 52%', 'analysis_th: scoreline not from the model: 1-0']));
  });
});

describe('validatePreviewOutput: shape and length', () => {
  it('rejects empty or missing parts, too few or too many facts, malformed answers and a write-up that runs long', () => {
    expect(validatePreviewOutput({ ...ok, analysis_th: '' }, input).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput({ ...ok, headline_th: undefined }, input).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput({ ...ok, facts_th: ok.facts_th.slice(0, 2) }, input).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput({ ...ok, facts_th: [...ok.facts_th, ...ok.facts_th] }, input).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput(null, input).ok).toBe(false);
    // every part within its own limit, the whole past about 800 words
    const pad = (s: string, n: number) => (s + ' ข้อมูลเพิ่มเติม'.repeat(80)).slice(0, n);
    const long = { ...ok, home_th: pad(ok.home_th, 880), away_th: pad(ok.away_th, 880), analysis_th: pad(ok.analysis_th, 1080), team_news_th: pad(ok.team_news_th, 590), overview_th: pad(ok.overview_th, 390) };
    expect(validatePreviewOutput(long, input).violations).toEqual([expect.stringMatching(/^too long: \d+ characters$/)]);
  });
});

describe('validatePickNote', () => {
  const pickInput = { ...input, pick: { label: 'Arsenal -0.5', market: 'ASIAN_HANDICAP', line: -0.5, modelChance: 0.6, marketChance: 0.52, differencePts: 8 } };

  it('accepts a plain note: what the view needs, the gap, a fact and the risk', () => {
    expect(validatePickNote({ pick_th: 'ต้องให้ Arsenal ชนะ โมเดลให้โอกาส 60% ตลาดให้ 52% นัดล่าสุดชนะ 2-0 แต่ข้อมูลของ Chelsea ยังน้อย จึงมีความไม่แน่นอนสูง' }, pickInput).violations).toEqual([]);
  });

  it('rejects a note that restates the pick, stiff wording, a claim that the market is wrong, or one too long', () => {
    expect(validatePickNote({ pick_th: 'มุมมองคือ Arsenal -0.5: ชนะถือว่าถูก แพ้หรือเสมอถือว่าผิด' }, pickInput).violations).toEqual(['restates the pick at the start']);
    expect(validatePickNote({ pick_th: 'Arsenal -0.5 คือมุมมองของโมเดลในเกมนี้ที่ต่างจากตลาด' }, pickInput).violations).toEqual(['restates the pick at the start']);
    expect(validatePickNote({ pick_th: 'โมเดลสูงกว่าตลาด 8 จุดเปอร์เซ็นต์; ฟอร์มดี' }, pickInput).violations).toEqual(['banned word "จุดเปอร์เซ็นต์"']);
    expect(validatePickNote({ pick_th: 'ต้องให้ Arsenal ชนะ โมเดลให้ 60%; ตลาดให้ 52%' }, pickInput).text).toBe('ต้องให้ Arsenal ชนะ โมเดลให้ 60% ตลาดให้ 52%');
    expect(validatePickNote({ pick_th: 'ตลาดประเมินพลาด Arsenal ชนะแน่นอน' }, pickInput).violations).toEqual(['banned word "ประเมินพลาด"', 'banned word "แน่นอน"']);
    expect(validatePickNote({ pick_th: 'ก'.repeat(381) }, pickInput).violations[0]).toMatch(/^schema:/);
  });

  it('a percentage is the pick\'s own chance, never the 1X2 one (Liverpool 80% to win is not Liverpool -2.5)', () => {
    expect(validatePickNote({ pick_th: 'โมเดลให้ Chelsea ชนะแค่ 24% จึงเลือกมุมนี้' }, pickInput).violations).toEqual(["percent is not the pick's chance: 24%"]);
  });

  it('names no other market or line than the pick\'s', () => {
    expect(validatePickNote({ pick_th: 'ต้องให้ Arsenal ชนะ โมเดลให้ 60% ตลาดให้ 52% เกมน่าจะ Over ด้วย' }, pickInput).violations).toEqual(['mentions over/under on a handicap view']);
    expect(validatePickNote({ pick_th: 'ต้องให้ Arsenal ชนะ โมเดลให้ 60% ตลาดให้ 52% ส่วน -1.5 ก็พอไหว' }, pickInput).violations).toEqual(expect.arrayContaining(["line not the pick's: -1.5"]));
    // the pick's own line, from either side, is fine
    expect(validatePickNote({ pick_th: 'Chelsea +0.5 คือมุมกลับ ต้องให้ Arsenal ชนะ โมเดลให้ 60% ตลาดให้ 52%' }, pickInput).ok).toBe(true);
  });

  it('a push is เสมอตัว, not the betting word คืนทุน (Al Riyadh 0, 2026-10-20)', () => {
    expect(validatePickNote({ pick_th: 'ต้องให้ Arsenal ชนะจึงถูก ส่วนเสมอคืนทุน โมเดลให้ 60% ตลาด 52%' }, pickInput).violations).toEqual(['banned word "คืนทุน"']);
  });

  it('ชนะขาด is no win condition; ความไม่แน่นอน is honest wording, not a promise', () => {
    expect(validatePickNote({ pick_th: 'โมเดลมองว่า Arsenal ชนะขาด ให้โอกาส 60% ตลาด 52%' }, pickInput).violations).toEqual(['banned word "ชนะขาด"']);
    expect(validatePickNote({ pick_th: 'ต้องให้ Arsenal ชนะ โมเดลให้ 60% ตลาด 52% ยังมีความไม่แน่นอนจากข้อมูล Chelsea' }, pickInput).ok).toBe(true);
  });
});

describe('thousands separators', () => {
  it('a count written as 1,356 is the 1356 in the input, in the preview and in the pick note', () => {
    const big = { ...input, model: { ...input.model, matchesUsed: 1356 }, pick: { label: 'Arsenal -0.5' } };
    expect(withoutThousandsSeparators('โมเดลใช้ 1,356 นัด และ 1,234,567 กับ 1,5')).toBe('โมเดลใช้ 1356 นัด และ 1234567 กับ 1,5');
    expect(validatePreviewOutput({ ...ok, analysis_th: `${ok.analysis_th} โมเดลคำนวณจาก 1,356 นัด` }, big).ok).toBe(true);
    expect(validatePickNote({ pick_th: 'โมเดลมองต่างจากตลาด จากข้อมูล 1,356 นัดในรายการนี้' }, big).ok).toBe(true);
    // a decimal comma is still checked as a decimal: 1,7 is xG 1.7, 1,9 is not in the input
    expect(validatePreviewOutput({ ...ok, analysis_th: `${ok.analysis_th} ประตูคาดหวัง 1,9 ต่อ 1.0 ตามโมเดล` }, big).violations).toEqual(['analysis_th: number not in input: 1,9']);
  });
});

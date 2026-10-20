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
  overview_th: 'โมเดลให้ Arsenal ชนะ 52% ขณะที่ Chelsea ได้ 24% ตลาดมองไปทางเดียวกันที่ 50%',
  home_th: 'Arsenal ฟอร์มดี นัดล่าสุดชนะ 2-0 ด้วย xG 1.8 อยู่อันดับ 3 และพักมา 4 วัน',
  away_th: 'Chelsea อยู่อันดับ 9 ไม่มีผลล่าสุดในระบบ จึงอ่านได้แค่จากตารางคะแนน',
  score_th: 'โมเดลคาดประตู 1.7 ต่อ 1.0 สกอร์ที่โมเดลให้โอกาสสูงสุดคือ 1-0 (12%) รองลงมา 2-0',
  uncertainty_th: 'ตัวจริงยังไม่ประกาศ ภาพนี้อาจเปลี่ยนเมื่อรู้รายชื่อ',
};

describe('validatePreviewOutput: data fully there, numbers consistent', () => {
  it('accepts text whose numbers, percentages and scorelines all trace back to the input', () => {
    const v = validatePreviewOutput(ok, input);
    expect(v.violations).toEqual([]);
    expect(v.text).toEqual(ok);
  });

  it('a stray semicolon is turned into a space instead of costing a retry', () => {
    const v = validatePreviewOutput({ ...ok, overview_th: 'โมเดลให้ Arsenal ชนะ 52%; ขณะที่ Chelsea ได้ 24% ตลาดมองไปทางเดียวกัน' }, input);
    expect(v.ok).toBe(true);
    expect(v.text!.overview_th).toBe('โมเดลให้ Arsenal ชนะ 52% ขณะที่ Chelsea ได้ 24% ตลาดมองไปทางเดียวกัน');
  });

  it('an empty uncertainty is stored as null', () => {
    const v = validatePreviewOutput({ ...ok, uncertainty_th: '' }, input);
    expect(v.ok).toBe(true);
    expect(v.text!.uncertainty_th).toBeNull();
  });
});

describe('validatePreviewOutput: numbers, lines and scorelines that are not in the facts', () => {
  it('rejects invented numbers, foreign scorelines and gambling words, keeping every reason', () => {
    const v = validatePreviewOutput({ ...ok, overview_th: 'Arsenal น่าจะชนะ 65% แทงได้เลย Chelsea ลำบาก', score_th: 'สกอร์ที่โมเดลมองน่าจะออก 3-1 หรือ 2-0 ก็ได้' }, input);
    expect(v.ok).toBe(false);
    expect(v.text).toBeNull();
    expect(v.violations).toEqual(expect.arrayContaining(['overview_th: number not in input: 65%', 'banned word "แทง"', 'score_th: scoreline not from the model: 3-1']));
    expect(v.violations).not.toContainEqual(expect.stringContaining('2-0'));
  });

  it('a percentage must be a chance: xG 1.7 is not "17%", a rank is not a percent', () => {
    expect(allowedPercents(input)).toEqual(expect.arrayContaining([52, 24, 12, 10, 50, 27, 23]));
    expect(validatePreviewOutput({ ...ok, overview_th: 'Arsenal มีโอกาส 17% ที่จะยิงสองลูก Chelsea ลำบาก' }, input).violations).toContain('overview_th: percent is not a chance in the input: 17%');
    expect(validatePreviewOutput({ ...ok, overview_th: 'Arsenal อันดับ 3 มีโอกาส 3% ส่วน Chelsea อันดับ 9' }, input).violations).toContain('overview_th: percent is not a chance in the input: 3%');
  });

  it('no handicap, over/under or odds talk: that is the Game Compass note\'s job', () => {
    const v = validatePreviewOutput({ ...ok, score_th: 'โมเดลคาดประตู 1.7 ต่อ 1.0 เหมาะกับ Over มากกว่า Under และแฮนดิแคปน่าสนใจ' }, input);
    expect(v.violations).toEqual(expect.arrayContaining(['score_th: market word', 'banned word "แฮนดิแคป"']));
    // totals are not facts of the preview: an over 2.5 figure is invented
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal โอกาสเกิน 2.5 ประตูอยู่ที่ 55%' }, input).ok).toBe(false);
  });

  it('the score part may only quote the model\'s scorelines; the others may also quote past results', () => {
    expect(validatePreviewOutput({ ...ok, score_th: 'โมเดลคาดประตู 1.7 ต่อ 1.0 ใกล้เคียงกับที่เคยชนะ 2-1' }, input).violations).toEqual(['score_th: scoreline not from the model: 2-1']);
    expect(validatePreviewOutput({ ...ok, away_th: 'นัดล่าสุดที่เจอกัน Chelsea แพ้ 1-2 ที่บ้าน' }, input).ok).toBe(true);
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal เพิ่งชนะ 3-0 และอยู่อันดับ 3' }, input).violations).toEqual(['scoreline not in input: 3-0']);
  });

  it('never presents a scoreline as the result or calls the winner', () => {
    expect(validatePreviewOutput({ ...ok, score_th: 'สกอร์คาดการณ์ 1-0 ตามที่โมเดลให้ 12%' }, input).violations).toEqual(['banned word "สกอร์คาดการณ์"']);
    expect(validatePreviewOutput({ ...ok, overview_th: 'ฟันธง Arsenal ชนะในบ้าน ส่วน Chelsea ยังไม่ดี' }, input).violations).toEqual(['banned word "ฟันธง"']);
  });

  it("each section may only quote numbers from its own part of the input", () => {
    // Chelsea's rank (9) and rest days (6) are facts, but not about Arsenal; the model's 52% belongs to the overview
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal อยู่อันดับ 9 และพักมา 6 วัน' }, input).violations).toEqual(['home_th: number not in input: 9', 'home_th: number not in input: 6']);
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal ได้โอกาสจากโมเดล 52% สูงสุด' }, input).violations).toEqual(['home_th: number not in input: 52%']);
  });
});

describe('validatePreviewOutput: teams named as the input names them', () => {
  it('the overview names both teams, each team part its own team, in the input\'s script', () => {
    expect(validatePreviewOutput({ ...ok, overview_th: 'อาร์เซนอลมีโอกาสชนะ 52% ส่วนเชลซีได้ 24% ตลาดมองตรงกัน' }, input).violations).toEqual([
      'overview_th: does not name Arsenal',
      'overview_th: does not name Chelsea',
    ]);
    expect(validatePreviewOutput({ ...ok, home_th: 'เจ้าบ้านฟอร์มดี นัดล่าสุดชนะ 2-0 และพักมา 4 วัน' }, input).violations).toEqual(['home_th: does not name Arsenal']);
  });
});

describe('validatePreviewOutput: no confirmed lineup', () => {
  it('at EARLY the lineup may only be called not out yet, and an empty injury list is no full squad', () => {
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal ส่งตัวจริงชุดใหญ่ ฟอร์มนัดล่าสุดชนะ 2-0' }, input).violations).toEqual(['home_th: lineup claim before the lineups are out']);
    expect(validatePreviewOutput({ ...ok, away_th: 'Chelsea มาแบบเต็มทีม อยู่อันดับ 9 ของตาราง' }, input).violations).toEqual(['banned word "เต็มทีม"']);
    // saying they are not out yet is fine, however it is phrased
    for (const said of ['ยังไม่ประกาศรายชื่อตัวจริง', 'ก่อนประกาศตัวจริง', 'ตัวจริงยังไม่ออก']) {
      expect(validatePreviewOutput({ ...ok, uncertainty_th: `ข้อมูลมีข้อจำกัด และ${said}` }, input).ok).toBe(true);
    }
    // at LINEUP the starters are facts
    const lineup = { ...input, fixture: { ...input.fixture, stage: 'LINEUP' } };
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal ส่งตัวจริงชุดใหญ่ ฟอร์มนัดล่าสุดชนะ 2-0' }, lineup).ok).toBe(true);
  });
});

describe('validatePreviewOutput: sources that disagree', () => {
  const split = { ...input, views: { ...input.views, recentForm: 'Chelsea', disagreements: ['MARKET_GAP', 'FORM'] } };

  it('a disagreement listed in views has to be stated', () => {
    const quiet = {
      ...ok,
      overview_th: 'โมเดลให้ Arsenal ชนะ 52% และ Chelsea ได้ 24% เกมนี้เอียงไปทางเจ้าบ้าน',
      uncertainty_th: '',
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
    const text = { ...ok, overview_th: 'Arsenal อันดับ 3 พบ Chelsea อันดับ 9 ตลาดเอนมาทางเจ้าบ้าน', score_th: 'โมเดลยังไม่มีตัวเลขสำหรับคู่นี้ จึงอ่านเกมจากฟอร์มเท่านั้น' };
    expect(validatePreviewOutput(text, none).ok).toBe(true);
    expect(validatePreviewOutput(ok, none).violations).toEqual(expect.arrayContaining(['overview_th: number not in input: 52%', 'score_th: scoreline not from the model: 1-0']));
  });
});

describe('validatePreviewOutput: shape and length', () => {
  it('rejects empty or missing parts, malformed answers and a write-up that runs long', () => {
    expect(validatePreviewOutput({ ...ok, score_th: '' }, input).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput({ ...ok, uncertainty_th: undefined }, input).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput(null, input).ok).toBe(false);
    const pad = (s: string) => s + ' ข้อมูลเพิ่มเติม'.repeat(26);
    expect(validatePreviewOutput({ ...ok, overview_th: pad(ok.overview_th), home_th: pad(ok.home_th), away_th: pad(ok.away_th), score_th: pad(ok.score_th) }, input).violations).toContainEqual(expect.stringMatching(/^too long: \d+ characters$/));
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
    expect(validatePickNote({ pick_th: 'โมเดลสูงกว่าตลาด 8 จุดเปอร์เซ็นต์; ฟอร์มดี' }, pickInput).violations).toEqual(['banned word "จุดเปอร์เซ็นต์"', 'banned word ";"']);
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

  it('ชนะขาด is no win condition; ความไม่แน่นอน is honest wording, not a promise', () => {
    expect(validatePickNote({ pick_th: 'โมเดลมองว่า Arsenal ชนะขาด ให้โอกาส 60% ตลาด 52%' }, pickInput).violations).toEqual(['banned word "ชนะขาด"']);
    expect(validatePickNote({ pick_th: 'ต้องให้ Arsenal ชนะ โมเดลให้ 60% ตลาด 52% ยังมีความไม่แน่นอนจากข้อมูล Chelsea' }, pickInput).ok).toBe(true);
  });
});

describe('thousands separators', () => {
  it('a count written as 1,356 is the 1356 in the input, in the preview and in the pick note', () => {
    const big = { ...input, model: { ...input.model, matchesUsed: 1356 }, pick: { label: 'Arsenal -0.5' } };
    expect(withoutThousandsSeparators('โมเดลใช้ 1,356 นัด และ 1,234,567 กับ 1,5')).toBe('โมเดลใช้ 1356 นัด และ 1234567 กับ 1,5');
    expect(validatePreviewOutput({ ...ok, score_th: 'โมเดลคำนวณจาก 1,356 นัด ประตูคาดหวัง 1.7 ต่อ 1.0' }, big).ok).toBe(true);
    expect(validatePickNote({ pick_th: 'โมเดลมองต่างจากตลาด จากข้อมูล 1,356 นัดในรายการนี้' }, big).ok).toBe(true);
    // a decimal comma is still checked as a decimal: 1,7 is xG 1.7, 1,9 is not in the input
    expect(validatePreviewOutput({ ...ok, score_th: 'ประตูคาดหวัง 1,9 ต่อ 1.0 ตามโมเดล' }, big).violations).toEqual(['score_th: number not in input: 1,9']);
  });
});

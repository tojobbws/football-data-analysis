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

/** what the preview job hands the writer from preview-v1.2: the kickoff in Thai words, the chance of 3+ goals, no model scorelines */
const pv = {
  ...input,
  fixture: { ...input.fixture, kickoffTh: 'วันเสาร์ที่ 14 พ.ย. เวลา 22:00 น. (เวลาไทย)', venue: { name: 'Emirates Stadium', city: 'London' } },
  model: { ...input.model, scorelines: [], pGoals3plus: 0.48 },
};

const ok = {
  headline_th: 'Arsenal ฟอร์มดีรอรับ Chelsea ที่เพิ่งแพ้กันเอง',
  overview_th: 'Arsenal เพิ่งบุกไปชนะ Chelsea 2-1 และนัดนี้เป็นฝ่ายเปิดบ้านรับ วันเสาร์ที่ 14 พ.ย. เวลา 22:00 น. ที่ Emirates Stadium ใน Premier League',
  home_th: 'Arsenal ชนะนัดล่าสุด 2-0 ด้วยค่า xG 1.8 หมายถึงโอกาสที่สร้างได้มีคุณภาพพอจะยิงได้เกือบสองลูก ตอนนี้อยู่อันดับ 3 มี 17 แต้ม และพักมา 4 วัน',
  away_th: 'Chelsea อยู่อันดับ 9 มี 11 แต้ม และพักมา 6 วัน ยังไม่มีผลล่าสุดในระบบ เรื่องเล่าของทีมนี้จึงอยู่ที่ตารางคะแนน',
  analysis_th: 'โมเดลให้ Arsenal ชนะ 52% เสมอ 24% Chelsea ชนะ 24% ตลาดมองใกล้กันที่ 50% ต่อ 23% โมเดลยังให้โอกาส 48% ที่เกมนี้จะมีอย่างน้อย 3 ประตู',
  summary_th: 'ถ้า Arsenal ยังสร้างโอกาสได้ระดับนี้ คำถามของ Chelsea คือจะหยุดเกมรุกของเจ้าบ้านได้ไหม',
};

describe('validatePreviewOutput: data fully there, numbers consistent', () => {
  it('accepts text whose numbers, percentages, past results and kickoff all trace back to the input', () => {
    const v = validatePreviewOutput(ok, pv);
    expect(v.violations).toEqual([]);
    expect(v.text).toEqual(ok);
  });

  it('a stray semicolon is turned into a space instead of costing a retry', () => {
    const v = validatePreviewOutput({ ...ok, summary_th: 'ถ้า Arsenal ยังสร้างโอกาสได้ระดับนี้; คำถามของ Chelsea คือจะหยุดได้ไหม' }, pv);
    expect(v.ok).toBe(true);
    expect(v.text!.summary_th).toBe('ถ้า Arsenal ยังสร้างโอกาสได้ระดับนี้ คำถามของ Chelsea คือจะหยุดได้ไหม');
  });
});

describe('validatePreviewOutput: numbers, lines and scorelines that are not in the facts', () => {
  it('rejects invented numbers, any scoreline for this match and gambling words, keeping every reason', () => {
    const v = validatePreviewOutput({ ...ok, analysis_th: 'โมเดลให้ Arsenal ชนะ 65% แทงได้เลย ตลาดมองว่าน่าจะจบ 2-0 ตามประตูคาดหวัง 1.7 ต่อ 1.0' }, pv);
    expect(v.ok).toBe(false);
    expect(v.text).toBeNull();
    expect(v.violations).toEqual(expect.arrayContaining(['analysis_th: number not in input: 65%', 'banned word "แทง"', 'analysis_th: scoreline not a past result in the input: 2-0']));
  });

  it('a percentage must be a chance: xG 1.7 is not "17%"; the 3+ goals chance is one', () => {
    expect(allowedPercents(pv)).toEqual(expect.arrayContaining([52, 24, 48, 50, 27, 23]));
    expect(validatePreviewOutput({ ...ok, analysis_th: `${ok.analysis_th} และ 17% ที่ Arsenal จะยิงสองลูก` }, pv).violations).toContain('analysis_th: percent is not a chance in the input: 17%');
  });

  it('chances belong to the model-and-market part only: not the headline, the lead or the closing line', () => {
    expect(validatePreviewOutput({ ...ok, headline_th: 'Arsenal ลุ้นชนะ 52%' }, pv).violations).toContain('headline_th: no chance belongs here: 52%');
    expect(validatePreviewOutput({ ...ok, overview_th: `${ok.overview_th} โมเดลให้ 52%` }, pv).violations).toContain('overview_th: no chance belongs here: 52%');
    expect(validatePreviewOutput({ ...ok, summary_th: `${ok.summary_th} ด้วยโอกาส 52%` }, pv).violations).toContain('summary_th: no chance belongs here: 52%');
  });

  it('no handicap, over/under or odds talk: the Game Compass part of the page carries the line', () => {
    const v = validatePreviewOutput({ ...ok, analysis_th: `${ok.analysis_th} เหมาะกับ Over มากกว่า Under และแฮนดิแคปน่าสนใจ` }, pv);
    expect(v.violations).toEqual(expect.arrayContaining(['analysis_th: market word', 'banned word "แฮนดิแคป"']));
  });

  it('past results may be quoted outside the model part, never a result the input does not have', () => {
    expect(validatePreviewOutput({ ...ok, away_th: `${ok.away_th} นัดล่าสุดที่เจอกัน Chelsea แพ้ 1-2 ที่บ้าน` }, pv).ok).toBe(true);
    expect(validatePreviewOutput({ ...ok, home_th: `${ok.home_th} และเพิ่งชนะ 3-0` }, pv).violations).toEqual(['home_th: scoreline not a past result in the input: 3-0']);
    // the kickoff time is no scoreline
    expect(validatePreviewOutput({ ...ok, summary_th: `${ok.summary_th} ตั้งแต่ 22:00 น.` }, pv).ok).toBe(true);
  });

  it('each side may only quote its own numbers; the lead and the closing line no model number', () => {
    // Chelsea's rank (9) and rest days (6) are facts, but not about Arsenal
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal อยู่อันดับ 9 และพักมา 6 วัน ฟอร์มช่วงนี้ยังเล่าได้ไม่มากจากข้อมูลที่มี' }, pv).violations).toEqual(['home_th: number not in input: 9', 'home_th: number not in input: 6']);
    expect(validatePreviewOutput({ ...ok, overview_th: `${ok.overview_th} โมเดลคาดว่า Arsenal ยิงได้ 1.7 ประตู` }, pv).violations).toEqual(['overview_th: number not in input: 1.7']);
  });
});

describe('validatePreviewOutput: the brief (khemthit-football-writer)', () => {
  it('the closing line never leans on แต่, though แต่ละ is just "each"', () => {
    expect(validatePreviewOutput({ ...ok, summary_th: 'Arsenal น่าจะคุมเกมได้ แต่ Chelsea ก็มีโอกาสสวนกลับ' }, pv).violations).toEqual(['summary_th: the closing line uses แต่']);
    expect(validatePreviewOutput({ ...ok, summary_th: 'แต่ละจังหวะของ Arsenal คือสิ่งที่ Chelsea ต้องหยุดให้ได้' }, pv).ok).toBe(true);
  });

  it('no caveat about the data or the model, and nothing firmer than the chances', () => {
    expect(validatePreviewOutput({ ...ok, summary_th: 'ข้อมูลน้อยจึงยังสรุปไม่ได้ว่า Arsenal จะคุมเกมได้ไหม' }, pv).violations).toEqual(['summary_th: caveat or certainty word "ข้อมูลน้อย"']);
    expect(validatePreviewOutput({ ...ok, analysis_th: `${ok.analysis_th} ความมั่นใจของโมเดลยังไม่สูง` }, pv).violations).toEqual(['analysis_th: caveat or certainty word "ความมั่นใจของโมเดล"']);
    // a stray word in another script is caught; a name the input writes that way is not (England vs Croatia, 2026-11-13)
    expect(validatePreviewOutput({ ...ok, home_th: `${ok.home_th} และเป็นตัวจบสกอร์ الأبرز ของทีม` }, pv).violations).toEqual(['home_th: text in another script: الأبرز']);
    const cyr = { ...pv, home: { ...pv.home, keyPlayers: [{ name: 'Иван', goals: 2, assists: 0, appearances: 3 }] } };
    expect(validatePreviewOutput({ ...ok, home_th: `${ok.home_th} Иван คือคนที่ต้องจับตา` }, cyr).ok).toBe(true);
    // a team's morale is no caveat (England vs Croatia, 2026-11-13)
    expect(validatePreviewOutput({ ...ok, away_th: `${ok.away_th} ภารกิจสำคัญคือเรียกความมั่นใจกลับมา` }, pv).ok).toBe(true);
    expect(validatePreviewOutput({ ...ok, summary_th: 'Arsenal ชนะแน่นอน Chelsea ไม่มีทางรอด' }, pv).violations).toEqual(
      expect.arrayContaining(['summary_th: caveat or certainty word "แน่นอน"', 'banned word "ไม่มีทางรอด"']),
    );
  });

  it('the model-and-market part compares with the market, and is empty only when neither has numbers', () => {
    expect(validatePreviewOutput({ ...ok, analysis_th: 'โมเดลให้ Arsenal ชนะ 52% เสมอ 24% Chelsea ชนะ 24% และให้โอกาส 48% ที่เกมนี้จะมีอย่างน้อย 3 ประตู' }, pv).violations).toEqual([
      'analysis_th: does not compare with the market',
    ]);
    expect(validatePreviewOutput({ ...ok, analysis_th: '' }, pv).violations).toEqual(['analysis_th: missing or too short while the model or the market has numbers']);
    const bare = { ...pv, model: null, views: { ...pv.views, model: null, marketP: null } };
    expect(validatePreviewOutput({ ...ok, analysis_th: '' }, bare).ok).toBe(true);
    expect(validatePreviewOutput({ ...ok, analysis_th: 'Arsenal ดูดีกว่าในทุกด้านจากที่เห็นมาตลอดช่วงหลังของฤดูกาลนี้ทั้งเกมรุกและเกมรับ' }, bare).violations).toEqual([
      'analysis_th: written without model or market numbers',
    ]);
  });

  it('without the model, the market\'s chances alone carry the part', () => {
    const marketOnly = { ...pv, model: null, views: { ...pv.views, model: null } };
    expect(validatePreviewOutput({ ...ok, analysis_th: 'ตลาดให้ Arsenal ชนะ 50% เสมอ 27% และ Chelsea ชนะ 23% เจ้าบ้านจึงเป็นฝ่ายที่ถูกมองว่าได้เปรียบ' }, marketOnly).ok).toBe(true);
    expect(validatePreviewOutput(ok, marketOnly).violations).toEqual(expect.arrayContaining(['analysis_th: number not in input: 52%']));
  });
});

describe('validatePreviewOutput: teams named as the input names them', () => {
  it('the lead names both teams, each side its own team, the headline at least one', () => {
    expect(validatePreviewOutput({ ...ok, overview_th: 'อาร์เซนอลเปิดบ้านรับเชลซี วันเสาร์ที่ 14 พ.ย. เวลา 22:00 น. ใน Premier League' }, pv).violations).toEqual([
      'overview_th: does not name Arsenal',
      'overview_th: does not name Chelsea',
    ]);
    expect(validatePreviewOutput({ ...ok, home_th: ok.home_th.replace('Arsenal', 'เจ้าบ้าน') }, pv).violations).toEqual(['home_th: does not name Arsenal']);
    expect(validatePreviewOutput({ ...ok, headline_th: 'ศึกใหญ่กลางสัปดาห์' }, pv).violations).toEqual(['headline_th: names neither team']);
  });
});

describe('validatePreviewOutput: no confirmed lineup', () => {
  it('at EARLY the lineup may only be called not out yet, and an empty injury list is no full squad', () => {
    expect(validatePreviewOutput({ ...ok, home_th: `${ok.home_th} ส่งตัวจริงชุดใหญ่` }, pv).violations).toEqual(['home_th: lineup claim before the lineups are out']);
    expect(validatePreviewOutput({ ...ok, away_th: `${ok.away_th} มาแบบเต็มทีม` }, pv).violations).toEqual(['banned word "เต็มทีม"']);
    for (const said of ['ยังไม่ประกาศรายชื่อตัวจริง', 'ก่อนประกาศตัวจริง', 'ตัวจริงยังไม่ออก']) {
      expect(validatePreviewOutput({ ...ok, away_th: `${ok.away_th} และ${said}` }, pv).ok).toBe(true);
    }
    const lineup = { ...pv, fixture: { ...pv.fixture, stage: 'LINEUP' } };
    expect(validatePreviewOutput({ ...ok, home_th: `${ok.home_th} ส่งตัวจริงชุดใหญ่` }, lineup).ok).toBe(true);
  });

  it('thin data allows no strong claims', () => {
    const thin = { ...pv, data_support: { level: 'THIN', notes_th: ['x'] } };
    const strong = { ...ok, summary_th: 'Arsenal ได้เปรียบชัด คำถามคือ Chelsea จะหยุดเจ้าบ้านได้ไหม' };
    expect(validatePreviewOutput(strong, thin).violations).toEqual(['summary_th: strong claim on thin data "ได้เปรียบชัด"']);
    expect(validatePreviewOutput(strong, pv).ok).toBe(true);
  });
});

describe('validatePreviewOutput: shape and length', () => {
  it('rejects missing parts, malformed answers and a write-up past the brief\'s length', () => {
    expect(validatePreviewOutput({ ...ok, headline_th: undefined }, pv).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput({ ...ok, summary_th: 'สั้น' }, pv).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput(null, pv).ok).toBe(false);
    // every part within its own limit, the whole past about 550 words
    const pad = (s: string, n: number) => (s + ' ข้อมูลเพิ่มเติม'.repeat(80)).slice(0, n);
    const long = { ...ok, home_th: pad(ok.home_th, 790), away_th: pad(ok.away_th, 790), analysis_th: pad(ok.analysis_th, 790), overview_th: pad(ok.overview_th, 390), summary_th: pad(ok.summary_th, 290) };
    expect(validatePreviewOutput(long, pv).violations).toEqual([expect.stringMatching(/^too long: \d+ characters$/)]);
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
    const bigPv = { ...pv, model: { ...pv.model, matchesUsed: 1356 } };
    expect(withoutThousandsSeparators('โมเดลใช้ 1,356 นัด และ 1,234,567 กับ 1,5')).toBe('โมเดลใช้ 1356 นัด และ 1234567 กับ 1,5');
    expect(validatePreviewOutput({ ...ok, analysis_th: `${ok.analysis_th} โมเดลคำนวณจาก 1,356 นัด` }, bigPv).ok).toBe(true);
    expect(validatePickNote({ pick_th: 'โมเดลมองต่างจากตลาด จากข้อมูล 1,356 นัดในรายการนี้' }, big).ok).toBe(true);
    // a decimal comma is still checked as a decimal: 1,7 is xG 1.7, 1,9 is not in the input
    expect(validatePreviewOutput({ ...ok, analysis_th: `${ok.analysis_th} ประตูคาดหวัง 1,9 ต่อ 1.0 ตามโมเดล` }, bigPv).violations).toEqual(['analysis_th: number not in input: 1,9']);
  });
});

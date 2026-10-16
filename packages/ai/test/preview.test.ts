import { describe, expect, it } from 'vitest';
import { validatePickNote } from '../src/pick-note.js';
import { validatePreviewOutput } from '../src/preview.js';

const input = {
  fixture: { home: 'Arsenal', away: 'Chelsea', league: 'Premier League', stage: 'EARLY' },
  home: { name: 'Arsenal', form: [{ result: 'W', goalsFor: 2, goalsAgainst: 0, xgFor: 1.8 }], standing: { rank: 3, points: 17 }, injuries: [], starters: null, modelMatches: 22, restDays: 4 },
  away: { name: 'Chelsea', form: [], standing: { rank: 9, points: 11 }, injuries: [], starters: null, modelMatches: 20, restDays: 6 },
  model: { p: { home: 0.52, draw: 0.24, away: 0.24 }, expectedGoals: { home: 1.7, away: 1.0 }, scorelines: [{ home: 1, away: 0, p: 0.12 }, { home: 2, away: 0, p: 0.1 }] },
  h2h: [{ home: 'Chelsea', away: 'Arsenal', homeGoals: 1, awayGoals: 2 }],
  data_support: { level: 'GOOD', notes_th: [] },
};

const ok = {
  overview_th: 'โมเดลให้ Arsenal ชนะ 52% ขณะที่ Chelsea ได้ 24% ข้อมูลเอียงไปทางเจ้าบ้านชัดเจน',
  home_th: 'Arsenal ฟอร์มดี นัดล่าสุดชนะ 2-0 ด้วย xG 1.8 อยู่อันดับ 3 และพักมา 4 วัน',
  away_th: 'Chelsea อยู่อันดับ 9 ไม่มีผลล่าสุดในระบบ จึงอ่านได้แค่จากตัวเลขโมเดล',
  attack_th: 'เกมรุกของ Arsenal มีตัวเลขรองรับมากกว่า',
  defence_th: 'แนวรับของ Arsenal ไม่เสียประตูในนัดล่าสุด',
  h2h_th: 'ครั้งล่าสุดที่พบกัน Arsenal บุกไปชนะ 2-1',
  key_factor_th: 'ถ้า Arsenal ได้ประตูแรก เกมจะเป็นไปตามจังหวะของเจ้าบ้าน',
  score_th: 'สกอร์ที่โมเดลให้โอกาสสูงสุดคือ 1-0 (12%) รองลงมา 2-0 ประตูคาดหวัง 1.7 ต่อ 1.0',
  summary_th: 'ตัวเลขเอียงไปทาง Arsenal แต่ยังเป็นเพียงหนึ่งในหลายผลที่เป็นไปได้',
};

describe('validatePreviewOutput', () => {
  it('accepts text whose numbers and scorelines all trace back to the input', () => {
    const v = validatePreviewOutput(ok, input);
    expect(v.ok).toBe(true);
    expect(v.text).toEqual(ok);
  });

  it('rejects invented numbers, foreign scorelines and gambling words — keeping every reason', () => {
    const v = validatePreviewOutput(
      { ...ok, overview_th: 'Arsenal น่าจะชนะ 65% แทงได้เลย', score_th: 'สกอร์น่าจะออก 3-1 หรือ 2-0' },
      input,
    );
    expect(v.ok).toBe(false);
    expect(v.text).toBeNull();
    expect(v.violations).toEqual(expect.arrayContaining(['overview_th: number not in input: 65%', 'banned word "แทง"', 'scoreline not in input: 3-1']));
    expect(v.violations).not.toContainEqual(expect.stringContaining('2-0'));
  });

  it('never calls the result', () => {
    expect(validatePreviewOutput({ ...ok, summary_th: 'ฟันธง Arsenal ชนะในบ้าน' }, input).violations).toEqual(['banned word "ฟันธง"']);
  });

  it("each section may only quote numbers from its own part of the input", () => {
    // Chelsea's rank (9) and rest days (6) are facts, but not about Arsenal
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal อยู่อันดับ 9 และพักมา 6 วัน' }, input).violations).toEqual([
      'home_th: number not in input: 9',
      'home_th: number not in input: 6',
    ]);
    // the h2h section only knows the meetings: Arsenal's points (17) are a fact, but not there
    expect(validatePreviewOutput({ ...ok, h2h_th: 'Arsenal มี 17 แต้ม เคยชนะ 2-1' }, input).violations).toEqual(['h2h_th: number not in input: 17']);
    // comparing sections may use both teams
    expect(validatePreviewOutput({ ...ok, attack_th: 'Arsenal อันดับ 3 ส่วน Chelsea อันดับ 9' }, input).ok).toBe(true);
  });

  it('an empty h2h section is stored as null', () => {
    const v = validatePreviewOutput({ ...ok, h2h_th: '' }, input);
    expect(v.ok).toBe(true);
    expect(v.text!.h2h_th).toBeNull();
  });

  it('allows H2H and recent-form scores and decimal ranges; rejects O/U figures (not in the input), empty / malformed answers', () => {
    expect(validatePreviewOutput({ ...ok, away_th: 'นัดล่าสุดที่เจอกัน Chelsea แพ้ 1-2 ที่บ้าน' }, input).ok).toBe(true);
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal เพิ่งถล่มคู่แข่ง 2-0' }, input).ok).toBe(true);
    // totals are a gated-off market: their figures are not facts the preview may quote
    expect(validatePreviewOutput({ ...ok, home_th: 'โอกาสเกิน 2.5 ประตูอยู่ที่ 55%' }, input).ok).toBe(false);
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal เพิ่งชนะ 3-0' }, input).violations).toEqual(['scoreline not in input: 3-0']);
    expect(validatePreviewOutput({ ...ok, score_th: '' }, input).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput({ ...ok, summary_th: undefined }, input).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput(null, input).ok).toBe(false);
  });
});

describe('validatePickNote', () => {
  const pickInput = { ...input, pick: { label: 'Arsenal -0.5', modelChance: 0.6, marketChance: 0.52, differencePts: 8 } };

  it('accepts a plain note that starts with where the model differs', () => {
    expect(validatePickNote({ pick_th: 'โมเดลมองว่า Arsenal มีโอกาสชนะ 60% มากกว่าที่ตลาดให้ 52% สอดคล้องกับฟอร์มที่ชนะ 2-0 ในนัดล่าสุด' }, pickInput).ok).toBe(true);
  });

  it('rejects a note that restates the pick, stiff wording, a claim that the market is wrong, or one too long', () => {
    expect(validatePickNote({ pick_th: 'มุมมองคือ Arsenal -0.5: ชนะถือว่าถูก แพ้หรือเสมอถือว่าผิด' }, pickInput).violations).toEqual(['restates the pick at the start']);
    expect(validatePickNote({ pick_th: 'Arsenal -0.5 คือมุมมองของโมเดลในเกมนี้ที่ต่างจากตลาด' }, pickInput).violations).toEqual(['restates the pick at the start']);
    expect(validatePickNote({ pick_th: 'โมเดลสูงกว่าตลาด 8 จุดเปอร์เซ็นต์; ฟอร์มดี' }, pickInput).violations).toEqual(['banned word "จุดเปอร์เซ็นต์"', 'banned word ";"']);
    expect(validatePickNote({ pick_th: 'ตลาดประเมินพลาด Arsenal ชนะแน่นอน' }, pickInput).violations).toEqual(['banned word "ประเมินพลาด"', 'banned word "แน่นอน"']);
    expect(validatePickNote({ pick_th: 'ก'.repeat(241) }, pickInput).violations[0]).toMatch(/^schema:/);
  });
});

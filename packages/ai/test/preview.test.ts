import { describe, expect, it } from 'vitest';
import { validatePreviewOutput } from '../src/preview.js';

const input = {
  fixture: { home: 'Arsenal', away: 'Chelsea', league: 'Premier League', stage: 'EARLY' },
  home: { name: 'Arsenal', form: [{ result: 'W', goalsFor: 2, goalsAgainst: 0, xgFor: 1.8 }], standing: { rank: 3, points: 17 }, injuries: [], starters: null, modelMatches: 22 },
  away: { name: 'Chelsea', form: [], standing: null, injuries: [], starters: null, modelMatches: 20 },
  model: { p: { home: 0.52, draw: 0.24, away: 0.24 }, expectedGoals: { home: 1.7, away: 1.0 }, scorelines: [{ home: 1, away: 0, p: 0.12 }, { home: 2, away: 0, p: 0.1 }], overUnder: { line: 2.5, pOver: 0.55 } },
  h2h: [{ home: 'Chelsea', away: 'Arsenal', homeGoals: 1, awayGoals: 2 }],
  data_support: { level: 'GOOD', notes_th: [] },
};

const ok = {
  overview_th: 'โมเดลให้ Arsenal ชนะ 52% ขณะที่ Chelsea ได้ 24% ข้อมูลเอียงไปทางเจ้าบ้านชัดเจน',
  home_th: 'Arsenal ฟอร์มดี นัดล่าสุดชนะ 2-0 ด้วย xG 1.8 และอยู่อันดับ 3',
  away_th: 'Chelsea ไม่มีผลล่าสุดในระบบ จึงอ่านได้แค่จากตัวเลขโมเดล',
  score_th: 'สกอร์ที่โมเดลให้โอกาสสูงสุดคือ 1-0 (12%) รองลงมา 2-0 ประตูคาดหวัง 1.7 ต่อ 1.0',
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
    expect(v.violations).toEqual(expect.arrayContaining(['number not in input: 65%', 'banned word "แทง"', 'scoreline not in input: 3-1']));
    expect(v.violations).not.toContainEqual(expect.stringContaining('2-0'));
  });

  it('allows H2H and recent-form scores, the O/U line and decimal ranges; rejects empty / malformed answers', () => {
    expect(validatePreviewOutput({ ...ok, away_th: 'นัดล่าสุดที่เจอกัน Chelsea แพ้ 1-2 ที่บ้าน ส่วน xG อยู่ที่ 1.8-1.0' }, input).ok).toBe(true);
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal เพิ่งถล่มคู่แข่ง 2-0 และโอกาสเกิน 2.5 ประตูอยู่ที่ 55%' }, input).ok).toBe(true);
    expect(validatePreviewOutput({ ...ok, home_th: 'Arsenal เพิ่งชนะ 3-0' }, input).violations).toEqual(['scoreline not in input: 3-0']);
    expect(validatePreviewOutput({ ...ok, score_th: '' }, input).violations[0]).toMatch(/^schema:/);
    expect(validatePreviewOutput(null, input).ok).toBe(false);
  });
});

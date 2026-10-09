import { describe, expect, it } from 'vitest';
import { pickRationale, winCondition } from '../src/index.js';

const rows = (...args: Parameters<typeof winCondition>) => winCondition(...args).map((r) => `${r.when} → ${r.outcome}`);

describe('winCondition', () => {
  it('AH whole line with a push: Bremen +2', () => {
    expect(rows({ market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 2 }, 'Dortmund', 'Bremen')).toEqual([
      'Bremen ชนะ เสมอ หรือแพ้ 1 ลูก → WIN',
      'Bremen แพ้ 2 ลูกพอดี → PUSH',
      'Bremen แพ้ 3 ลูกขึ้นไป → LOSS',
    ]);
  });

  it('AH quarter line, favourite: Dortmund −0.75', () => {
    expect(rows({ market: 'ASIAN_HANDICAP', selection: 'HOME', line: -0.75 }, 'Dortmund', 'Bremen')).toEqual([
      'Dortmund ชนะ 2 ลูกขึ้นไป → WIN',
      'Dortmund ชนะ 1 ลูก → HALF_WIN',
      'เสมอ หรือ Dortmund แพ้ → LOSS',
    ]);
  });

  it('AH quarter line, underdog: Bremen +0.25', () => {
    expect(rows({ market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.25 }, 'Dortmund', 'Bremen')).toEqual([
      'Bremen ชนะ → WIN',
      'เสมอ → HALF_WIN',
      'Bremen แพ้ → LOSS',
    ]);
  });

  it('AH half line has no push: Dortmund −1.5', () => {
    expect(rows({ market: 'ASIAN_HANDICAP', selection: 'HOME', line: -1.5 }, 'Dortmund', 'Bremen')).toEqual([
      'Dortmund ชนะ 2 ลูกขึ้นไป → WIN',
      'Dortmund แพ้ เสมอ หรือชนะ 1 ลูก → LOSS',
    ]);
  });

  it('AH −1.25 has a half loss row', () => {
    expect(rows({ market: 'ASIAN_HANDICAP', selection: 'HOME', line: -1.25 }, 'Dortmund', 'Bremen')).toEqual([
      'Dortmund ชนะ 2 ลูกขึ้นไป → WIN',
      'Dortmund ชนะ 1 ลูก → HALF_LOSS',
      'เสมอ หรือ Dortmund แพ้ → LOSS',
    ]);
  });

  it('1X2', () => {
    expect(rows({ market: 'MATCH_WINNER', selection: 'HOME' }, 'Dortmund', 'Bremen')).toEqual(['Dortmund ชนะ → WIN', 'เสมอ หรือ Dortmund แพ้ → LOSS']);
    expect(rows({ market: 'MATCH_WINNER', selection: 'DRAW' }, 'Dortmund', 'Bremen')).toEqual(['เสมอ → WIN', 'ทีมใดทีมหนึ่งชนะ → LOSS']);
  });

  it('Over 2.75 and Under 2.5', () => {
    expect(rows({ market: 'OVER_UNDER', selection: 'OVER', line: 2.75 }, 'H', 'A')).toEqual([
      'รวม 4 ลูกขึ้นไป → WIN',
      'รวม 3 ลูก → HALF_WIN',
      'รวม 2 ลูกหรือน้อยกว่า → LOSS',
    ]);
    expect(rows({ market: 'OVER_UNDER', selection: 'UNDER', line: 2.5 }, 'H', 'A')).toEqual(['รวม 2 ลูกหรือน้อยกว่า → WIN', 'รวม 3 ลูกขึ้นไป → LOSS']);
  });
});

describe('pickRationale', () => {
  const r = (sel: Parameters<typeof pickRationale>[0]) => pickRationale(sel, 'Dortmund', 'Bremen');
  it('says which way the model disagrees with the market', () => {
    expect(r({ market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 2 })).toBe('Dortmund อาจชนะ แต่โมเดลมองว่าจะชนะห่างน้อยกว่าที่ตลาดคาด');
    expect(r({ market: 'ASIAN_HANDICAP', selection: 'AWAY', line: 0.5 })).toBe('โมเดลมองว่า Bremen มีโอกาสไม่แพ้มากกว่าที่ตลาดคาด');
    expect(r({ market: 'ASIAN_HANDICAP', selection: 'HOME', line: -1.25 })).toBe('โมเดลมองว่า Dortmund จะชนะห่างมากกว่าที่ตลาดคาด');
    expect(r({ market: 'ASIAN_HANDICAP', selection: 'HOME', line: 0 })).toBe('โมเดลมองว่า Dortmund มีโอกาสชนะมากกว่าที่ตลาดคาด (เสมอ = เสมอตัว)');
    expect(r({ market: 'MATCH_WINNER', selection: 'AWAY' })).toBe('โมเดลให้โอกาส Bremen ชนะมากกว่าที่ตลาดคาด');
    expect(r({ market: 'MATCH_WINNER', selection: 'DRAW' })).toBe('โมเดลให้โอกาสเสมอมากกว่าที่ตลาดคาด');
    expect(r({ market: 'OVER_UNDER', selection: 'UNDER', line: 2.5 })).toBe('โมเดลมองว่าเกมนี้จะมีประตูน้อยกว่าที่ตลาดคาด');
  });
});

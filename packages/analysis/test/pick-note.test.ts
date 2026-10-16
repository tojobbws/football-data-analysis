import { describe, expect, it } from 'vitest';
import { pickNoteFacts, pickNoteTemplate } from '../src/pick-note.js';

const base = { publishRound: 'EARLY', modelProbability: 0.815, marketProbability: 0.671, signalStrength: 'STRONG' };

describe('pickNoteFacts', () => {
  it('an Asian handicap pick: the team, the line, both chances, the gap and the win conditions', () => {
    const f = pickNoteFacts({ ...base, market: 'ASIAN_HANDICAP', selection: 'HOME', line: 1.75 }, 'Egnatia', 'Midtjylland')!;
    expect(f).toMatchObject({ market: 'ASIAN_HANDICAP', side: 'Egnatia', line: 1.75, label: 'Egnatia +1.75', modelChance: 0.815, marketChance: 0.671, differencePts: 14.4 });
    expect(f.rationale).toBe('Midtjylland อาจชนะ แต่โมเดลมองว่าจะชนะห่างน้อยกว่าที่ตลาดคาด');
    expect(f.winConditions).toEqual(['Egnatia ชนะ เสมอ หรือแพ้ 1 ลูก → ถูก', 'Egnatia แพ้ 2 ลูกพอดี → ผิดครึ่ง', 'Egnatia แพ้ 3 ลูกขึ้นไป → ผิด']);
    expect(pickNoteTemplate(f)).toBe('Midtjylland อาจชนะ แต่โมเดลมองว่าจะชนะห่างน้อยกว่าที่ตลาดคาด โมเดลให้โอกาสถูก 82% ขณะที่ตลาดให้ 67%');
  });

  it('an over/under pick names the side, not a team', () => {
    const f = pickNoteFacts({ ...base, market: 'OVER_UNDER', selection: 'UNDER', line: 2.5, modelProbability: 0.6, marketProbability: 0.52 }, 'A', 'B')!;
    expect(f).toMatchObject({ side: 'UNDER', label: 'Under 2.5', differencePts: 8 });
    expect(f.winConditions).toEqual(['รวม 2 ลูกหรือน้อยกว่า → ถูก', 'รวม 3 ลูกขึ้นไป → ผิด']);
  });

  it('nothing to explain for fog or a pick without both chances', () => {
    expect(pickNoteFacts({ ...base, market: null, selection: null, line: null }, 'A', 'B')).toBeNull();
    expect(pickNoteFacts({ ...base, market: 'ASIAN_HANDICAP', selection: 'HOME', line: 0.5, marketProbability: null }, 'A', 'B')).toBeNull();
  });
});

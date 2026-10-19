import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { aliasesFor } from './aliases.js';
import { kickoffMs, parseFile } from './parse.js';

const dir = mkdtempSync(join(tmpdir(), 'fd-parse-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

describe('kickoffMs', () => {
  it('reads dd/mm/yy and dd/mm/yyyy as UTC', () => {
    expect(kickoffMs('17/08/24', '15:00')).toBe(Date.UTC(2024, 7, 17, 15, 0));
    expect(kickoffMs('17/08/2024', '15:00')).toBe(Date.UTC(2024, 7, 17, 15, 0));
  });
  it('falls back to 12:00 without a time', () => {
    expect(kickoffMs('01/01/2025', '')).toBe(Date.UTC(2025, 0, 1, 12, 0));
  });
});

describe('parseFile main layout', () => {
  const head = 'Div,Date,Time,HomeTeam,AwayTeam,PSH,PSD,PSA,PSCH,PSCD,PSCA,PC>2.5,PC<2.5,AHh,AHCh,PCAHH,PCAHA,B365CH,B365CD,B365CA';
  const row = 'E0,17/08/24,15:00,Man United,Fulham,1.5,4.2,6.5,1.4,4.8,7.5,1.9,2.0,-1.25,-1.5,1.95,1.97,1,0.5,';
  const parsed = parseFile(write('E0_2425.csv', `${head}\n${row}\n`));
  const prices = parsed.matches[0]!.prices;

  it('keeps the early and closing quote apart', () => {
    expect(parsed.format).toBe('main');
    const home = (phase: string) => prices.find((p) => p.market === 'MATCH_WINNER' && p.bookmaker === 'PIN' && p.phase === phase && p.selection === 'HOME');
    expect(home('early')!.odds).toBe(1.5);
    expect(home('close')!.odds).toBe(1.4);
  });
  it('skips odds of 1 or less and empty cells', () => {
    expect(prices.some((p) => p.bookmaker === 'B365')).toBe(false);
  });
  it('puts over/under on the 2.5 line', () => {
    const ou = prices.filter((p) => p.market === 'OVER_UNDER');
    expect(ou.map((p) => [p.selection, p.line, p.odds])).toEqual([['OVER', 2.5, 1.9], ['UNDER', 2.5, 2.0]]);
  });
  it('gives the away side the opposite handicap line, from the closing line', () => {
    const ah = prices.filter((p) => p.market === 'ASIAN_HANDICAP' && p.phase === 'close');
    expect(ah.map((p) => [p.selection, p.line])).toEqual([['HOME', -1.5], ['AWAY', 1.5]]);
  });
  it('does not turn a level handicap into -0', () => {
    const level = parseFile(write('E0_lvl.csv', `${head}\n${row.replace('-1.5,1.95', '0,1.95')}\n`));
    const away = level.matches[0]!.prices.find((p) => p.market === 'ASIAN_HANDICAP' && p.phase === 'close' && p.selection === 'AWAY');
    expect(Object.is(away!.line, 0)).toBe(true);
  });
});

describe('parseFile extra layout', () => {
  const text = 'Country,League,Season,Date,Time,Home,Away,HG,AG,Res,PSCH,PSCD,PSCA\nUSA,MLS,2024,24/02/2024,19:30,Miami,Orlando,2,1,H,1.8,3.9,4.2\nCanada,CPL,2024,24/02/2024,19:30,A,B,0,0,D,2,3,3\n';
  it('keeps 1X2 closing prices only and filters by country', () => {
    const parsed = parseFile(write('USA.csv', text), { country: 'usa' });
    expect(parsed.format).toBe('extra');
    expect(parsed.countries).toEqual(['Canada', 'USA']);
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.matches[0]!.prices.every((p) => p.market === 'MATCH_WINNER' && p.phase === 'close')).toBe(true);
  });
});

describe('parseFile unknown layout', () => {
  it('fails loudly instead of returning nothing', () => {
    expect(() => parseFile(write('bad.csv', 'a,b,c\n1,2,3\n'))).toThrow(/unknown football-data layout/);
  });
});

describe('aliasesFor', () => {
  it('maps football-data names to API-Football names', () => {
    expect(aliasesFor(39)['man united']).toBe('manchester united');
  });
  it('returns an object for a league without aliases', () => {
    expect(typeof aliasesFor(999999)).toBe('object');
  });
});

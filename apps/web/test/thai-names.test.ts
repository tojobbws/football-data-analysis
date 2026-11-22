import { describe, expect, it } from 'vitest';
import { LEAGUE_TH, TEAM_TH, hasTeamTh, leagueTh, teamShortTh, teamTh } from '../src/lib/thai-names';

describe('thai names', () => {
  it('uses the Thai name, the fan name in titles, and falls back to the provider name', () => {
    const mu = { id: 33, name: 'Manchester United' };
    const other = { id: 999_999, name: 'Some FC' };
    expect(teamTh(mu)).toBe('แมนเชสเตอร์ ยูไนเต็ด');
    expect(teamShortTh(mu)).toBe('แมนยู');
    expect(teamShortTh({ id: 40, name: 'Liverpool' })).toBe('ลิเวอร์พูล');
    expect(teamTh(other)).toBe('Some FC');
    expect(teamShortTh(other)).toBe('Some FC');
    expect(hasTeamTh(mu)).toBe(true);
    expect(hasTeamTh(other)).toBe(false);
    expect(leagueTh({ id: 39, name: 'Premier League' })).toBe('พรีเมียร์ลีก');
    expect(leagueTh({ id: 1, name: 'World Cup' })).toBe('World Cup');
  });

  it('has no empty or duplicate Thai names', () => {
    const full = Object.values(TEAM_TH).map((t) => t.th);
    expect(full.every((n) => n.trim().length > 0)).toBe(true);
    expect(new Set(full).size).toBe(full.length);
    expect(Object.values(LEAGUE_TH).every((n) => n.trim().length > 0)).toBe(true);
  });
});

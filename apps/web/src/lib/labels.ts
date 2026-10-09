import { selectionLabel } from '@fp/analysis';

export { selectionLabel };

export type Status = 'PENDING' | 'WIN' | 'HALF_WIN' | 'LOSS' | 'HALF_LOSS' | 'PUSH' | 'VOID' | 'NO_SIGNAL';

/** HALF results are shown separately (not merged into WIN/LOSS). */
export const STATUS: Record<Status, { label: string; icon: string; tone: string }> = {
  PENDING: { label: 'รอผล', icon: '⏳', tone: 'bg-slate-100 text-slate-700 ring-slate-200' },
  WIN: { label: 'WIN', icon: '✅', tone: 'bg-emerald-50 text-emerald-800 ring-emerald-200' },
  HALF_WIN: { label: 'HALF WIN', icon: '🟢', tone: 'bg-emerald-50/60 text-emerald-700 ring-emerald-100' },
  LOSS: { label: 'LOSS', icon: '❌', tone: 'bg-rose-50 text-rose-800 ring-rose-200' },
  HALF_LOSS: { label: 'HALF LOSS', icon: '🟠', tone: 'bg-orange-50 text-orange-800 ring-orange-200' },
  PUSH: { label: 'PUSH', icon: '⚪', tone: 'bg-slate-50 text-slate-600 ring-slate-200' },
  VOID: { label: 'VOID', icon: '➖', tone: 'bg-slate-50 text-slate-500 ring-slate-200' },
  NO_SIGNAL: { label: 'หมอกข้อมูล', icon: '🌫️', tone: 'bg-slate-50 text-slate-500 ring-slate-200' },
};

export const STRENGTH: Record<string, string> = { STRONG: 'STRONG', MEDIUM: 'MEDIUM', LEAN: 'LEAN' };

export const MARKET: Record<string, string> = {
  MATCH_WINNER: '1X2',
  ASIAN_HANDICAP: '🧱 กำแพง (Asian Handicap)',
  OVER_UNDER: 'สูง/ต่ำ (Over/Under)',
};

export const ROUND: Record<string, string> = { EARLY: 'รอบแรก (ก่อนประกาศตัวจริง)', LINEUP: 'หลังประกาศตัวจริง', PREMATCH: 'ก่อนเตะ' };

export const FINISHED = ['FT', 'AET', 'PEN'];
export const LIVE = ['1H', 'HT', '2H', 'ET', 'BT', 'P', 'LIVE', 'INT', 'SUSP'];

/**
 * Fan-facing badge for an unsettled pick, described by the match phase (never a bare "รอผล").
 * null = show no badge: not kicked off yet, or the fixture data hasn't caught up with kickoff.
 */
export function unsettledPhaseLabel(statusShort: string): string | null {
  if (FINISHED.includes(statusShort)) return 'จบเกม · กำลังสรุปผล';
  switch (statusShort) {
    case '1H':
    case '2H':
    case 'LIVE':
      return 'กำลังแข่ง';
    case 'HT':
      return 'พักครึ่ง';
    case 'ET':
    case 'BT':
      return 'ต่อเวลาพิเศษ';
    case 'P':
      return 'ดวลจุดโทษ';
    case 'SUSP':
    case 'INT':
      return 'หยุดการแข่งขันชั่วคราว';
    case 'PST':
      return 'เลื่อนการแข่งขัน';
    default:
      return null;
  }
}

export const pct = (p: number | null | undefined, d = 0) => (p == null ? '–' : `${(Number(p) * 100).toFixed(d)}%`);
export const odds = (o: number | null | undefined) => (o == null ? '–' : Number(o).toFixed(2));

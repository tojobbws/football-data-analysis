/** All dates on the site are shown in Thai time. */
export const TZ = 'Asia/Bangkok';

/** YYYY-MM-DD of `d` in Thai time */
export function thaiDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** [start, end) of a Thai calendar day as UTC ISO strings */
export function thaiDayRange(date: string): { from: string; to: string } {
  const from = new Date(`${date}T00:00:00+07:00`);
  return { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() };
}

/**
 * A "football day" runs 06:00 → 06:00 Thai time, so late kick-offs (01:30, 02:00) stay with the evening
 * they belong to — the way Thai fans read "บอลคืนนี้". Used by the scoreboard views only.
 */
export const FOOTBALL_DAY_START_HOUR = 6;

export function footballDayRange(date: string): { from: string; to: string } {
  const from = new Date(`${date}T0${FOOTBALL_DAY_START_HOUR}:00:00+07:00`);
  return { from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString() };
}

/** The football day `d` falls in (before 06:00 Thai time = still the previous day). */
export function footballDate(d: Date = new Date()): string {
  return thaiDate(new Date(d.getTime() - FOOTBALL_DAY_START_HOUR * 3_600_000));
}

export function addDaysStr(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00+07:00`);
  return thaiDate(new Date(d.getTime() + days * 86_400_000));
}

export function isValidDate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('th-TH', { timeZone: TZ, ...opts });
export const timeTH = (iso: string) => fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
export const dayTH = (iso: string) => fmt({ weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
export const shortDayTH = (iso: string) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(iso));
export const dateTimeTH = (iso: string) => fmt({ day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
export const weekdayShortTH = (iso: string) => fmt({ weekday: 'short' }).format(new Date(iso));
export const dayMonthTH = (iso: string) => fmt({ day: 'numeric', month: 'short' }).format(new Date(iso));

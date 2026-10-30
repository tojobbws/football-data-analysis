export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** YYYY-MM-DD in a given IANA timezone (default UTC). */
export function toDateString(d: Date, timeZone = 'UTC'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * The football day `d` falls in: 06:00 → 06:00 Thai time (UTC+7, no DST), so late kick-offs stay with
 * their evening. Same rule as the site's scoreboard (apps/web/src/lib/time.ts).
 */
export function footballDay(d: Date): { date: string; from: Date; to: Date } {
  const date = toDateString(new Date(d.getTime() + (7 - 6) * 3_600_000));
  const from = new Date(`${date}T06:00:00+07:00`);
  return { date, from, to: addDays(from, 1) };
}

/**
 * How far ahead the pre-match jobs look: `hours`, but capped so a match is only analysed close to its day
 * and with fresh data. Before 12:00 Thai of the football day the cap is 12:00 + FOOTBALL_DAY_GRACE_HOURS
 * (16:00 the same day); from 12:00 it is the end of the football day + the grace (10:00 next morning), so the
 * evening and late kick-offs (Europe) are analysed from midday, and the early-morning ones (Brazil,
 * 06:00–10:00 Thai) get hours of lead instead of one or two.
 */
export const FOOTBALL_DAY_GRACE_HOURS = 4;

export function footballDayHorizon(now: Date, hours: number): Date {
  const end = addHours(now, hours);
  const day = footballDay(now);
  const noon = addHours(day.from, 6);
  const cap = addHours(now < noon ? noon : day.to, FOOTBALL_DAY_GRACE_HOURS);
  return cap < end ? cap : end;
}

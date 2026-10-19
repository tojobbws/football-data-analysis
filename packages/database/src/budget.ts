/**
 * API-Football request budget (slice 05, migration 0039). The plan allows 7,500 requests a day;
 * each job belongs to a group (api_job_groups) with a daily cap (api_budgets).
 */
export interface JobBudget {
  group: string;
  /** requests that counted against today's quota (the API day starts at 00:00 UTC) */
  used: number;
  cap: number;
  /** false = counted and reported but never skipped (results, lineups) */
  enforced: boolean;
}

/** Share of the cap at which the admin page warns. */
export const BUDGET_WARN_RATIO = 0.8;

export type BudgetVerdict = 'ok' | 'warn' | 'stop';

/** stop = skip the job (only when enforced); warn = at or above 80% of the cap. */
export function budgetVerdict(b: Pick<JobBudget, 'used' | 'cap' | 'enforced'>): BudgetVerdict {
  if (b.enforced && b.used >= b.cap) return 'stop';
  if (b.cap > 0 && b.used / b.cap >= BUDGET_WARN_RATIO) return 'warn';
  return 'ok';
}

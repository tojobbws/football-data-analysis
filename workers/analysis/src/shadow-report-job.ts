/**
 * How the shadow pick rules compare with the real ones on matches that have kicked off:
 * which side they pick (getting the start / giving it / AH 0 / over / under) and how the
 * picks turned out (90-minute result, same settlement rules as the track record).
 * Read-only; nothing is published or stored.
 */
import { decideSettlement, SHADOW_RULES } from '@fp/analysis';
import type { JobContext } from '@fp/database';

const sideOf = (market: string, selection: string, line: number | null) =>
  market === 'OVER_UNDER' ? selection : market !== 'ASIAN_HANDICAP' || line === null ? market : line > 0 ? 'AH รอง' : line < 0 ? 'AH ต่อ' : 'AH 0';

const num = (x: unknown) => (x == null ? null : Number(x));

type Tally = { picks: number; win: number; halfWin: number; push: number; halfLoss: number; loss: number; open: number };
const empty = (): Tally => ({ picks: 0, win: 0, halfWin: 0, push: 0, halfLoss: 0, loss: 0, open: 0 });
const KEY: Record<string, keyof Tally> = { WIN: 'win', HALF_WIN: 'halfWin', PUSH: 'push', HALF_LOSS: 'halfLoss', LOSS: 'loss' };

function add(t: Map<string, Tally>, side: string, status: string | null) {
  const row = t.get(side) ?? empty();
  t.set(side, row);
  row.picks++;
  const k = status ? KEY[status] : undefined;
  if (k) row[k]++;
  else row.open++;
}

export async function shadowReport(ctx: JobContext, opts: { rulesVersion?: string; now?: Date } = {}) {
  const version = opts.rulesVersion ?? SHADOW_RULES.version;
  const now = opts.now ?? new Date();
  const rows = await ctx.repo.shadowDecisionsToReview(version);
  const shadow = new Map<string, Tally>();
  let fog = 0;
  for (const r of rows) {
    if (r.outcome !== 'SIGNAL') {
      fog++;
      continue;
    }
    const line = r.line == null ? null : Number(r.line);
    const kickoffAt = new Date(r.kickoff_at as string);
    const d = decideSettlement(
      { market: String(r.market), selection: String(r.selection), line, kickoffAt },
      {
        statusShort: String(r.status_short),
        kickoffAt,
        home: num(r.ft_home ?? r.goals_home),
        away: num(r.ft_away ?? r.goals_away),
        syncedAt: new Date(r.synced_at as string),
      },
      now,
    );
    add(shadow, sideOf(String(r.market), String(r.selection), line), d.action === 'SETTLE' ? d.status : null);
  }

  const since = rows.length ? new Date(Math.min(...rows.map((r) => new Date(r.kickoff_at as string).getTime()))) : now;
  const real = new Map<string, Tally>();
  for (const p of await ctx.repo.publishedPicksSince(since)) add(real, sideOf(p.market, p.selection, p.line), p.status === 'PENDING' ? null : p.status);

  const table = (t: Map<string, Tally>) => [...t].sort(([a], [b]) => a.localeCompare(b)).map(([side, x]) => ({ side, ...x }));
  return { version, since, matches: rows.length, noClearSignal: fog, shadow: table(shadow), real: table(real) };
}

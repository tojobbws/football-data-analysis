import { runJob, trackedLeagueSeasons, type JobContext } from '@fp/database';
import { normaliseOdds, type Market, type OddsItem } from '@fp/football';

const VALID_MARKETS: readonly Market[] = ['MATCH_WINNER', 'ASIAN_HANDICAP', 'OVER_UNDER', 'OTHER'];

export interface OddsSyncResult {
  inserted: number;
  unchanged: number;
  skippedValues: number;
  unknownFixtures: number;
}

/**
 * Pre-match odds snapshot -> odds_history (append-only).
 * Run hourly (and more often close to kickoff). Unchanged odds are de-duplicated
 * by the API's `update` timestamp, so frequent polling is cheap on storage.
 */
export function syncOdds(ctx: JobContext, opts: { fixture?: number } = {}) {
  const leagues = ctx.env.TRACKED_LEAGUES;
  const markets = ctx.env.ODDS_MARKETS.filter((m): m is Market => (VALID_MARKETS as readonly string[]).includes(m));
  const bookmakers = ctx.env.ODDS_BOOKMAKERS.length ? ctx.env.ODDS_BOOKMAKERS : [undefined];

  return runJob(ctx, 'odds', { leagues, markets, bookmakers: ctx.env.ODDS_BOOKMAKERS, ...opts }, async () => {
    const total: OddsSyncResult = { inserted: 0, unchanged: 0, skippedValues: 0, unknownFixtures: 0 };
    const scopes = opts.fixture ? [{ fixture: opts.fixture }] : await trackedLeagueSeasons(ctx);

    for (const scope of scopes) {
      for (const bookmaker of bookmakers) {
        const { pages } = await ctx.api.odds({ ...scope, bookmaker });
        for (const page of pages) {
          const r = await storeOddsPage(ctx, page.data, page.meta.rawResponseId, markets);
          total.inserted += r.inserted;
          total.unchanged += r.unchanged;
          total.skippedValues += r.skippedValues;
          total.unknownFixtures += r.unknownFixtures;
        }
      }
    }
    ctx.log.info('odds summary', { ...total });
    return total.inserted;
  });
}

export async function storeOddsPage(
  ctx: Pick<JobContext, 'repo' | 'log'>,
  items: OddsItem[],
  rawResponseId: number | null,
  markets: readonly Market[],
): Promise<OddsSyncResult> {
  const res: OddsSyncResult = { inserted: 0, unchanged: 0, skippedValues: 0, unknownFixtures: 0 };
  if (!items.length) return res;

  // odds for fixtures we have not synced yet are skipped (run `sync:fixtures` first)
  const known = await ctx.repo.existingFixtureIds(items.map((i) => i.fixture.id));

  const bookmakerMap = new Map<number, string>();
  for (const it of items) for (const b of it.bookmakers ?? []) bookmakerMap.set(b.id, b.name);
  await ctx.repo.upsertBookmakers([...bookmakerMap].map(([id, name]) => ({ id, name })));

  for (const item of items) {
    if (!known.has(item.fixture.id)) {
      res.unknownFixtures += 1;
      continue;
    }
    const { rows, skipped } = normaliseOdds(item, markets);
    if (skipped.length) {
      res.skippedValues += skipped.length;
      ctx.log.debug('unparsed odds values', { fixture: item.fixture.id, sample: skipped.slice(0, 5) });
    }
    const inserted = await ctx.repo.insertOddsHistory(rows, rawResponseId);
    res.inserted += inserted;
    res.unchanged += rows.length - inserted;
  }
  return res;
}

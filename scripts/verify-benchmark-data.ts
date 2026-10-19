/**
 * Read-only audit of the data behind scripts/backtest-vs-market.ts and scripts/compare-models.ts.
 *   npx tsx scripts/verify-benchmark-data.ts [--book PIN]
 * Prints: where the closing prices come from, how many matches have a complete closing 1X2, how many the
 * benchmark scores, how sane the prices are (overround, calibration against real results), and whether any
 * stored model probability was computed at or after kickoff.
 */
import { parseArgs } from 'node:util';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({ options: { book: { type: 'string', default: 'PIN' } } });
const book = values.book!;
loadDotEnvFile();
const db = createPgDb(loadEnv().DATABASE_URL, { max: 1 });
const rows = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<R>(sql, params)).rows;
const section = (t: string) => console.log(`\n== ${t} ==`);

try {
  section('our own odds tables (not what the benchmark uses)');
  console.table(
    await rows(`select (select count(*) from market_closing) as market_closing_rows,
                       (select count(distinct fixture_id) from market_closing) as market_closing_fixtures,
                       (select count(*) from odds_history) as odds_history_rows,
                       (select count(distinct fixture_id) from odds_history) as odds_history_fixtures`),
  );

  section('external_odds: source, bookmaker, phase, market -> fixtures with a price');
  console.table(
    await rows(`select source, bookmaker, phase, market, count(distinct fixture_id)::int as fixtures, count(*)::int as price_rows
                  from external_odds group by 1,2,3,4 order by 1,2,3,4`),
  );

  section(`${book} closing 1X2: complete (3 sides) vs finished fixtures, per league`);
  console.table(
    await rows(
      `with c as (
         select o.fixture_id, count(distinct o.selection) as sides, min(o.odds) as lo, max(o.odds) as hi,
                sum(1 / o.odds) as overround
           from external_odds o
          where o.bookmaker = $1 and o.phase = 'close' and o.market = 'MATCH_WINNER'
          group by 1)
       select l.country || ' ' || l.name as league,
              count(*) filter (where f.status_short in ('FT','AET','PEN'))::int as finished_fixtures,
              count(c.fixture_id) filter (where c.sides = 3)::int as with_full_close_1x2,
              count(c.fixture_id) filter (where c.sides <> 3)::int as partial,
              round(avg(c.overround) filter (where c.sides = 3)::numeric, 4) as avg_overround,
              min(c.lo) as min_odds, max(c.hi) as max_odds
         from fixtures f join leagues l on l.id = f.league_id join c on c.fixture_id = f.id
        group by 1 order by 3 desc`,
      [book],
    ),
  );

  section('calibration of the closing price against real 90-minute results (a wrong fixture match would break this)');
  const cal = await rows<{ bucket: number; outcomes: number; avg_p: string; hit_rate: string }>(
    `with c as (
       select o.fixture_id,
              max(1/o.odds) filter (where o.selection = 'HOME') as ih,
              max(1/o.odds) filter (where o.selection = 'DRAW') as id,
              max(1/o.odds) filter (where o.selection = 'AWAY') as ia
         from external_odds o where o.bookmaker = $1 and o.phase = 'close' and o.market = 'MATCH_WINNER' group by 1),
     p as (
       select f.id, c.ih / (c.ih + c.id + c.ia) as ph, c.id / (c.ih + c.id + c.ia) as pd, c.ia / (c.ih + c.id + c.ia) as pa,
              coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga
         from fixtures f join c on c.fixture_id = f.id
        where f.status_short in ('FT','AET','PEN') and c.ih is not null and c.id is not null and c.ia is not null and coalesce(f.ft_home, f.goals_home) is not null),
     o as (
       select ph as p, (gh > ga) as hit from p union all select pd, (gh = ga) from p union all select pa, (gh < ga) from p)
     select least(floor(p * 10), 9)::int as bucket, count(*)::int as outcomes, round(avg(p)::numeric, 4) as avg_p, round(avg(hit::int)::numeric, 4) as hit_rate
       from o group by 1 order by 1`,
    [book],
  );
  console.table(cal);
  const worst = Math.max(...cal.filter((r) => r.outcomes >= 200).map((r) => Math.abs(Number(r.avg_p) - Number(r.hit_rate))));
  console.log(`largest |avg price probability - real frequency| in a band with >= 200 outcomes: ${worst.toFixed(4)}`);

  section('stored model probabilities: any computed at or after kickoff? (the views ignore them)');
  console.table(
    await rows(`select model_version_id,
                       count(distinct p.fixture_id)::int as fixtures,
                       count(distinct p.fixture_id) filter (where p.computed_at >= f.kickoff_at)::int as fixtures_with_a_post_kickoff_row,
                       count(distinct p.fixture_id) filter (where p.computed_at < f.kickoff_at)::int as fixtures_with_a_pre_kickoff_row,
                       min(p.computed_at)::date as first_run, max(p.computed_at)::date as last_run
                  from probability_predictions p join fixtures f on f.id = p.fixture_id
                 group by 1 order by 1`),
  );
  console.table(
    await rows(`select count(*)::int as rows_after_final_whistle
                  from probability_predictions p join fixtures f on f.id = p.fixture_id
                 where f.status_short in ('FT','AET','PEN') and p.computed_at >= f.kickoff_at + interval '3 hours'`),
  );
} finally {
  await db.close();
}

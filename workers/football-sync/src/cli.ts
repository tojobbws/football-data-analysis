import { parseArgs } from 'node:util';
import { createJobContext } from '@fp/database';
import { loadDotEnvFile } from '@fp/shared';
import {
  pruneStorage,
  syncApiPredictions,
  syncFinishedDetails,
  syncFixtures,
  syncInjuries,
  syncLeagues,
  syncLive,
  syncPlayers,
  syncPrematchLineups,
  syncResults,
  syncStandings,
  syncSupportLeagues,
  syncTeams,
} from './jobs.js';

const USAGE = `usage: npm run job -- <job> [options]

jobs:
  leagues                         leagues + seasons for TRACKED_LEAGUES
  teams                           teams + venues
  fixtures [--from D --to D] [--season Y]  fixtures (whole season, or YYYY-MM-DD window; --season for history)
  details  [--limit N] [--league IDS] [--season YEARS]   events/stats/xG/lineups/players of finished matches (IDS/YEARS comma-separated)
  results  [--days N]             scores/status of matches that kicked off (last N days, default 14) + pending analyses
  live                            live scores of matches in play (no API call when none on; prod: workers/live-score cron)
  lineups  [--minutes N]          confirmed lineups for matches starting soon (default 90)
  injuries [--days N]             injuries for the next N days (default 3)
  predictions [--hours N]         API-Football predictions for next N hours (default 48)
  standings
  support  [--last N]             results of untracked domestic leagues behind cross-league cups (last N per league, default 30)
                                  + last 5 results of national teams playing a tracked national-team match within 72 h
  players  [--max-pages N]        player season stats (heavy, weekly)
  bootstrap                       leagues -> teams -> fixtures -> standings
  prune    [--days N] [--vacuum]  delete raw API responses older than N days (default 3; odds snapshots are kept); --vacuum frees the raw table's disk space`;

async function main() {
  loadDotEnvFile();
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      season: { type: 'string' },
      to: { type: 'string' },
      limit: { type: 'string' },
      league: { type: 'string' },
      minutes: { type: 'string' },
      days: { type: 'string' },
      hours: { type: 'string' },
      'max-pages': { type: 'string' },
      vacuum: { type: 'boolean' },
      last: { type: 'string' },
    },
  });
  const job = positionals[0];
  if (!job) {
    console.log(USAGE);
    process.exit(1);
  }
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  const ints = (v: string | undefined) => (v === undefined ? undefined : v.split(',').map((x) => Number(x.trim())).filter(Number.isInteger));
  const ctx = createJobContext();
  try {
    switch (job) {
      case 'leagues':
        await syncLeagues(ctx);
        break;
      case 'teams':
        await syncTeams(ctx);
        break;
      case 'fixtures':
        await syncFixtures(ctx, { from: values.from, to: values.to, season: num(values.season) });
        break;
      case 'details':
        await syncFinishedDetails(ctx, { limit: num(values.limit), leagues: ints(values.league), seasons: ints(values.season) });
        break;
      case 'results':
        await syncResults(ctx, { days: num(values.days) });
        break;
      case 'live':
        await syncLive(ctx);
        break;
      case 'lineups':
        await syncPrematchLineups(ctx, { withinMinutes: num(values.minutes) });
        break;
      case 'injuries':
        await syncInjuries(ctx, { days: num(values.days) });
        break;
      case 'predictions':
        await syncApiPredictions(ctx, { hours: num(values.hours) });
        break;
      case 'support':
        await syncSupportLeagues(ctx, { last: num(values.last) });
        break;
      case 'standings':
        await syncStandings(ctx);
        break;
      case 'players':
        await syncPlayers(ctx, { maxPages: num(values['max-pages']) });
        break;
      case 'prune':
        await pruneStorage(ctx, { days: num(values.days), vacuum: values.vacuum });
        break;
      case 'bootstrap':
        await syncLeagues(ctx);
        await syncTeams(ctx);
        await syncFixtures(ctx);
        await syncStandings(ctx);
        break;
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await ctx.db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

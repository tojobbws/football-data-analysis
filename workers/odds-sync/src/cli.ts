import { parseArgs } from 'node:util';
import { createJobContext } from '@fp/database';
import { loadDotEnvFile } from '@fp/shared';
import { syncOdds } from './jobs.js';

async function main() {
  loadDotEnvFile();
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { fixture: { type: 'string' } } });
  if (positionals[0] !== 'odds') {
    console.log('usage: npm run job -- odds [--fixture ID]');
    process.exit(1);
  }
  // odds_history already holds every quote; raw /odds pages were most of the database (ADR 0002)
  const ctx = createJobContext({ storeRawResponses: false });
  try {
    await syncOdds(ctx, { fixture: values.fixture ? Number(values.fixture) : undefined });
  } finally {
    await ctx.db.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

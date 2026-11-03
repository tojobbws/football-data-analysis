/**
 * Probe of four API-Football endpoints for one team: what the API accepts, what comes back, how big, what it costs.
 * Read-only against the API, writes nothing to the database (no raw-response callback); the full responses go to --out.
 *   npx tsx scripts/api-probe-team.ts --team 40 --league 39 --season 2026 --out <dir>
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { ApiFootballClient } from '@fp/football';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({ options: { team: { type: 'string', default: '40' }, league: { type: 'string', default: '39' }, season: { type: 'string', default: '2026' }, out: { type: 'string' } } });
loadDotEnvFile();
const env = loadEnv();
const client = new ApiFootballClient({ apiKey: env.API_FOOTBALL_KEY, baseUrl: env.API_FOOTBALL_BASE_URL, requestsPerMinute: env.API_FOOTBALL_RPM, maxRetries: 0 });
const out = values.out!;
await mkdir(out, { recursive: true });

let calls = 0;
let remaining: number | null = null;
async function probe(name: string, endpoint: string, params: Record<string, string | number>) {
  calls++;
  try {
    const r = await client.get<unknown[]>(endpoint, params);
    remaining = r.meta.rateLimit.dailyRemaining;
    const json = JSON.stringify(r.envelope);
    await writeFile(`${out}/${name}.json`, JSON.stringify(r.envelope, null, 2));
    const e = r.envelope as { results?: number; errors?: unknown; paging?: unknown };
    console.log(`\n## ${name}  GET ${endpoint} ${JSON.stringify(params)}`);
    console.log(`   results=${e.results} paging=${JSON.stringify(e.paging)} errors=${JSON.stringify(e.errors)} bytes=${json.length} dailyRemaining=${remaining}`);
    return r.data;
  } catch (err) {
    console.log(`\n## ${name}  GET ${endpoint} ${JSON.stringify(params)}\n   ERROR ${String(err).slice(0, 300)}`);
    return null;
  }
}

const squads = (await probe('squads', '/players/squads', { team: values.team! })) as Array<{ team: { id: number; name: string }; players: Array<{ id: number; name: string; age: number | null; number: number | null; position: string | null }> }> | null;
const squad = squads?.[0]?.players ?? [];
console.log(`   squad: ${squads?.[0]?.team.name}, ${squad.length} players; sample ${JSON.stringify(squad.slice(0, 2))}`);

const stats = (await probe('team-statistics', '/teams/statistics', { league: values.league!, season: values.season!, team: values.team! })) as unknown as Record<string, unknown> | null;
if (stats) console.log(`   top-level keys: ${Object.keys(stats).join(', ')}`);

const transfers = (await probe('transfers-team', '/transfers', { team: values.team! })) as Array<{ player: { id: number; name: string }; transfers: Array<{ date: string; type: string | null; teams: { in: { name: string }; out: { name: string } } }> }> | null;
if (transfers) {
  const all = transfers.flatMap((t) => t.transfers.map((x) => ({ player: t.player.name, ...x })));
  const dates = all.map((x) => x.date).sort();
  console.log(`   players with transfers: ${transfers.length}, transfer rows: ${all.length}, dates ${dates[0]} .. ${dates[dates.length - 1]}`);
  console.log(`   latest 3: ${JSON.stringify(all.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3).map((x) => `${x.date} ${x.player}: ${x.teams.out.name} -> ${x.teams.in.name} (${x.type})`))}`);
}

const ids = squad.slice(0, 3).map((p) => p.id);
if (ids.length) {
  await probe('sidelined-one', '/sidelined', { player: ids[0]! });
  await probe('sidelined-many', '/sidelined', { players: ids.join('-') });
}
console.log(`\nrequests made: ${calls} · daily remaining after: ${remaining}`);

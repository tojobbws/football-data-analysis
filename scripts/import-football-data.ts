/**
 * Import football-data.co.uk CSV files (main or "extra leagues" layout) into external_odds.
 * Usage: tsx scripts/import-football-data.ts <dir|file> <league_id> [--prefix=E1_] [--country=USA] [--apply]
 *   --prefix   only read files whose name starts with this (a folder may hold several leagues, e.g. --prefix=E1_).
 *   --country  extra-leagues files only: the Country column value to keep (the files hold one country,
 *              but the script lists the countries it finds if the name does not match).
 * Without --apply it only matches and reports (nothing is written).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createPgDb, writeRows } from '@fp/database';
import { loadDotEnvFile } from '@fp/shared';
import { aliasesFor } from './football-data/aliases.js';
import { parseFile } from './football-data/parse.js';

loadDotEnvFile();
const args = process.argv.slice(2);
const [target, leagueArg] = args.filter((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
const country = args.find((a) => a.startsWith('--country='))?.slice('--country='.length);
const showUnmatched = args.includes('--show-unmatched');
const prefix = args.find((a) => a.startsWith('--prefix='))?.slice('--prefix='.length) ?? '';
const leagueId = Number(leagueArg);
if (!target || !leagueId || !process.env.DATABASE_URL) {
  console.error('usage: tsx scripts/import-football-data.ts <dir|file> <league_id> [--country=USA] [--apply]  (needs DATABASE_URL)');
  process.exit(1);
}

const SOURCE = 'football-data.co.uk';
const DAY = 86400_000;
/** Lower case, accents and dots removed (ü->u, ş->s, İ/ı->i), so both sides compare on plain letters. */
const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ı/g, 'i')
    .toLowerCase()
    // letters that have no accent to strip (ł, ø, đ, ß, æ, œ)
    .replace(/ł/g, 'l')
    .replace(/ø/g, 'o')
    .replace(/đ/g, 'd')
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/\s+/g, ' ')
    .trim();
const aliases = Object.fromEntries(Object.entries(aliasesFor(leagueId)).map(([k, v]) => [norm(k), norm(v)]));

const files = statSync(target).isDirectory()
  ? readdirSync(target)
      .filter((f) => f.toLowerCase().endsWith('.csv') && f.startsWith(prefix))
      .sort()
      .map((f) => join(target, f))
  : [target];

const db = createPgDb(process.env.DATABASE_URL, { max: 1 });
try {
  const teams = (
    await db.query<{ id: number; name: string }>(
      `select distinct t.id, t.name from teams t
       join fixtures f on t.id in (f.home_team_id, f.away_team_id) where f.league_id = $1`,
      [leagueId],
    )
  ).rows;
  const teamByName = new Map(teams.map((t) => [norm(t.name), t.id]));
  const fixtures = (
    await db.query<{ id: number; home: number; away: number; ko: Date }>(
      `select id, home_team_id home, away_team_id away, kickoff_at ko from fixtures where league_id = $1`,
      [leagueId],
    )
  ).rows;
  if (fixtures.length === 0) throw new Error(`no fixtures for league ${leagueId}`);
  const byPair = new Map<string, { id: number; ms: number }[]>();
  let from = Infinity;
  let to = -Infinity;
  for (const f of fixtures) {
    const ms = new Date(f.ko).getTime();
    from = Math.min(from, ms);
    to = Math.max(to, ms);
    const k = `${f.home}-${f.away}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k)!.push({ id: f.id, ms });
  }

  const unknown = new Set<string>();
  const out: Record<string, unknown>[] = [];
  const perFile: string[] = [];
  const countriesSeen = new Set<string>();
  let rowsSeen = 0;
  let matched = 0;
  let unmatched = 0;
  let outOfRange = 0;
  let unknownTeams = 0;

  for (const file of files) {
    const parsed = parseFile(file, { country });
    parsed.countries.forEach((c) => countriesSeen.add(c));
    let m = 0;
    let u = 0;
    for (const row of parsed.matches) {
      rowsSeen++;
      if (row.kickoffMs < from - 3 * DAY || row.kickoffMs > to + 3 * DAY) {
        outOfRange++; // before/after the fixtures this DB holds for the league
        continue;
      }
      const resolve = (n: string) => teamByName.get(aliases[norm(n)] ?? norm(n));
      const home = resolve(row.home);
      const away = resolve(row.away);
      if (!home || !away) {
        unknownTeams++;
        if (!home) unknown.add(row.home);
        if (!away) unknown.add(row.away);
        continue;
      }
      const cand = (byPair.get(`${home}-${away}`) ?? []).filter((c) => Math.abs(c.ms - row.kickoffMs) < 3 * DAY);
      if (cand.length !== 1) {
        u++;
        unmatched++;
        if (showUnmatched && unmatched <= 15) {
          const near = (byPair.get(`${home}-${away}`) ?? []).map((c) => new Date(c.ms).toISOString().slice(0, 10)).join(',');
          console.log(`  unmatched: ${new Date(row.kickoffMs).toISOString().slice(0, 10)} ${row.home} v ${row.away} (${cand.length} fixtures within 3 days; this pairing in DB: ${near || 'none'})`);
        }
        continue;
      }
      m++;
      matched++;
      for (const p of row.prices) out.push({ fixture_id: cand[0]!.id, source: SOURCE, ...p });
    }
    perFile.push(`  ${file.split(/[\\/]/).pop()} (${parsed.format}): matched ${m}, unmatched ${u}`);
  }

  console.log(perFile.join('\n'));
  console.log(
    `csv rows: ${rowsSeen}, matched: ${matched}, unmatched (teams found, no fixture): ${unmatched}, ` +
      `team name not found: ${unknownTeams}, outside DB date range: ${outOfRange}`,
  );
  console.log(`team names not found: ${[...unknown].sort().join(', ') || '-'}`);
  if (country && countriesSeen.size > 0 && ![...countriesSeen].some((c) => c.toLowerCase() === country.toLowerCase())) {
    console.log(`--country=${country} matched nothing; countries in the file: ${[...countriesSeen].join(', ')}`);
  }
  console.log(`rows to write: ${out.length}`);
  if (apply) {
    const n = await writeRows(db, 'external_odds', out, { conflict: ['fixture_id', 'source', 'bookmaker', 'phase', 'market', 'selection'] });
    console.log(`written: ${n}`);
  } else {
    console.log('dry run - pass --apply to write');
  }
} finally {
  await db.close();
}

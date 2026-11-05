// Pull the day's featured list (เข็มทิศเกมประจำวัน) from production into days/<date>/facts.json and cache the
// real club / league logos. Order = league importance (desc), then the list's rank, which is the order the
// opening shows the leagues and the order the matches are narrated.
// usage: node fetch.cjs [YYYY-MM-DD]   (default: the current football day, 06:00-06:00 Thai)
const path = require('path');
const { Client } = require('pg');
const { dateArg, dayDir, writeJson, MONTHS_FULL, kickoffTh, logo } = require('./lib.cjs');

const VERSIONS = ['featured-v2', 'featured-ai-v1'];          // same rule as apps/web/src/lib/queries.ts listVersion
const listVersion = (vs) => (vs.includes('featured-ai-v1') ? 'featured-ai-v1' : vs.includes('featured-v2') ? 'featured-v2' : null);

(async () => {
  const date = dateArg();
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (s, p) => (await c.query(s, p)).rows;
  const sel = await q(`select fixture_id, rank, version, prediction_id from featured_selections where football_date = $1 and version = any($2) and rank is not null`, [date, VERSIONS]);
  const version = listVersion(sel.map((r) => r.version));
  const rows = sel.filter((r) => r.version === version).sort((a, b) => a.rank - b.rank);
  if (!rows.length) { console.error(`no featured list for ${date}`); process.exit(2); }
  const out = [];
  for (const r of rows) {
    const [f] = await q(`select f.id, f.season, f.round, f.kickoff_at, f.status_short, l.id league_id, l.name league, l.logo_url llogo,
        h.id hid, h.name home, h.logo_url hlogo, a.id aid, a.name away, a.logo_url alogo, v.name venue,
        (select importance from league_importance li where li.league_id = l.id and li.season in (0, f.season) order by li.season desc limit 1) importance
      from fixtures f join leagues l on l.id = f.league_id join teams h on h.id = f.home_team_id join teams a on a.id = f.away_team_id
      left join venues v on v.id = f.venue_id where f.id = $1`, [r.fixture_id]);
    // the newest published round replaces earlier ones on fan pages
    const preds = await q(`select id, publish_round, kind, market, selection, line, odds_at_publish, reason, decision_rule_version, published_at, status
      from analysis_predictions where fixture_id = $1 and kind = (select kind from analysis_predictions where id = $2) order by published_at desc`, [r.fixture_id, r.prediction_id]);
    const p = preds[0];
    if (!p) throw new Error(`fixture ${r.fixture_id}: no prediction`);
    const first = (p.reason || '').split('\n')[0];
    const label = (first.match(/เข็มทิศเกม:\s*(.+?)\s*\(/) || [])[1] || `${p.selection} ${p.line}`;
    const books = Number(((p.reason || '').match(/จาก (\d+) เจ้า/) || [])[1]) || null;
    const isOU = p.market === 'OVER_UNDER';
    out.push({
      key: `m${r.rank}`, rank: r.rank, list_version: version, fixture_id: Number(f.id), prediction_id: Number(p.id),
      featured_prediction_id: Number(r.prediction_id), publish_round: p.publish_round, engine: p.decision_rule_version, status: p.status,
      league: f.league, league_id: Number(f.league_id), league_importance: f.importance == null ? 30 : Number(f.importance),
      league_logo: await logo(f.llogo, `leagues-${f.league_id}.png`), round: f.round, venue: f.venue,
      kickoff_utc: f.kickoff_at, kickoff_th: kickoffTh(f.kickoff_at), fixture_status: f.status_short,
      home: { name: f.home, logo: await logo(f.hlogo, `teams-${f.hid}.png`) },
      away: { name: f.away, logo: await logo(f.alogo, `teams-${f.aid}.png`) },
      pick: isOU
        ? { type: 'ou', side: p.selection.toLowerCase(), label, line: Number(p.line).toString(), odds: Number(p.odds_at_publish).toFixed(2), books }
        : { type: 'team', side: p.selection.toLowerCase(), label, line: Number(p.line), odds: Number(p.odds_at_publish).toFixed(2), books },
      reason: p.reason,
    });
  }
  await c.end();
  out.sort((a, b) => b.league_importance - a.league_importance || a.rank - b.rank);
  const [, mo, d] = date.split('-').map(Number);
  const facts = { date, date_th: `วันที่ ${d} ${MONTHS_FULL[mo - 1]}`, list_version: version, fetched_at: new Date().toISOString(), matches: out };
  writeJson(path.join(dayDir(date), 'facts.json'), facts);
  console.log(`${date} (${version}) -> days/${date}/facts.json`);
  for (const m of out) {
    console.log(`\n[${m.key}] ${m.league} (importance ${m.league_importance}) · ${m.home.name} vs ${m.away.name} · ${m.kickoff_th} · ${m.fixture_status}`);
    console.log(`  pick: ${m.pick.label} @ ${m.pick.odds} (${m.publish_round}, ${m.engine}${m.prediction_id !== m.featured_prediction_id ? `, newer than featured row ${m.featured_prediction_id}` : ''})`);
    console.log('  ' + (m.reason || '').split('\n').slice(1).join('\n  '));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

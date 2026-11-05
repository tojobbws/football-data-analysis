// Pull a finished football day's featured list (คู่น่าจับตา) with the real scores and settled results into
// days/<date>/recap/facts.json, for the Yesterday Prediction Recap film. Same list, same pick (the newest
// published round) and same counting as /performance (apps/web/src/components/watched-day.tsx daySummary).
// usage: node recap-fetch.cjs [YYYY-MM-DD]   (default: yesterday's football day)
const path = require('path');
const { Client } = require('pg');
const { dayDir, writeJson, currentFootballDay, MONTHS, MONTHS_FULL, kickoffTh, logo } = require('./lib.cjs');

const VERSIONS = ['featured-v2', 'featured-ai-v1'];
const listVersion = (vs) => (vs.includes('featured-ai-v1') ? 'featured-ai-v1' : vs.includes('featured-v2') ? 'featured-v2' : null);
const FINISHED = ['FT', 'AET', 'PEN'];
// fan wording of a settled result (the site's badges say ถูก / ผิด / ถูกครึ่ง / ผิดครึ่ง / เสมอตัว)
const RESULT = { WIN: 'ทายถูก', LOSS: 'ทายผิด', HALF_WIN: 'ทายถูกครึ่ง', HALF_LOSS: 'ทายผิดครึ่ง', PUSH: 'เสมอตัว', VOID: 'โมฆะ', PENDING: 'รอผล' };
const BADGE = { WIN: 'result-win', LOSS: 'result-loss', HALF_WIN: 'result-half-win', HALF_LOSS: 'result-half-loss', PUSH: 'result-push' };

function yesterday() {
  const d = new Date(`${currentFootballDay()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** daySummary of /performance: a half result counts half, PUSH / VOID / pending stay out of the rate. */
function summary(ms) {
  const n = (s) => ms.filter((m) => m.status === s).length;
  const c = { total: ms.length, win: n('WIN'), loss: n('LOSS'), half_win: n('HALF_WIN'), half_loss: n('HALF_LOSS'), push: n('PUSH'), void: n('VOID'), pending: ms.filter((m) => !RESULT[m.status] || m.status === 'PENDING').length };
  const right = c.win + c.half_win / 2, wrong = c.loss + c.half_loss / 2;
  c.right = right; c.wrong = wrong;
  c.rate = right + wrong > 0 ? right / (right + wrong) : null;
  c.rate_pct = c.rate == null ? null : Math.round(c.rate * 100);
  return c;
}

(async () => {
  const date = process.argv.slice(2).find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || yesterday();
  const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await c.connect();
  const q = async (s, p) => (await c.query(s, p)).rows;
  const sel = await q(`select fixture_id, rank, version from featured_selections where football_date = $1 and version = any($2) and rank is not null`, [date, VERSIONS]);
  const version = listVersion(sel.map((r) => r.version));
  const rows = sel.filter((r) => r.version === version);
  if (!rows.length) { console.error(`no featured list for ${date}`); process.exit(2); }
  const out = [];
  for (const r of rows) {
    const [f] = await q(`select f.id, f.season, f.kickoff_at, f.status_short, f.goals_home, f.goals_away, l.id league_id, l.name league, l.logo_url llogo,
        h.id hid, h.name home, h.logo_url hlogo, a.id aid, a.name away, a.logo_url alogo,
        (select importance from league_importance li where li.league_id = l.id and li.season in (0, f.season) order by li.season desc limit 1) importance
      from fixtures f join leagues l on l.id = f.league_id join teams h on h.id = f.home_team_id join teams a on a.id = f.away_team_id where f.id = $1`, [r.fixture_id]);
    // the pick a fan saw last: the newest published round (the same row /performance settles)
    const [p] = await q(`select id, publish_round, kind, market, selection, line, odds_at_publish, reason, decision_rule_version, status, settled_at
      from analysis_predictions where fixture_id = $1 order by published_at desc, id desc limit 1`, [r.fixture_id]);
    if (!p || p.kind !== 'SIGNAL') { console.error(`fixture ${r.fixture_id}: latest round has no pick, left out (same as /performance)`); continue; }
    const first = (p.reason || '').split('\n')[0];
    const label = (first.match(/เข็มทิศเกม:\s*(.+?)\s*\(/) || [])[1] || `${p.selection} ${Number(p.line)}`;
    out.push({
      key: `m${r.rank}`, rank: r.rank, fixture_id: Number(f.id), prediction_id: Number(p.id), publish_round: p.publish_round, engine: p.decision_rule_version,
      league: f.league, league_importance: f.importance == null ? 30 : Number(f.importance), league_logo: await logo(f.llogo, `leagues-${f.league_id}.png`),
      kickoff_th: kickoffTh(f.kickoff_at), fixture_status: f.status_short, finished: FINISHED.includes(f.status_short),
      home: { name: f.home, logo: await logo(f.hlogo, `teams-${f.hid}.png`), goals: f.goals_home },
      away: { name: f.away, logo: await logo(f.alogo, `teams-${f.aid}.png`), goals: f.goals_away },
      pick: { market: p.market, side: String(p.selection).toLowerCase(), label, line: Number(p.line), odds: p.odds_at_publish == null ? null : Number(p.odds_at_publish).toFixed(2) },
      status: p.status, result: RESULT[p.status] || p.status, badge: BADGE[p.status] ? `brand/${BADGE[p.status]}.webp` : null,
    });
  }
  await c.end();
  out.sort((a, b) => b.league_importance - a.league_importance || a.rank - b.rank);
  // --drop=m1,m3: the owner leaves a pick out of the film; the summary is then counted on the picks that stay
  const drop = ((process.argv.find((x) => x.startsWith("--drop=")) || "").slice(7)).split(",").filter(Boolean);
  const dropped = out.filter((m) => drop.includes(m.key));
  for (const k of drop) if (!dropped.some((m) => m.key === k)) { console.error(`--drop: no match ${k}`); process.exit(2); }
  const kept = out.filter((m) => !drop.includes(m.key));
  const [, mo, d] = date.split('-').map(Number);
  const facts = { date, date_th: `วันที่ ${d} ${MONTHS_FULL[mo - 1]}`, date_short: `${d} ${MONTHS[mo - 1]}`, list_version: version, fetched_at: new Date().toISOString(), matches: kept, summary: summary(kept), ...(dropped.length ? { dropped: dropped.map((m) => ({ key: m.key, fixture_id: m.fixture_id, match: `${m.home.name} vs ${m.away.name}`, result: m.result })) } : {}) };
  writeJson(path.join(dayDir(date), 'recap', 'facts.json'), facts);
  console.log(`${date} (${version}) -> days/${date}/recap/facts.json`);
  for (const m of dropped) console.log(`dropped by the owner: [${m.key}] ${m.home.name} vs ${m.away.name} · ${m.result}`);
  for (const m of kept) console.log(`[${m.key}] ${m.league} · ${m.home.name} ${m.home.goals ?? '-'}-${m.away.goals ?? '-'} ${m.away.name} (${m.fixture_status}) · ${m.pick.label} @ ${m.pick.odds} · ${m.status} = ${m.result}`);
  const s = facts.summary;
  console.log(`summary: ${s.total} picks · ถูก ${s.win} · ผิด ${s.loss} · ถูกครึ่ง ${s.half_win} · ผิดครึ่ง ${s.half_loss} · เสมอตัว ${s.push} · โมฆะ ${s.void} · รอผล ${s.pending} · rate ${s.rate_pct ?? '-'}%`);
  if (s.pending || kept.some((m) => !m.finished)) console.error('WARNING: not every match is finished and settled yet; wait before making the film');
})().catch((e) => { console.error(e.message); process.exit(1); });

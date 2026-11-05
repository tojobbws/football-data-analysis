/**
 * Research, read-only (no DB writes): method 6 (the market price itself as the prediction) and
 * method 12 (a stack of market + Dixon-Coles + Elo + dc-impact + API-Football predictions), 1X2.
 *
 *   npx tsx scripts/research/market-stack-dryrun.ts [--day 2026-11-04] [--league 2] [--wf-from 2026-10-20]
 *
 * No look-ahead:
 *  - Every input is the last value stored BEFORE kickoff (odds_history.collected_at, probability_predictions.computed_at,
 *    api_predictions.collected_at). The "close" is therefore the last snapshot before kickoff, not the true close.
 *  - The stack for a football day (06:00 -> 06:00 Thai) is fit only on finished matches that kicked off before that day.
 *  - Outcome is the 90-minute score (ft_*, else goals_*).
 *
 * Stack: conditional logit, z_k = a_k + sum_s w_s * log p_{s,k}; free weights (not anchored to the market), tiny L2 for stability.
 */
import { parseArgs } from 'node:util';
import { brier3, logLoss3, pairedTest, type Probs3 } from '@fp/analysis';
import { createPgDb } from '@fp/database';
import { loadDotEnvFile, loadEnv } from '@fp/shared';

const { values } = parseArgs({
  options: {
    day: { type: 'string', default: '2026-11-04' },
    league: { type: 'string', default: '2' },
    'wf-from': { type: 'string', default: '2026-10-20' },
    from: { type: 'string', default: '2026-10-01' },
  },
});
const LEAGUE = Number(values.league);
const PIN = 4;
const SEL = ['HOME', 'DRAW', 'AWAY'] as const;
const SOURCES = ['PIN', 'DC', 'ELO', 'IMPACT', 'API'] as const;
type Src = (typeof SOURCES)[number];

loadDotEnvFile();
const db = createPgDb(loadEnv().DATABASE_URL);

/** football day D runs from D-1 23:00Z to D 23:00Z (06:00 Thai) */
const dayStart = (d: string) => new Date(new Date(`${d}T00:00:00Z`).getTime() - 3600_000);
const addDays = (d: string, n: number) => new Date(new Date(`${d}T00:00:00Z`).getTime() + n * 86400_000).toISOString().slice(0, 10);
const norm = (x: number[]): Probs3 => {
  const t = x.reduce((a, b) => a + b, 0);
  return x.map((v) => v / t) as unknown as Probs3;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

interface Row {
  id: number;
  league: number;
  kickoff: Date;
  label: string;
  score: string;
  outcome: 0 | 1 | 2;
  pin: Probs3;
  cons: Probs3;
  books: number;
  src: Record<Src, Probs3>;
}

async function load(): Promise<Row[]> {
  const to = dayStart(addDays(values.day!, 1));
  const fx = (
    await db.query<{ id: string; league_id: number; kickoff_at: Date; h: string; a: string; gh: number; ga: number }>(
      `select f.id, f.league_id, f.kickoff_at, th.name h, ta.name a, coalesce(f.ft_home, f.goals_home) gh, coalesce(f.ft_away, f.goals_away) ga
         from fixtures f join teams th on th.id=f.home_team_id join teams ta on ta.id=f.away_team_id
        where f.status_short in ('FT','AET','PEN') and f.kickoff_at >= $1 and f.kickoff_at < $2`,
      [values.from, to],
    )
  ).rows;
  const odds = (
    await db.query<{ fixture_id: string; bookmaker_id: number; selection: string; odds: string }>(
      `select distinct on (o.fixture_id, o.bookmaker_id, o.selection) o.fixture_id, o.bookmaker_id, o.selection, o.odds
         from odds_history o join fixtures f on f.id=o.fixture_id
        where o.market='MATCH_WINNER' and o.collected_at < f.kickoff_at and f.kickoff_at >= $1 and f.kickoff_at < $2
        order by o.fixture_id, o.bookmaker_id, o.selection, o.collected_at desc`,
      [values.from, to],
    )
  ).rows;
  const models = (
    await db.query<{ fixture_id: string; model_version_id: string; selection: string; probability: string }>(
      `select distinct on (p.fixture_id, p.model_version_id, p.selection) p.fixture_id, p.model_version_id, p.selection, p.probability
         from probability_predictions p join fixtures f on f.id=p.fixture_id
        where p.market='MATCH_WINNER' and p.model_version_id in ('dixon-coles-v0.2','elo-v0.1','dc-impact-v0.1')
          and p.computed_at < f.kickoff_at and f.kickoff_at >= $1 and f.kickoff_at < $2
        order by p.fixture_id, p.model_version_id, p.selection, p.computed_at desc`,
      [values.from, to],
    )
  ).rows;
  const api = (
    await db.query<{ fixture_id: string; percent_home: string; percent_draw: string; percent_away: string }>(
      `select distinct on (p.fixture_id) p.fixture_id, p.percent_home, p.percent_draw, p.percent_away
         from api_predictions p join fixtures f on f.id=p.fixture_id
        where p.collected_at < f.kickoff_at and f.kickoff_at >= $1 and f.kickoff_at < $2
        order by p.fixture_id, p.collected_at desc`,
      [values.from, to],
    )
  ).rows;

  const book = new Map<number, Map<number, Map<string, number>>>();
  for (const o of odds) {
    const f = book.get(Number(o.fixture_id)) ?? new Map();
    book.set(Number(o.fixture_id), f);
    const b = f.get(o.bookmaker_id) ?? new Map();
    f.set(o.bookmaker_id, b);
    b.set(o.selection, Number(o.odds));
  }
  const mdl = new Map<string, Map<string, number>>();
  for (const m of models) {
    const k = `${m.fixture_id}|${m.model_version_id}`;
    const x = mdl.get(k) ?? new Map();
    mdl.set(k, x);
    x.set(m.selection, Number(m.probability));
  }
  const apiBy = new Map(api.map((a) => [Number(a.fixture_id), a]));
  const devig = (q: Map<string, number> | undefined) => (q && SEL.every((s) => q.get(s)! > 1) ? norm(SEL.map((s) => 1 / q.get(s)!)) : null);
  const model = (id: number, v: string) => {
    const x = mdl.get(`${id}|${v}`);
    return x && SEL.every((s) => x.get(s)! > 0) ? norm(SEL.map((s) => x.get(s)!)) : null;
  };

  const rows: Row[] = [];
  for (const f of fx) {
    const id = Number(f.id);
    const books = book.get(id);
    const pin = devig(books?.get(PIN));
    const all = [...(books?.values() ?? [])].map(devig).filter((p): p is Probs3 => !!p);
    const dc = model(id, 'dixon-coles-v0.2');
    const elo = model(id, 'elo-v0.1');
    const a = apiBy.get(id);
    if (!pin || !dc || !elo || !a) continue;
    const floor = 0.03; // API-Football percentages come as 0/50/50 style; a 0 would be -Infinity in the log
    const apiP = norm([a.percent_home, a.percent_draw, a.percent_away].map((v) => Math.max(floor, Number(v) / 100)));
    const cons = norm(SEL.map((_, k) => mean(all.map((p) => p[k]!))));
    const outcome = f.gh > f.ga ? 0 : f.gh === f.ga ? 1 : 2;
    rows.push({
      id,
      league: f.league_id,
      kickoff: new Date(f.kickoff_at),
      label: `${f.h} v ${f.a}`,
      score: `${f.gh}-${f.ga}`,
      outcome,
      pin,
      cons,
      books: all.length,
      src: { PIN: pin, DC: dc, ELO: elo, IMPACT: model(id, 'dc-impact-v0.1') ?? dc, API: apiP },
    });
  }
  return rows.sort((x, y) => x.kickoff.getTime() - y.kickoff.getTime());
}

// ---- stack: conditional logit, params = [a_D, a_A, w_PIN, w_DC, w_ELO, w_IMPACT, w_API]
interface Stack {
  theta: number[];
  n: number;
}
function stackProbs(theta: number[], r: Row): Probs3 {
  const z = [0, theta[0]!, theta[1]!].map((a, k) => a + SOURCES.reduce((s, src, j) => s + theta[2 + j]! * Math.log(r.src[src][k]!), 0));
  const m = Math.max(...z);
  return norm(z.map((v) => Math.exp(v - m)));
}
function fitStack(train: Row[], l2 = 1e-3): Stack {
  const P = 2 + SOURCES.length;
  const theta = Array(P).fill(0);
  theta[2] = 1; // start at "market only"; weights are then free to move anywhere
  const grad = (th: number[]) => {
    const g = Array(P).fill(0);
    let loss = 0;
    for (const r of train) {
      const p = stackProbs(th, r);
      loss -= Math.log(p[r.outcome]!);
      for (let k = 0; k < 3; k++) {
        const e = p[k]! - (k === r.outcome ? 1 : 0);
        if (k > 0) g[k - 1] += e;
        SOURCES.forEach((src, j) => (g[2 + j] += e * Math.log(r.src[src][k]!)));
      }
    }
    const n = train.length;
    return { loss: loss / n + l2 * th.reduce((s, v) => s + v * v, 0), g: g.map((v, i) => v / n + 2 * l2 * th[i]!) };
  };
  // Adam
  const m = Array(P).fill(0);
  const v = Array(P).fill(0);
  const lr = 0.02;
  for (let t = 1; t <= 3000; t++) {
    const { g } = grad(theta);
    for (let i = 0; i < P; i++) {
      const gi = g[i]!;
      m[i] = 0.9 * m[i] + 0.1 * gi;
      v[i] = 0.999 * v[i] + 0.001 * gi * gi;
      theta[i] -= (lr * (m[i] / (1 - 0.9 ** t))) / (Math.sqrt(v[i] / (1 - 0.999 ** t)) + 1e-8);
    }
  }
  return { theta, n: train.length };
}

// ---- run
const rows = await load();
const fits = new Map<string, Stack>();
const stackFor = (day: string) => {
  if (!fits.has(day)) fits.set(day, fitStack(rows.filter((r) => r.kickoff < dayStart(day))));
  return fits.get(day)!;
};
const dayOf = (d: Date) => new Date(d.getTime() + 3600_000).toISOString().slice(0, 10);

type Cands = Record<string, (r: Row) => Probs3>;
const preds = (r: Row): Cands => {
  const st = stackFor(dayOf(r.kickoff));
  return {
    'ตลาด Pinnacle (6)': () => r.pin,
    'ตลาดเฉลี่ยทุกเจ้า (6)': () => r.cons,
    'Stack (12)': () => stackProbs(st.theta, r),
    'Dixon-Coles': () => r.src.DC,
    Elo: () => r.src.ELO,
    'dc-impact': () => r.src.IMPACT,
    'API-Football': () => r.src.API,
  };
};
const fmt = (p: Probs3) => p.map((v) => (v * 100).toFixed(0).padStart(2)).join('/');
const OUT = ['H', 'D', 'A'];

function report(title: string, set: Row[], detail: boolean) {
  console.log(`\n=== ${title} · n=${set.length} ===`);
  if (!set.length) return;
  if (detail) {
    console.table(
      set.map((r) => {
        const c = preds(r);
        return {
          match: r.label,
          score: `${r.score} (${OUT[r.outcome]})`,
          'PIN H/D/A %': fmt(c['ตลาด Pinnacle (6)']!(r)),
          'Cons %': fmt(c['ตลาดเฉลี่ยทุกเจ้า (6)']!(r)),
          'Stack %': fmt(c['Stack (12)']!(r)),
          'DC %': fmt(r.src.DC),
          books: r.books,
        };
      }),
    );
  }
  const names = Object.keys(preds(set[0]!));
  const ref = set.map((r) => logLoss3(r.pin, r.outcome));
  console.table(
    names.map((name) => {
      const p = set.map((r) => preds(r)[name]!(r));
      const ll = p.map((x, i) => logLoss3(x, set[i]!.outcome));
      const t = pairedTest(ll, ref);
      const hit = p.filter((x, i) => x.indexOf(Math.max(...x)) === set[i]!.outcome).length;
      return {
        model: name,
        logLoss: +mean(ll).toFixed(4),
        brier: +mean(p.map((x, i) => brier3(x, set[i]!.outcome))).toFixed(4),
        'ทายผลสูงสุดถูก': `${hit}/${set.length}`,
        'z vs PIN (+ = ดีกว่า)': name.startsWith('ตลาด Pinnacle') ? '—' : Number.isFinite(t.z) ? +t.z.toFixed(2) : '—',
      };
    }),
  );
}

const day = values.day!;
const st = stackFor(day);
console.log(`Stack for ${day}: trained on ${st.n} finished matches (all leagues, kickoff before ${dayStart(day).toISOString()})`);
console.log(
  '  intercepts D/A:',
  st.theta.slice(0, 2).map((v) => +v.toFixed(3)),
  ' weights:',
  Object.fromEntries(SOURCES.map((s, j) => [s, +st.theta[2 + j]!.toFixed(3)])),
);

const ucl = rows.filter((r) => r.league === LEAGUE);
report(`League ${LEAGUE} · football day ${day} (06:00→06:00 Thai)`, ucl.filter((r) => dayOf(r.kickoff) === day), true);
report(`League ${LEAGUE} · matchday ${addDays(day, -1)} + ${day}`, ucl.filter((r) => [day, addDays(day, -1)].includes(dayOf(r.kickoff))), false);
report(
  `ทุกลีก walk-forward · football days ${values['wf-from']} → ${day} (stack refit every day)`,
  rows.filter((r) => r.kickoff >= dayStart(values['wf-from']!)),
  false,
);
process.exit(0);

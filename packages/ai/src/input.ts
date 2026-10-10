/**
 * Structured input for the AI layer, built ONLY from the immutable publish snapshot
 * (what the system knew at publish time). The rules' own pick is deliberately left out
 * so the shadow ranking is an independent second opinion, not an echo.
 */
import { PICK_MARKETS, selectionLabel } from '@fp/analysis';

export interface SnapshotCandidate {
  market: string;
  selection: string;
  line: number | null;
  odds: number | null;
  model: number;
  market_p: number | null;
  edge: number | null;
  rank: number | null;
  reasons: string[];
}

export interface ShadowSource {
  fixture: { home: string; away: string; league: string; kickoffAt: Date; homeTeamId: number; awayTeamId: number };
  publishRound: string;
  snapshot: {
    form_snapshot: unknown;
    xg_snapshot: unknown;
    injury_snapshot: unknown;
    lineup_snapshot: unknown;
    api_prediction_snapshot: unknown;
    model_snapshot: unknown;
    candidates_snapshot: unknown;
  };
}

export interface ShadowCandidate {
  index: number;
  market: string;
  selection: string;
  line: number | null;
  label: string;
}

const r = (x: unknown, d = 4) => (typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x == null ? null : Number(x));

export function buildShadowInput(src: ShadowSource): { input: Record<string, unknown>; candidates: ShadowCandidate[] } {
  const { fixture: fx, snapshot: s } = src;
  const side = (teamId: unknown) => (Number(teamId) === fx.homeTeamId ? 'HOME' : Number(teamId) === fx.awayTeamId ? 'AWAY' : null);

  const raw = (Array.isArray(s.candidates_snapshot) ? s.candidates_snapshot : []) as SnapshotCandidate[];
  // the AI ranks only what the Game Compass may pick; `index` stays the position in the snapshot
  const pickable = raw.flatMap((c, index) => ((PICK_MARKETS as readonly string[]).includes(c.market) ? [{ c, index }] : []));
  const candidates: ShadowCandidate[] = pickable.map(({ c, index }) => ({
    index,
    market: c.market,
    selection: c.selection,
    line: c.line == null ? null : Number(c.line),
    label: selectionLabel(c.market, c.selection, c.line == null ? null : Number(c.line), fx.home, fx.away),
  }));

  const form = (s.form_snapshot ?? {}) as { home?: FormRow[]; away?: FormRow[] };
  const injuries = (Array.isArray(s.injury_snapshot) ? s.injury_snapshot : []) as Array<Record<string, unknown>>;
  const lineup = (Array.isArray(s.lineup_snapshot) ? s.lineup_snapshot : []) as Array<Record<string, unknown>>;
  const model = (s.model_snapshot ?? {}) as { modelSource?: string; prices?: Array<Record<string, unknown>>; impact?: Record<string, unknown> | null };
  const api = (s.api_prediction_snapshot ?? null) as Record<string, unknown> | null;

  const input = {
    fixture: {
      home: fx.home,
      away: fx.away,
      league: fx.league,
      kickoff_utc: fx.kickoffAt.toISOString(),
      publish_round: src.publishRound,
    },
    form_last5: { home: (form.home ?? []).map(formRow), away: (form.away ?? []).map(formRow) },
    xg_last5_avg: s.xg_snapshot ?? null,
    injuries: injuries.map((i) => ({ team: side(i.team_id), player: i.player_name ?? null, type: i.type ?? null, reason: i.reason ?? null })),
    confirmed_lineup: lineup.length
      ? {
          home: lineup.filter((p) => side(p.team_id) === 'HOME' && p.is_starter).map((p) => p.player_name),
          away: lineup.filter((p) => side(p.team_id) === 'AWAY' && p.is_starter).map((p) => p.player_name),
        }
      : null,
    player_impact: model.impact
      ? {
          used_in_prices: model.modelSource === 'DC+IMPACT',
          home: impactSide(model.impact.home),
          away: impactSide(model.impact.away),
        }
      : null,
    api_prediction: api
      ? { home_pct: api.percent_home ?? null, draw_pct: api.percent_draw ?? null, away_pct: api.percent_away ?? null, advice: api.advice ?? null, under_over: api.under_over ?? null }
      : null,
    model_1x2: (model.prices ?? [])
      .filter((p) => p.market === 'MATCH_WINNER' && String(p.model ?? '').startsWith('dixon-coles'))
      .map((p) => ({ selection: p.selection, probability: r(p.p) })),
    candidates: pickable.map(({ c, index }, i) => ({
      index,
      label: candidates[i]!.label,
      market: c.market,
      selection: c.selection,
      line: c.line == null ? null : Number(c.line),
      odds: r(c.odds, 3),
      model_probability: r(c.model),
      market_probability_no_vig: r(c.market_p),
      edge: r(c.edge),
      rule_rejections: c.reasons ?? [],
    })),
  };
  return { input, candidates };
}

interface FormRow {
  venue?: string;
  result?: string;
  goalsFor?: number;
  goalsAgainst?: number;
  xgFor?: number | null;
  xgAgainst?: number | null;
}

function formRow(f: FormRow) {
  return { venue: f.venue ?? null, result: f.result ?? null, goals_for: f.goalsFor ?? null, goals_against: f.goalsAgainst ?? null, xg_for: r(f.xgFor, 2), xg_against: r(f.xgAgainst, 2) };
}

function impactSide(x: unknown) {
  const s = (x ?? {}) as { attackLoss?: number; defenceLoss?: number; missing?: Array<{ name: string | null }> };
  return { attack_loss: r(s.attackLoss, 3), defence_loss: r(s.defenceLoss, 3), missing: (s.missing ?? []).map((m) => m.name).filter(Boolean) };
}

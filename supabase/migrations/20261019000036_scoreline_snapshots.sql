-- =====================================================================
-- 0036 scoreline snapshots (ADR 0007)
--
-- One row per model run per match: the scoreline matrix (0..10 goals per team, the size the pricing uses) the
-- Dixon-Coles model priced from, so 1X2 / handicap / over-under / expected goals can be
-- re-derived later and every analysable match is measured, not only the picked ones.
-- The sides model (1X2, handicap) and the totals model (over/under) are tuned separately,
-- so each keeps its own matrix.
-- source: 'live' = computed before the match; 'backtest' = computed afterwards from earlier
-- data only. Results lead with live and never merge the two.
-- Append-only by convention (no hash chain, no trigger: ADR 0007).
-- =====================================================================

create table if not exists scoreline_snapshots (
  fixture_id        bigint       not null references fixtures(id),
  model_version_id  text         not null references model_versions(id),
  computed_at       timestamptz  not null,
  source            text         not null default 'live' check (source in ('live', 'backtest')),
  max_goals         int          not null default 10,
  sides_lambda      numeric(7,4) not null,
  sides_mu          numeric(7,4) not null,
  sides_rho         numeric(6,4) not null,
  sides_matrix      jsonb        not null,
  totals_lambda     numeric(7,4) not null,
  totals_mu         numeric(7,4) not null,
  totals_matrix     jsonb        not null,
  primary key (fixture_id, model_version_id, computed_at, source)
);
create index if not exists scoreline_snapshots_fixture_idx on scoreline_snapshots (fixture_id, computed_at desc);

alter table scoreline_snapshots enable row level security;

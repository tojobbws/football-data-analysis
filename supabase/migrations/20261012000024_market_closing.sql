-- =====================================================================
-- 0024 market_closing: the market's view at kickoff, kept for good
-- (see docs/adr/0002-data-retention.md)
--
-- Odds snapshots are deleted 7 days after a settled match, so nothing was left
-- to compare the model with the market over time. Per match this keeps the
-- 1X2 and the main Asian handicap and over/under line (the line whose sides are
-- closest to 50/50): median closing odds and no-vig probability of each side,
-- next to the model probability the last pre-kickoff candidates run used for
-- that side (analysis_run_id; null when the match had no run or no such line).
-- One row per side, written once (~7 rows per match).
-- =====================================================================

create table if not exists market_closing (
  fixture_id          bigint       not null references fixtures(id) on delete cascade,
  market              text         not null check (market in ('MATCH_WINNER','ASIAN_HANDICAP','OVER_UNDER')),
  selection           text         not null,
  line                numeric(5,2),
  bookmakers          int          not null,
  median_odds         numeric(8,3) not null,
  market_probability  numeric(6,5) not null,
  analysis_run_id     uuid,
  model_probability   numeric(6,5),
  closing_at          timestamptz  not null,
  recorded_at         timestamptz  not null default now(),
  primary key (fixture_id, market, selection)
);

alter table market_closing enable row level security;

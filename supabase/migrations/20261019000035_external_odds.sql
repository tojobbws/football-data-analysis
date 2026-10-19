-- =====================================================================
-- 0035 external_odds: historical odds imported from outside the API
--
-- API-Football only serves ~7 days of odds, so odds_history starts in 2026-10.
-- This keeps odds from football-data.co.uk CSV files (matched to fixtures by
-- team and date) apart from the odds we collected ourselves, so a backtest can
-- read years of closing prices without mixing the two sources.
-- One row per price. phase: 'early' = the file's first quote (days before
-- kickoff), 'close' = the closing quote. bookmaker: PIN (Pinnacle), B365,
-- AVG (market average), MAX (best price). Lines follow odds_history: the AH
-- line is the handicap of the selection's own side (AWAY = -home handicap).
-- =====================================================================

create table if not exists external_odds (
  fixture_id  bigint       not null references fixtures(id) on delete cascade,
  source      text         not null,
  bookmaker   text         not null,
  phase       text         not null check (phase in ('early','close')),
  market      text         not null check (market in ('MATCH_WINNER','ASIAN_HANDICAP','OVER_UNDER')),
  selection   text         not null,
  line        numeric(5,2),
  odds        numeric(8,3) not null,
  imported_at timestamptz  not null default now(),
  primary key (fixture_id, source, bookmaker, phase, market, selection)
);

alter table external_odds enable row level security;

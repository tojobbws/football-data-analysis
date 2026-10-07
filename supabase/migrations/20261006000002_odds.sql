-- =====================================================================
-- 0002 ODDS HISTORY (append-only)
-- We store every bookmaker update ourselves from day one.
-- Dedup key uses the API's own `update` timestamp, so polling the same
-- unchanged odds twice never creates duplicates.
-- =====================================================================

create table if not exists bookmakers (
  id         int primary key,
  name       text not null,
  synced_at  timestamptz not null default now()
);

create table if not exists odds_history (
  id                 bigint generated always as identity primary key,
  fixture_id         bigint not null references fixtures(id),
  bookmaker_id       int    not null references bookmakers(id),
  market             text   not null check (market in ('MATCH_WINNER','ASIAN_HANDICAP','OVER_UNDER','OTHER')),
  api_bet_id         int    not null,
  api_bet_name       text   not null,
  selection          text   not null,           -- HOME / DRAW / AWAY / OVER / UNDER
  line               numeric(5,2),              -- AH: line of THIS selection (Home -0.75). OU: total (2.5). 1X2: null
  home_line          numeric(5,2),              -- AH normalised to home perspective (Away +0.75 -> -0.75)
  raw_value          text   not null,           -- original API string, e.g. "Home -0.75"
  odds               numeric(8,3) not null check (odds >= 1),
  source_updated_at  timestamptz not null,      -- API `update` field
  collected_at       timestamptz not null default now(),
  raw_response_id    bigint references api_raw_responses(id) on delete set null,
  unique nulls not distinct (fixture_id, bookmaker_id, api_bet_id, raw_value, source_updated_at)
);
create index if not exists odds_history_fixture_idx on odds_history (fixture_id, market, source_updated_at);

drop trigger if exists odds_history_immutable on odds_history;
create trigger odds_history_immutable
  before update or delete on odds_history
  for each row execute function fp_append_only();

-- Opening / current / closing per (fixture, bookmaker, bet, selection-line)
create or replace view odds_movement as
with ranked as (
  select
    o.*,
    row_number() over w_asc  as rn_asc,
    row_number() over w_desc as rn_desc,
    count(*)     over w_all  as n_snapshots
  from odds_history o
  window
    w_all  as (partition by fixture_id, bookmaker_id, api_bet_id, raw_value),
    w_asc  as (partition by fixture_id, bookmaker_id, api_bet_id, raw_value order by source_updated_at asc),
    w_desc as (partition by fixture_id, bookmaker_id, api_bet_id, raw_value order by source_updated_at desc)
)
select
  o.fixture_id, o.bookmaker_id, o.market, o.api_bet_id, o.selection, o.line, o.home_line, o.raw_value,
  o.odds               as opening_odds,
  o.source_updated_at  as opening_at,
  c.odds               as current_odds,
  c.source_updated_at  as current_at,
  (c.odds - o.odds)    as odds_change,
  o.n_snapshots
from ranked o
join ranked c
  on  c.fixture_id = o.fixture_id and c.bookmaker_id = o.bookmaker_id
  and c.api_bet_id = o.api_bet_id and c.raw_value = o.raw_value
  and c.rn_desc = 1
where o.rn_asc = 1;

-- Closing odds = last update strictly before kickoff (used later for CLV)
create or replace view odds_closing as
select distinct on (o.fixture_id, o.bookmaker_id, o.api_bet_id, o.raw_value)
  o.fixture_id, o.bookmaker_id, o.market, o.api_bet_id, o.selection, o.line, o.home_line, o.raw_value,
  o.odds as closing_odds, o.source_updated_at as closing_at
from odds_history o
join fixtures f on f.id = o.fixture_id
where o.source_updated_at < f.kickoff_at
order by o.fixture_id, o.bookmaker_id, o.api_bet_id, o.raw_value, o.source_updated_at desc;

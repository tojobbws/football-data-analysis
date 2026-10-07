-- =====================================================================
-- 0001 CORE FOOTBALL DATA
-- Every important row keeps: source, raw (JSON from API), synced_at.
-- IDs of leagues/teams/fixtures/players = API-Football ids.
-- =====================================================================

-- ---------- Generic helpers ----------
create or replace function fp_reject_change() returns trigger
language plpgsql as $$
begin
  raise exception '% on table % is not allowed (append-only / immutable)', tg_op, tg_table_name
    using errcode = 'P0001';
end $$;

-- Append-only, except: when an old raw audit row is pruned, the FK
-- (on delete set null) may unlink raw_response_id. Nothing else may change.
create or replace function fp_append_only() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and old.raw_response_id is not null and new.raw_response_id is null
     and (to_jsonb(new) - 'raw_response_id') = (to_jsonb(old) - 'raw_response_id') then
    return new;
  end if;
  raise exception '% on table % is not allowed (append-only)', tg_op, tg_table_name
    using errcode = 'P0001';
end $$;

-- ---------- Raw API audit log ----------
create table if not exists api_raw_responses (
  id            bigint generated always as identity primary key,
  source        text        not null default 'api-football',
  endpoint      text        not null,
  params        jsonb       not null default '{}'::jsonb,
  http_status   int         not null,
  results       int,
  errors        jsonb,
  response      jsonb       not null,
  fetched_at    timestamptz not null default now()
);
create index if not exists api_raw_responses_endpoint_idx on api_raw_responses (endpoint, fetched_at desc);

create table if not exists sync_runs (
  id              bigint generated always as identity primary key,
  job             text        not null,
  params          jsonb       not null default '{}'::jsonb,
  status          text        not null default 'RUNNING' check (status in ('RUNNING','SUCCESS','FAILED')),
  requests_used   int         not null default 0,
  items_written   int         not null default 0,
  error           text,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index if not exists sync_runs_job_idx on sync_runs (job, started_at desc);

-- ---------- Leagues ----------
create table if not exists leagues (
  id            int primary key,
  name          text not null,
  type          text,
  country       text,
  country_code  text,
  logo_url      text,
  flag_url      text,
  slug          text unique,
  is_tracked    boolean not null default false,
  source        text not null default 'api-football',
  raw           jsonb,
  synced_at     timestamptz not null default now()
);

create table if not exists league_seasons (
  league_id   int  not null references leagues(id),
  season      int  not null,
  start_date  date,
  end_date    date,
  is_current  boolean not null default false,
  coverage    jsonb,
  synced_at   timestamptz not null default now(),
  primary key (league_id, season)
);

-- ---------- Venues / Teams ----------
create table if not exists venues (
  id          int primary key,
  name        text,
  address     text,
  city        text,
  capacity    int,
  surface     text,
  image_url   text,
  source      text not null default 'api-football',
  raw         jsonb,
  synced_at   timestamptz not null default now()
);

create table if not exists teams (
  id          int primary key,
  name        text not null,
  code        text,
  country     text,
  founded     int,
  is_national boolean,
  logo_url    text,
  venue_id    int references venues(id),
  slug        text unique,
  source      text not null default 'api-football',
  raw         jsonb,
  synced_at   timestamptz not null default now()
);

create table if not exists team_seasons (
  team_id    int not null references teams(id),
  league_id  int not null references leagues(id),
  season     int not null,
  primary key (team_id, league_id, season)
);

-- ---------- Players ----------
create table if not exists players (
  id           int primary key,
  name         text not null,
  firstname    text,
  lastname     text,
  birth_date   date,
  nationality  text,
  height       text,
  weight       text,
  photo_url    text,
  source       text not null default 'api-football',
  raw          jsonb,
  synced_at    timestamptz not null default now()
);

create table if not exists player_season_stats (
  player_id      int not null references players(id),
  team_id        int not null,
  league_id      int not null,
  season         int not null,
  position       text,
  appearances    int,
  lineups        int,
  minutes        int,
  rating         numeric(5,3),
  goals          int,
  assists        int,
  shots_total    int,
  shots_on       int,
  passes_key     int,
  tackles_total  int,
  interceptions  int,
  cards_yellow   int,
  cards_red      int,
  raw            jsonb,
  synced_at      timestamptz not null default now(),
  primary key (player_id, team_id, league_id, season)
);

-- ---------- Fixtures ----------
create table if not exists fixtures (
  id                 bigint primary key,
  league_id          int  not null references leagues(id),
  season             int  not null,
  round              text,
  kickoff_at         timestamptz not null,
  timezone           text,
  venue_id           int references venues(id),
  referee            text,
  home_team_id       int  not null references teams(id),
  away_team_id       int  not null references teams(id),
  status_short       text not null,
  status_long        text,
  elapsed            int,
  goals_home         int,
  goals_away         int,
  ht_home            int,
  ht_away            int,
  ft_home            int,
  ft_away            int,
  et_home            int,
  et_away            int,
  pen_home           int,
  pen_away           int,
  slug               text unique,
  details_synced_at  timestamptz,
  source             text not null default 'api-football',
  raw                jsonb,
  synced_at          timestamptz not null default now()
);
create index if not exists fixtures_kickoff_idx on fixtures (kickoff_at);
create index if not exists fixtures_league_season_idx on fixtures (league_id, season);
create index if not exists fixtures_status_idx on fixtures (status_short);
create index if not exists fixtures_teams_idx on fixtures (home_team_id, away_team_id);

create table if not exists fixture_events (
  id            bigint generated always as identity primary key,
  fixture_id    bigint not null references fixtures(id) on delete cascade,
  seq           int    not null,
  elapsed       int,
  extra         int,
  team_id       int,
  player_id     int,
  player_name   text,
  assist_id     int,
  assist_name   text,
  type          text,
  detail        text,
  comments      text,
  synced_at     timestamptz not null default now(),
  unique (fixture_id, seq)
);

-- Long format: one row per (fixture, team, stat type). Includes 'expected_goals' when available.
create table if not exists fixture_statistics (
  fixture_id  bigint not null references fixtures(id) on delete cascade,
  team_id     int    not null,
  type        text   not null,
  value_num   numeric,
  value_text  text,
  synced_at   timestamptz not null default now(),
  primary key (fixture_id, team_id, type)
);

create table if not exists fixture_lineups (
  fixture_id   bigint not null references fixtures(id) on delete cascade,
  team_id      int    not null,
  formation    text,
  coach_id     int,
  coach_name   text,
  raw          jsonb,
  synced_at    timestamptz not null default now(),
  primary key (fixture_id, team_id)
);

create table if not exists fixture_lineup_players (
  id           bigint generated always as identity primary key,
  fixture_id   bigint not null references fixtures(id) on delete cascade,
  team_id      int    not null,
  player_id    int,
  player_name  text,
  number       int,
  position     text,
  grid         text,
  is_starter   boolean not null
);
create index if not exists fixture_lineup_players_fixture_idx on fixture_lineup_players (fixture_id, team_id);

create table if not exists fixture_player_stats (
  fixture_id     bigint not null references fixtures(id) on delete cascade,
  team_id        int    not null,
  player_id      int    not null,
  minutes        int,
  position       text,
  rating         numeric(5,3),
  is_substitute  boolean,
  goals          int,
  assists        int,
  shots_total    int,
  shots_on       int,
  passes_total   int,
  passes_key     int,
  tackles        int,
  interceptions  int,
  cards_yellow   int,
  cards_red      int,
  raw            jsonb,
  synced_at      timestamptz not null default now(),
  primary key (fixture_id, player_id)
);

-- ---------- Injuries ----------
create table if not exists injuries (
  id            bigint generated always as identity primary key,
  fixture_id    bigint,
  league_id     int,
  season        int,
  team_id       int,
  player_id     int,
  player_name   text,
  type          text,
  reason        text,
  fixture_date  timestamptz,
  source        text not null default 'api-football',
  raw           jsonb,
  first_seen_at timestamptz not null default now(),
  synced_at     timestamptz not null default now(),
  unique nulls not distinct (fixture_id, player_id)
);
create index if not exists injuries_team_idx on injuries (team_id, fixture_date desc);

-- ---------- Standings ----------
create table if not exists standings (
  league_id          int  not null,
  season             int  not null,
  group_name         text not null default '',
  team_id            int  not null,
  rank               int,
  points             int,
  goals_diff         int,
  form               text,
  status             text,
  description        text,
  played             int,
  win                int,
  draw               int,
  lose               int,
  goals_for          int,
  goals_against      int,
  home               jsonb,
  away               jsonb,
  source_updated_at  timestamptz,
  synced_at          timestamptz not null default now(),
  primary key (league_id, season, group_name, team_id)
);

-- ---------- Transfers (placeholder for later phases) ----------
create table if not exists transfers (
  id            bigint generated always as identity primary key,
  player_id     int not null,
  transfer_date date,
  type          text,
  team_in_id    int,
  team_out_id   int,
  raw           jsonb,
  synced_at     timestamptz not null default now(),
  unique nulls not distinct (player_id, transfer_date, team_in_id, team_out_id)
);

-- ---------- H2H ----------
-- H2H is derived from `fixtures` (no duplicated storage).
create or replace view h2h_fixtures as
select
  least(home_team_id, away_team_id)    as team_a_id,
  greatest(home_team_id, away_team_id) as team_b_id,
  f.*
from fixtures f
where status_short in ('FT','AET','PEN');

-- ---------- API Predictions (append-only snapshots) ----------
-- API prediction is ONE input, never the final answer.
create table if not exists api_predictions (
  id               bigint generated always as identity primary key,
  fixture_id       bigint not null references fixtures(id),
  collected_at     timestamptz not null default now(),
  winner_team_id   int,
  winner_comment   text,
  win_or_draw      boolean,
  under_over       text,
  goals_home       text,
  goals_away       text,
  advice           text,
  percent_home     numeric(5,2),
  percent_draw     numeric(5,2),
  percent_away     numeric(5,2),
  comparison       jsonb,
  raw              jsonb not null,
  raw_response_id  bigint references api_raw_responses(id) on delete set null
);
create index if not exists api_predictions_fixture_idx on api_predictions (fixture_id, collected_at desc);

drop trigger if exists api_predictions_immutable on api_predictions;
create trigger api_predictions_immutable
  before update or delete on api_predictions
  for each row execute function fp_append_only();

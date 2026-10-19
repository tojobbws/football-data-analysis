-- =====================================================================
-- 0040 cup rules and qualification snapshots (slice 04)
--
-- competition_rules: how a competition decides a tie, per stage and from which season (the latest row not
--   after the match's season applies). A competition with no rows here gets no qualification probability.
--   legs = 1 means a single match (league phase, final), not a tie. Away goals were dropped by UEFA from 2021-22;
--   a rule that still asks for them is not modelled and yields no probability.
-- qualification_snapshots: the model's chance that each side goes through a two-legged tie, one row per
--   forecast, appended (never rewritten) and tagged live/backtest like scoreline_snapshots (ADR 0007).
--   fixture_id is the next leg that was still to be played when the forecast was made.
-- web_qualification: the last forecast made before that leg kicked off, for the match page. Not a pick.
--
-- Seeded for the UEFA club competitions the site tracks (2 Champions League, 3 Europa League, 848 Conference
-- League) from season 2021; other cups are added by inserting rows once the provider tracks them.
-- =====================================================================

create table if not exists competition_rules (
  league_id     bigint   not null references leagues(id) on delete cascade,
  from_season   int      not null,
  stage         text     not null,
  legs          smallint not null check (legs in (1, 2)),
  away_goals    boolean  not null default false,
  extra_time    boolean  not null default true,
  penalties     boolean  not null default true,
  neutral_venue boolean  not null default false,
  note          text,
  primary key (league_id, from_season, stage)
);

create table if not exists qualification_snapshots (
  fixture_id        bigint       not null references fixtures(id),
  model_version_id  text         not null,
  computed_at       timestamptz  not null,
  source            text         not null default 'live' check (source in ('live', 'backtest')),
  tie_key           text         not null,
  stage             text         not null,
  leg               smallint     not null check (leg in (1, 2)),
  team_a_id         bigint       not null references teams(id),
  team_b_id         bigint       not null references teams(id),
  agg_a             smallint     not null default 0,
  agg_b             smallint     not null default 0,
  p_a               numeric(6,5) not null check (p_a between 0 and 1),
  p_b               numeric(6,5) not null check (p_b between 0 and 1),
  p_extra_time      numeric(6,5) not null,
  p_penalties       numeric(6,5) not null,
  assumptions       jsonb        not null default '[]'::jsonb,
  primary key (fixture_id, model_version_id, computed_at, source)
);
create index if not exists qualification_snapshots_tie_idx on qualification_snapshots (tie_key, computed_at desc);

alter table competition_rules enable row level security;
alter table qualification_snapshots enable row level security;
drop policy if exists competition_rules_read on competition_rules;
create policy competition_rules_read on competition_rules for select to anon, authenticated using (true);
drop policy if exists competition_rules_admin_write on competition_rules;
create policy competition_rules_admin_write on competition_rules for all to authenticated using (fp_is_admin()) with check (fp_is_admin());
grant select on competition_rules to anon, authenticated;
grant insert, update, delete on competition_rules to authenticated;

insert into competition_rules (league_id, from_season, stage, legs, neutral_venue, note)
select l.id, 2021, v.stage, v.legs, v.neutral, v.note
from (values
  ('PRELIMINARY', 1, false, 'Champions League preliminary round: single matches'),
  ('QUALIFYING_1', 2, false, null), ('QUALIFYING_2', 2, false, null), ('QUALIFYING_3', 2, false, null),
  ('PLAYOFF', 2, false, 'qualifying play-offs'),
  ('LEAGUE_PHASE', 1, false, 'league phase: single matches, not a tie'),
  ('KNOCKOUT_PLAYOFF', 2, false, null), ('ROUND_OF_32', 2, false, null), ('ROUND_OF_16', 2, false, null),
  ('QUARTER_FINAL', 2, false, null), ('SEMI_FINAL', 2, false, null),
  ('FINAL', 1, true, 'single match at a neutral venue')
) as v(stage, legs, neutral, note)
join leagues l on l.id in (2, 3, 848)
on conflict do nothing;

-- Last forecast made before the leg kicked off, with whether the league's side model passed its test
-- (the page shows it only then, like the model outlook).
create or replace view web_qualification as
with last_pre as (
  select q.*, row_number() over (partition by q.fixture_id order by q.computed_at desc) as rn
    from qualification_snapshots q
    join fixtures f on f.id = q.fixture_id
   where q.computed_at < f.kickoff_at and q.source = 'live'
),
cfg as (
  select distinct on (league_id, purpose) league_id, purpose, enabled from model_configs order by league_id, purpose, tuned_at desc
)
select l.fixture_id, l.leg, l.stage, l.team_a_id, l.team_b_id, l.agg_a, l.agg_b, l.p_a, l.p_b,
       l.p_extra_time, l.p_penalties, l.assumptions, l.computed_at,
       coalesce(c.enabled, false) as sides_tested
  from last_pre l
  join fixtures f on f.id = l.fixture_id
  left join cfg c on c.league_id = f.league_id and c.purpose = 'SIDES'
 where l.rn = 1;

revoke all on qualification_snapshots from anon, authenticated;
revoke all on web_qualification from anon, authenticated;
grant select on web_qualification to anon, authenticated;

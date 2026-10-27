-- =====================================================================
-- 0047 Hybrid AI decisions (docs/adr/0010-hybrid-ai-picks.md)
--
-- The Hybrid AI engine reads verified pre-match data (recent form, rest, injuries, lineups) and the
-- market's main AH and O/U lines, and chooses one of: AH favourite, AH underdog, Over, Under, or no pick.
-- Every decision is stored here before kickoff, exactly as the AI saw and answered it, whatever the
-- engine mode: in `shadow` mode nothing here is published, in `hybrid` mode the publish job publishes
-- the round's valid decision to analysis_predictions with decision_rule_version = its engine version.
--  * insert only before kickoff (DB clock); rows are append-only
--  * the legacy rules' decision of the same moment is kept beside it for comparison
--
-- analysis_predictions: a Hybrid AI pick has no model probability (the AI gives evidence, not a
-- calibrated probability), so the SIGNAL check accepts a null model_probability for hybrid engines only.
-- Published rows are untouched.
-- =====================================================================

create table if not exists hybrid_decisions (
  id                  bigint generated always as identity primary key,
  fixture_id          bigint      not null references fixtures(id),
  publish_round       text        not null check (publish_round in ('EARLY','PREMATCH','LINEUP')),
  engine_mode         text        not null check (engine_mode in ('shadow','hybrid')),
  engine_version      text        not null,
  prompt_version      text        not null,
  model               text,                          -- model that answered (null when the AI was not reached)
  decided_at          timestamptz not null default now(),
  kickoff_at          timestamptz not null,          -- copied from the fixture by trigger
  input               jsonb       not null,          -- exactly what the AI saw
  input_hash          text        not null,          -- sha256 of input: the input data snapshot id
  output              jsonb,                         -- raw structured answer of the last attempt
  status              text        not null check (status in ('OK','INVALID','REFUSED','ERROR')),
  attempts            int         not null default 1,
  violations          jsonb       not null default '[]',
  -- the validated decision (status OK only)
  market              text check (market in ('ASIAN_HANDICAP','OVER_UNDER')),
  side                text check (side in ('FAVORITE','UNDERDOG','OVER','UNDER','NO_PICK')),
  selection           text,
  line                numeric(5,2),
  odds                numeric(8,3),                  -- median price of the chosen side in the snapshot
  market_probability  numeric(6,5),                  -- de-margined consensus of the chosen side
  confidence          text check (confidence in ('HIGH','MEDIUM','LOW')),
  summary_th          text,
  legacy              jsonb,                         -- the legacy rules' latest decision at that moment
  usage               jsonb,
  check (status <> 'OK' or side is not null),
  check (side is null or side = 'NO_PICK' or (market is not null and selection is not null and line is not null))
);
create index if not exists hybrid_decisions_fixture_idx on hybrid_decisions (fixture_id, publish_round, engine_version, decided_at desc);

create or replace function fp_hybrid_decision_before_insert() returns trigger
language plpgsql as $$
declare
  v_kickoff timestamptz;
begin
  select kickoff_at into v_kickoff from fixtures where id = new.fixture_id;
  if v_kickoff is null or v_kickoff <= now() then
    raise exception 'hybrid decision must be stored before kickoff' using errcode = 'P0001';
  end if;
  new.kickoff_at := v_kickoff;
  new.decided_at := now();
  return new;
end $$;

drop trigger if exists hybrid_decisions_before_insert on hybrid_decisions;
create trigger hybrid_decisions_before_insert
  before insert on hybrid_decisions
  for each row execute function fp_hybrid_decision_before_insert();

drop trigger if exists hybrid_decisions_append_only on hybrid_decisions;
create trigger hybrid_decisions_append_only
  before update or delete on hybrid_decisions
  for each row execute function fp_append_only();

-- internal: the site reads published picks, never this table
alter table hybrid_decisions enable row level security;

alter table analysis_predictions drop constraint if exists analysis_predictions_check;
alter table analysis_predictions add constraint analysis_predictions_check
  check (kind = 'NO_CLEAR_SIGNAL'
         or (market is not null and selection is not null
             and (model_probability is not null or decision_rule_version like 'hybrid-%')));

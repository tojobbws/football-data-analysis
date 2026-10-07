-- =====================================================================
-- 0011 AI SHADOW RANKING (Phase 6b)
-- The rules pick 🧭. The AI ranks the same candidates in parallel and its
-- answer is recorded here BEFORE kickoff, never published as the pick.
-- After enough matches, rules vs AI can be compared on identical fixtures.
--  * insert only before kickoff (DB clock)
--  * content immutable; the AI pick's settlement is write-once
-- =====================================================================

create table if not exists ai_shadow_rankings (
  id                      bigint generated always as identity primary key,
  analysis_prediction_id  bigint not null unique references analysis_predictions(id),
  fixture_id              bigint not null references fixtures(id),
  kickoff_at              timestamptz not null,          -- copied from the prediction by trigger
  model                   text   not null,               -- model that actually answered
  prompt_version          text   not null,
  status                  text   not null check (status in ('OK','INVALID','REFUSED')),
  input                   jsonb  not null,               -- exactly what the AI saw
  output                  jsonb,                         -- raw structured answer
  ranking                 jsonb,                         -- validated: [{market, selection, line, support, reason_th}]
  no_clear_signal         boolean,
  pick_market             text,
  pick_selection          text,
  pick_line               numeric(5,2),
  pick_odds               numeric(8,3),
  agrees_with_rules       boolean,                       -- AI top == rules pick (or both 🌫️)
  explanation_th          text,
  guard_violations        jsonb  not null default '[]',  -- invented numbers / banned words / bad indices
  usage                   jsonb,
  created_at              timestamptz not null default now(),

  -- settlement of the AI pick (write-once, same rules as the published record)
  ai_status               text check (ai_status in ('WIN','HALF_WIN','LOSS','HALF_LOSS','PUSH','VOID')),
  ai_result_score         text,
  ai_settled_at           timestamptz,
  ai_closing_odds         numeric(8,3),
  ai_clv                  numeric(8,5)
);
create index if not exists ai_shadow_rankings_fixture_idx on ai_shadow_rankings (fixture_id);
create index if not exists ai_shadow_rankings_unsettled_idx on ai_shadow_rankings (kickoff_at) where ai_status is null and pick_market is not null;

create or replace function fp_ai_shadow_before_insert() returns trigger
language plpgsql as $$
declare
  v_kickoff timestamptz;
  v_fixture bigint;
begin
  select kickoff_at, fixture_id into v_kickoff, v_fixture from analysis_predictions where id = new.analysis_prediction_id;
  if v_kickoff is null or v_kickoff <= now() then
    raise exception 'AI shadow ranking must be stored before kickoff' using errcode = 'P0001';
  end if;
  new.kickoff_at := v_kickoff;
  new.fixture_id := v_fixture;
  new.created_at := now();
  new.ai_status := null;
  new.ai_result_score := null;
  new.ai_settled_at := null;
  new.ai_closing_odds := null;
  new.ai_clv := null;
  return new;
end $$;

create or replace function fp_ai_shadow_before_update() returns trigger
language plpgsql as $$
declare
  v_fixture_status text;
begin
  -- everything except the ai_* settlement fields is frozen
  if (to_jsonb(new) - array['ai_status','ai_result_score','ai_settled_at','ai_closing_odds','ai_clv'])
     is distinct from (to_jsonb(old) - array['ai_status','ai_result_score','ai_settled_at','ai_closing_odds','ai_clv']) then
    raise exception 'AI shadow ranking % is immutable', old.id using errcode = 'P0001';
  end if;
  if old.ai_status is not null then
    raise exception 'AI pick of shadow ranking % already settled as %', old.id, old.ai_status using errcode = 'P0001';
  end if;
  if new.ai_status is null then
    raise exception 'settlement fields of shadow ranking % can only change together with ai_status', old.id using errcode = 'P0001';
  end if;
  if old.pick_market is null then
    raise exception 'shadow ranking % has no AI pick to settle', old.id using errcode = 'P0001';
  end if;
  select status_short into v_fixture_status from fixtures where id = old.fixture_id;
  if new.ai_status <> 'VOID' and v_fixture_status not in ('FT','AET','PEN') then
    raise exception 'fixture % not finished (status %)', old.fixture_id, v_fixture_status using errcode = 'P0001';
  end if;
  new.ai_settled_at := now();
  return new;
end $$;

drop trigger if exists ai_shadow_rankings_insert on ai_shadow_rankings;
create trigger ai_shadow_rankings_insert before insert on ai_shadow_rankings
  for each row execute function fp_ai_shadow_before_insert();

drop trigger if exists ai_shadow_rankings_update on ai_shadow_rankings;
create trigger ai_shadow_rankings_update before update on ai_shadow_rankings
  for each row execute function fp_ai_shadow_before_update();

drop trigger if exists ai_shadow_rankings_no_delete on ai_shadow_rankings;
create trigger ai_shadow_rankings_no_delete before delete on ai_shadow_rankings
  for each row execute function fp_reject_change();

drop trigger if exists ai_shadow_rankings_no_truncate on ai_shadow_rankings;
create trigger ai_shadow_rankings_no_truncate before truncate on ai_shadow_rankings
  for each statement execute function fp_reject_change();

-- Rules vs AI on the SAME fixtures (only rows where the AI produced a valid answer).
-- win_rate counts HALF results as half, like analysis_performance.
create or replace view ai_shadow_comparison as
with base as (
  select s.status as ai_row_status, s.no_clear_signal, s.agrees_with_rules,
         s.ai_status, p.status as rules_status, p.kind as rules_kind, s.ai_clv, p.clv as rules_clv
  from ai_shadow_rankings s
  join analysis_predictions p on p.id = s.analysis_prediction_id
  where s.status = 'OK'
),
rates as (
  select 'RULES' as source,
         count(*) filter (where rules_kind = 'SIGNAL') as signals,
         count(*) filter (where rules_status = 'WIN') as win, count(*) filter (where rules_status = 'HALF_WIN') as half_win,
         count(*) filter (where rules_status = 'LOSS') as loss, count(*) filter (where rules_status = 'HALF_LOSS') as half_loss,
         count(*) filter (where rules_status = 'PUSH') as push, count(*) filter (where rules_status = 'VOID') as void,
         count(*) filter (where rules_status = 'PENDING') as pending,
         avg(rules_clv) as avg_clv
  from base
  union all
  select 'AI',
         count(*) filter (where not no_clear_signal),
         count(*) filter (where ai_status = 'WIN'), count(*) filter (where ai_status = 'HALF_WIN'),
         count(*) filter (where ai_status = 'LOSS'), count(*) filter (where ai_status = 'HALF_LOSS'),
         count(*) filter (where ai_status = 'PUSH'), count(*) filter (where ai_status = 'VOID'),
         count(*) filter (where not no_clear_signal and ai_status is null),
         avg(ai_clv)
  from base
)
select r.*,
       round((r.win + 0.5 * r.half_win)::numeric / nullif(r.win + r.loss + 0.5 * (r.half_win + r.half_loss), 0), 4) as win_rate,
       (select count(*) from base) as fixtures_compared,
       (select round(avg(case when agrees_with_rules then 1.0 else 0.0 end), 4) from base) as agreement_rate
from rates r;

-- internal research data (like analysis_runs): RLS on, no public policy -> workers only
alter table ai_shadow_rankings enable row level security;
alter view ai_shadow_comparison set (security_invoker = true);

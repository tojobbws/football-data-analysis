-- =====================================================================
-- 0062 Decisions v2 shadow (owner's request 2026-11-18; .scratch/decisions-v2/spec.md)
--
-- An independent decision per fixture on the stored DAILY Hybrid AI input (hybrid_decision_id, input_hash: the shared
-- raw data, never Hybrid's answer). The analyst answers in categories through OpenAI Decisions; the engine
-- (@fp/analysis decisions-v2) fits a score model to the main lines, turns the categories into every option's
-- win / half win / push / half loss / loss distribution and expected return at the snapshot price, and picks only when
-- the expected return clears the rule after its uncertainty. Never published, never read by the pick, publish or
-- featured jobs. Written by the decisions-v2 job (DECISIONS_V2=shadow).
--  * insert only before kickoff (DB clock), append-only, one row per fixture and version set; RLS on, no policy
--  * odds_snapshot / odds_hash: the main-line options and their quality exactly as decided on (the input's 14:00 prices)
--  * candidates: every option's numbers and reasons, picked or not
--  * fp_admin_decisions_v2(): admin-only read, with the Hybrid AI decision of the same input and the score
-- Rollback: supabase/rollbacks/0062_rollback.sql
-- =====================================================================

create table if not exists decisions_v2 (
  id                  bigint generated always as identity primary key,
  fixture_id          bigint      not null references fixtures(id),
  hybrid_decision_id  bigint      not null references hybrid_decisions(id),
  input_hash          text        not null,
  odds_snapshot       jsonb       not null,
  odds_hash           text        not null,
  engine_version      text        not null,
  rules_version       text        not null,
  prompt_version      text        not null,
  model               text,
  decided_at          timestamptz not null default now(),
  kickoff_at          timestamptz not null,
  status              text        not null check (status in ('OK','INVALID','ERROR')),
  side                text check (side in ('FAVORITE','UNDERDOG','OVER','UNDER','NO_PICK')),
  market              text check (market in ('ASIAN_HANDICAP','OVER_UNDER')),
  selection           text,
  line                numeric(5,2),
  odds                numeric(8,3),
  market_probability  numeric(6,5),
  fair_probability    numeric(6,5),
  ev                  numeric(8,5),
  ev_sd               numeric(8,5),
  no_pick_reasons     jsonb       not null default '[]',
  market_fit          jsonb,
  view                jsonb,
  candidates          jsonb       not null default '[]',
  evidence            jsonb       not null default '[]',
  request_sha256      text,
  response            jsonb,
  usage               jsonb,
  note                text,
  unique (fixture_id, engine_version, rules_version, prompt_version),
  check (status <> 'OK' or side is not null),
  check (side is null or side = 'NO_PICK' or (market is not null and selection is not null and line is not null and odds is not null and ev is not null))
);

create or replace function fp_decisions_v2_before_insert() returns trigger
language plpgsql as $$
declare
  v_kickoff timestamptz;
  v_fixture bigint;
begin
  select kickoff_at into v_kickoff from fixtures where id = new.fixture_id;
  if v_kickoff is null or v_kickoff <= now() then
    raise exception 'decisions v2 must be stored before kickoff' using errcode = 'P0001';
  end if;
  select fixture_id into v_fixture from hybrid_decisions where id = new.hybrid_decision_id;
  if v_fixture is distinct from new.fixture_id then
    raise exception 'hybrid decision % is not of fixture %', new.hybrid_decision_id, new.fixture_id using errcode = 'P0001';
  end if;
  new.kickoff_at := v_kickoff;
  new.decided_at := now();
  return new;
end $$;

drop trigger if exists decisions_v2_before_insert on decisions_v2;
create trigger decisions_v2_before_insert
  before insert on decisions_v2
  for each row execute function fp_decisions_v2_before_insert();

drop trigger if exists decisions_v2_append_only on decisions_v2;
create trigger decisions_v2_append_only
  before update or delete on decisions_v2
  for each row execute function fp_append_only();

alter table decisions_v2 enable row level security;

create or replace function fp_admin_decisions_v2(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not fp_is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(x.r order by x.r->>'kickoff_at', x.r->>'fixture_id')
      from (
        select jsonb_build_object(
                 'fixture_id',   f.id,
                 'slug',         f.slug,
                 'kickoff_at',   f.kickoff_at,
                 'status_short', f.status_short,
                 'home',         th.name,
                 'away',         ta.name,
                 'goals_home',   coalesce(f.ft_home, f.goals_home),
                 'goals_away',   coalesce(f.ft_away, f.goals_away),
                 'config',       s.engine_version || ' · ' || s.rules_version || ' · ' || s.prompt_version,
                 'called_at',    s.decided_at,
                 'status',       s.status,
                 'side',         s.side,
                 'market',       s.market,
                 'selection',    s.selection,
                 'line',         s.line,
                 'odds',         s.odds,
                 'market_probability', s.market_probability,
                 'fair_probability',   s.fair_probability,
                 'ev',           s.ev,
                 'ev_sd',        s.ev_sd,
                 'no_pick_reasons', s.no_pick_reasons,
                 'data_sufficient', s.view->'dataSufficient',
                 'ai_prompt_version', h.prompt_version,
                 'ai_status',    h.status,
                 'ai_side',      h.side,
                 'ai_market',    h.market,
                 'ai_selection', h.selection,
                 'ai_line',      h.line,
                 'ai_odds',      h.odds
               ) as r
          from (select distinct on (fixture_id) * from decisions_v2 order by fixture_id, decided_at desc, id desc) s
          join hybrid_decisions h on h.id = s.hybrid_decision_id
          join fixtures f on f.id = s.fixture_id
          join teams th on th.id = f.home_team_id
          join teams ta on ta.id = f.away_team_id
         where f.kickoff_at >= p_from and f.kickoff_at < p_to
      ) x
  ), '[]'::jsonb);
end $$;
revoke all on function fp_admin_decisions_v2(timestamptz, timestamptz) from public;
grant execute on function fp_admin_decisions_v2(timestamptz, timestamptz) to authenticated;

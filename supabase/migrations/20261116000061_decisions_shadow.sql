-- =====================================================================
-- 0061 OpenAI Decisions shadow (owner's request 2026-11-16: measure tonight's matches, readable in admin)
--
-- One OpenAI Decisions answer per fixture and config, asked on exactly the input a DAILY Hybrid AI decision stored
-- (hybrid_decision_id, same input_hash; that input was written before kickoff). Never published, never read by the
-- pick, publish or featured jobs. called_at is when Decisions was asked: an answer asked after kickoff still saw only
-- the stored pre-kickoff input, and the admin page marks it. Written by scripts/decisions-shadow.ts.
--  * append-only; RLS on with no policy (internal)
--  * fp_admin_decisions_shadow(): admin-only read, with the Hybrid AI decision of the same input and the score
-- Rollback: supabase/rollbacks/0061_rollback.sql
-- =====================================================================

create table if not exists decisions_shadow (
  id                  bigint generated always as identity primary key,
  fixture_id          bigint      not null references fixtures(id),
  hybrid_decision_id  bigint      not null references hybrid_decisions(id),
  input_hash          text        not null,
  config              text        not null,
  model               text        not null,
  called_at           timestamptz not null,
  stored_at           timestamptz not null default now(),
  status              text        not null check (status in ('OK','INVALID','ERROR')),
  side                text check (side in ('FAVORITE','UNDERDOG','OVER','UNDER','NO_PICK')),
  market              text check (market in ('ASIAN_HANDICAP','OVER_UNDER')),
  selection           text,
  line                numeric(5,2),
  odds                numeric(8,3),
  market_probability  numeric(6,5),
  choice_probability  numeric(6,5),
  confidence          numeric(6,5),
  probabilities       jsonb,
  predicates          jsonb,
  response            jsonb       not null,
  usage               jsonb,
  unique (fixture_id, config),
  check (status <> 'OK' or side is not null),
  check (side is null or side = 'NO_PICK' or (market is not null and selection is not null and line is not null))
);

drop trigger if exists decisions_shadow_append_only on decisions_shadow;
create trigger decisions_shadow_append_only
  before update or delete on decisions_shadow
  for each row execute function fp_append_only();

alter table decisions_shadow enable row level security;

create or replace function fp_admin_decisions_shadow(p_from timestamptz, p_to timestamptz) returns jsonb
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
                 'config',       s.config,
                 'called_at',    s.called_at,
                 'status',       s.status,
                 'side',         s.side,
                 'market',       s.market,
                 'selection',    s.selection,
                 'line',         s.line,
                 'odds',         s.odds,
                 'market_probability', s.market_probability,
                 'choice_probability', s.choice_probability,
                 'probabilities', s.probabilities,
                 'ai_prompt_version', h.prompt_version,
                 'ai_status',    h.status,
                 'ai_side',      h.side,
                 'ai_market',    h.market,
                 'ai_selection', h.selection,
                 'ai_line',      h.line,
                 'ai_odds',      h.odds
               ) as r
          from decisions_shadow s
          join hybrid_decisions h on h.id = s.hybrid_decision_id
          join fixtures f on f.id = s.fixture_id
          join teams th on th.id = f.home_team_id
          join teams ta on ta.id = f.away_team_id
         where f.kickoff_at >= p_from and f.kickoff_at < p_to
      ) x
  ), '[]'::jsonb);
end $$;
revoke all on function fp_admin_decisions_shadow(timestamptz, timestamptz) from public;
grant execute on function fp_admin_decisions_shadow(timestamptz, timestamptz) to authenticated;

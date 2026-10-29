-- =====================================================================
-- 0051 The match page timed out for anon (statement_timeout 3s) on `outlook`: web_model_outlook builds its
-- `pre` CTE over every pre-kickoff 1X2 / O/U 2.5 prediction of every fixture (~45k index rows of 924k, growing
-- with each match snapshot) and only then filters to the one fixture, which a cold cache cannot do in 3s.
-- The planner does not push fixture_id into that CTE, so the page asks a function that reads one fixture only.
-- Same logic and same owner's rights as the view; the view stays for web_model_outlook_performance.
-- =====================================================================

create or replace function web_model_outlook_for(p_fixture_id bigint)
returns table (fixture_id bigint, league_id int, model_version_id text, computed_at timestamptz,
               p_home numeric, p_draw numeric, p_away numeric, p_over25 numeric, sides_tested boolean, totals_tested boolean)
language sql stable security definer set search_path = public as $$
  with pre as (
    select p.fixture_id, p.model_version_id, p.computed_at, p.market, p.selection, p.probability, f.league_id
    from probability_predictions p
    join fixtures f on f.id = p.fixture_id
    where p.fixture_id = p_fixture_id
      and p.computed_at < f.kickoff_at
      and (
        (p.market = 'MATCH_WINNER' and p.model_version_id in ('ensemble-v0.1', 'dixon-coles-v0.2'))
        or (p.market = 'OVER_UNDER' and p.selection = 'OVER' and p.line = 2.5 and p.model_version_id = 'dixon-coles-v0.2')
      )
  ),
  side_model as (
    select pre.fixture_id, case when bool_or(pre.model_version_id = 'ensemble-v0.1') then 'ensemble-v0.1' else 'dixon-coles-v0.2' end as model_version_id
    from pre where pre.market = 'MATCH_WINNER'
    group by pre.fixture_id
  ),
  latest as (
    select pre.*, row_number() over (partition by pre.fixture_id, pre.market, pre.selection order by pre.computed_at desc) as rn
    from pre
    left join side_model s on s.fixture_id = pre.fixture_id
    where pre.market = 'OVER_UNDER' or pre.model_version_id = s.model_version_id
  ),
  cfg as (
    select distinct on (mc.league_id, mc.purpose) mc.league_id, mc.purpose, mc.enabled
    from model_configs mc
    order by mc.league_id, mc.purpose, mc.tuned_at desc
  )
  select
    l.fixture_id,
    max(l.league_id)                                                                   as league_id,
    max(s.model_version_id)                                                            as model_version_id,
    max(l.computed_at) filter (where l.market = 'MATCH_WINNER')                        as computed_at,
    max(l.probability) filter (where l.market = 'MATCH_WINNER' and l.selection = 'HOME') as p_home,
    max(l.probability) filter (where l.market = 'MATCH_WINNER' and l.selection = 'DRAW') as p_draw,
    max(l.probability) filter (where l.market = 'MATCH_WINNER' and l.selection = 'AWAY') as p_away,
    max(l.probability) filter (where l.market = 'OVER_UNDER')                          as p_over25,
    coalesce(bool_or(c1.enabled), false)                                               as sides_tested,
    coalesce(bool_or(c2.enabled), false)                                               as totals_tested
  from latest l
  left join side_model s on s.fixture_id = l.fixture_id
  left join cfg c1 on c1.league_id = l.league_id and c1.purpose = (case when s.model_version_id = 'ensemble-v0.1' then 'ENSEMBLE' else 'SIDES' end)
  left join cfg c2 on c2.league_id = l.league_id and c2.purpose = 'TOTALS'
  where l.rn = 1
  group by l.fixture_id;
$$;
revoke all on function web_model_outlook_for(bigint) from public;
grant execute on function web_model_outlook_for(bigint) to anon, authenticated;

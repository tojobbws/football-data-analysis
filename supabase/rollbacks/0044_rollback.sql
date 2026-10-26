-- Recovery plan for migration 0044 (materialized model results, audit A-18).
-- 0044 creates two materialized views and a refresh function, and points web_model_result_rows and
-- web_model_outlook_performance at them. No table or row changes. This puts both views back on their live
-- queries (0037 and 0016), so /performance computes them on every read again (slow on a cold cache).
-- The `model:refresh-web` step then fails until the code from before 0044 is deployed.
begin;
create or replace view web_model_result_rows as
with last_pre as (
  select p.fixture_id, p.model_version_id, p.market, p.selection, p.line, p.probability,
         row_number() over (partition by p.fixture_id, p.model_version_id, p.market, p.selection, p.line order by p.computed_at desc) as rn
  from probability_predictions p
  join fixtures f on f.id = p.fixture_id
  where p.computed_at < f.kickoff_at
    and ((p.market = 'MATCH_WINNER') or (p.market = 'OVER_UNDER' and p.selection = 'OVER' and p.line = 2.5))
),
x as (
  select fixture_id, model_version_id,
         max(probability) filter (where market = 'MATCH_WINNER' and selection = 'HOME') as p_home,
         max(probability) filter (where market = 'MATCH_WINNER' and selection = 'DRAW') as p_draw,
         max(probability) filter (where market = 'MATCH_WINNER' and selection = 'AWAY') as p_away,
         max(probability) filter (where market = 'OVER_UNDER') as p_over25
  from last_pre where rn = 1
  group by fixture_id, model_version_id
),
res as (
  select f.id as fixture_id, f.league_id, f.kickoff_at,
         coalesce(f.ft_home, f.goals_home) as gh, coalesce(f.ft_away, f.goals_away) as ga
  from fixtures f
  where f.status_short in ('FT', 'AET', 'PEN') and coalesce(f.ft_home, f.goals_home) is not null
)
select x.fixture_id, res.league_id, res.kickoff_at, x.model_version_id,
       x.p_home, x.p_draw, x.p_away, x.p_over25,
       case when res.gh > res.ga then 'HOME' when res.gh < res.ga then 'AWAY' else 'DRAW' end as result,
       (res.gh + res.ga) > 2.5 as over25
from x join res on res.fixture_id = x.fixture_id
where x.p_home is not null and x.p_draw is not null and x.p_away is not null;

create or replace view web_model_outlook_performance as
with r as (
  select o.*,
         case when coalesce(f.ft_home, f.goals_home) > coalesce(f.ft_away, f.goals_away) then 'HOME'
              when coalesce(f.ft_home, f.goals_home) < coalesce(f.ft_away, f.goals_away) then 'AWAY'
              else 'DRAW' end                                               as result,
         coalesce(f.ft_home, f.goals_home) + coalesce(f.ft_away, f.goals_away) as total_goals,
         greatest(o.p_home, o.p_draw, o.p_away)                              as p_top,
         case when o.p_home >= o.p_draw and o.p_home >= o.p_away then 'HOME'
              when o.p_away >= o.p_draw then 'AWAY' else 'DRAW' end          as top
  from web_model_outlook o
  join fixtures f on f.id = o.fixture_id
  where f.status_short in ('FT', 'AET', 'PEN')
    and coalesce(f.ft_home, f.goals_home) is not null
    and o.p_home is not null
)
select
  sides_tested                                                              as tested,
  count(*)::int                                                             as matches,
  count(*) filter (where top = result)::int                                 as correct,
  round(avg(p_top)::numeric, 4)                                             as expected_rate,
  count(*) filter (where p_over25 is not null)::int                         as ou_matches,
  count(*) filter (where p_over25 is not null and (p_over25 >= 0.5) = (total_goals > 2.5))::int as ou_correct,
  round(avg(greatest(p_over25, 1 - p_over25)) filter (where p_over25 is not null)::numeric, 4)  as ou_expected_rate
from r
group by sides_tested;

drop function if exists fp_refresh_web_results();
drop materialized view if exists web_model_outlook_performance_mv;
drop materialized view if exists web_model_result_rows_mv;
delete from fp_schema_migrations where name = '20261026000044_model_results_materialized.sql';
commit;

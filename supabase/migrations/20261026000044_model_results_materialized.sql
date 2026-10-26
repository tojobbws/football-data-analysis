-- =====================================================================
-- 0044 /performance timed out on a cold cache (audit A-18). Measured 2026-10-26 on production:
-- web_model_results took 4.7 s on its first read (anon statement_timeout is 3 s) and 0.14 s once the
-- cache was warm; the first /performance after a deploy rendered an error. The cost is
-- web_model_result_rows, which scans probability_predictions (~800k rows and growing, ADR 0007) and
-- feeds web_model_results, web_model_calibration and web_benchmark_days.
--
-- 1. web_model_result_rows_mv holds those rows (same query as 0037); web_model_result_rows now reads
--    it, so every view built on it keeps its name, columns and grants.
-- 2. web_model_outlook_performance_mv holds the two rows of web_model_outlook_performance (0016).
-- 3. fp_refresh_web_results() refreshes both; the hourly and daily jobs run it after settlement
--    (`model:refresh-web`), and model:health flags it when it stops.
-- The site's model results are therefore as of the last refresh (at most about an hour old); a
-- finished match counts once its result is in and the next refresh has run.
-- =====================================================================

create materialized view if not exists web_model_result_rows_mv as
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

-- one row per fixture and model version: lets the refresh run CONCURRENTLY (readers are never blocked)
create unique index if not exists web_model_result_rows_mv_key on web_model_result_rows_mv (fixture_id, model_version_id);

create or replace view web_model_result_rows as
select fixture_id, league_id, kickoff_at, model_version_id, p_home, p_draw, p_away, p_over25, result, over25
  from web_model_result_rows_mv;

create materialized view if not exists web_model_outlook_performance_mv as
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

create or replace view web_model_outlook_performance as
select tested, matches, correct, expected_rate, ou_matches, ou_correct, ou_expected_rate
  from web_model_outlook_performance_mv;

-- the views read them with their owner's rights; nobody reads the materialized views directly
revoke all on web_model_result_rows_mv from anon, authenticated;
revoke all on web_model_outlook_performance_mv from anon, authenticated;

create or replace function fp_refresh_web_results() returns void
language plpgsql security definer set search_path = public as $$
begin
  refresh materialized view concurrently web_model_result_rows_mv;
  -- two rows: a plain refresh holds readers back for a moment only
  refresh materialized view web_model_outlook_performance_mv;
end $$;
revoke all on function fp_refresh_web_results() from public, anon, authenticated;

-- =====================================================================
-- 0037 WEB: ผลโมเดล (model results) — how the model's 1X2 and O/U 2.5 probabilities did on
-- every finished match, apart from the pick track record (ADR 0007).
--
-- Per fixture and model version: the LAST probabilities computed BEFORE kickoff (live
-- snapshots only; nothing computed after kickoff counts). 90-minute result.
--   brier    = sum over the three outcomes of (p - outcome)^2          (0 = perfect, 0.667 = uniform)
--   log_loss = -ln(probability of the outcome that happened)
-- Owner's rights (not security_invoker): probability_predictions stays private, anon reads
-- only the two summary views.
-- =====================================================================

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

-- per league and model version (league_id null = all leagues together)
create or replace view web_model_results as
with r as (
  select *,
    greatest(p_home, p_draw, p_away) as p_top,
    case when p_home >= p_draw and p_home >= p_away then 'HOME' when p_away >= p_draw then 'AWAY' else 'DRAW' end as top,
    power(p_home - (result = 'HOME')::int, 2) + power(p_draw - (result = 'DRAW')::int, 2) + power(p_away - (result = 'AWAY')::int, 2) as brier,
    -ln(greatest(case result when 'HOME' then p_home when 'DRAW' then p_draw else p_away end, 1e-6)) as log_loss
  from web_model_result_rows
)
select
  league_id,
  model_version_id,
  count(*)::int                                                                   as matches,
  count(*) filter (where top = result)::int                                       as correct,
  round(avg(p_top)::numeric, 4)                                                   as avg_top_probability,
  round(avg(brier)::numeric, 4)                                                   as brier,
  round(avg(log_loss)::numeric, 4)                                                as log_loss,
  count(*) filter (where p_over25 is not null)::int                               as ou_matches,
  round((avg(power(p_over25 - over25::int, 2)) filter (where p_over25 is not null))::numeric, 4) as ou_brier
from r
group by grouping sets ((league_id, model_version_id), (model_version_id));

-- calibration: of every outcome the model rated in a probability band, how often it happened
create or replace view web_model_calibration as
with o as (
  select model_version_id, p, hit from (
    select model_version_id, p_home as p, (result = 'HOME') as hit from web_model_result_rows
    union all select model_version_id, p_draw, (result = 'DRAW') from web_model_result_rows
    union all select model_version_id, p_away, (result = 'AWAY') from web_model_result_rows
  ) u
)
select model_version_id,
       least(floor(p * 10), 9)::int                    as bucket,        -- 0 = 0-10%, 9 = 90-100%
       count(*)::int                                   as outcomes,
       round(avg(p)::numeric, 4)                       as avg_probability,
       round(avg(hit::int)::numeric, 4)                as hit_rate
from o
group by model_version_id, least(floor(p * 10), 9);

revoke all on web_model_result_rows from anon, authenticated;
revoke all on web_model_results from anon, authenticated;
revoke all on web_model_calibration from anon, authenticated;
grant select on web_model_results to anon, authenticated;
grant select on web_model_calibration to anon, authenticated;

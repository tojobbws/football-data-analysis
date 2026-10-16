-- =====================================================================
-- 0032 admin benchmark: the model's 1X2 forecast scored against API-Football /predictions
--  * benchmark forecast = the last api_predictions row collected before kickoff (percent home /
--    draw / away, renormalised to sum to 1); it never feeds the model, the rules or fan pages
--  * model forecast = the last pre-kickoff 1X2 of ensemble-v0.1 when the fixture has one,
--    otherwise of Dixon-Coles (any version); the Player Impact layer is left out
--  * scored on the 90-minute result of finished fixtures; a match missing either forecast is
--    left out and counted
--  * Brier is the 3-way sum of squared errors; log-loss clamps probabilities at 0.001
--  * brier_diff = model minus benchmark per match (negative = model better), with its standard
--    error so a small sample is not read as a verdict
-- =====================================================================

create or replace function fp_admin_benchmark() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
begin
  if not fp_is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  with finished as (
    select f.id, f.league_id, f.kickoff_at,
           case when coalesce(f.ft_home, f.goals_home) > coalesce(f.ft_away, f.goals_away) then 'HOME'
                when coalesce(f.ft_home, f.goals_home) < coalesce(f.ft_away, f.goals_away) then 'AWAY'
                else 'DRAW' end as result
      from fixtures f
     where f.status_short in ('FT','AET','PEN')
       and coalesce(f.ft_home, f.goals_home) is not null
       and coalesce(f.ft_away, f.goals_away) is not null
  ),
  bench as (
    select distinct on (a.fixture_id) a.fixture_id,
           a.percent_home / nullif(a.percent_home + a.percent_draw + a.percent_away, 0) as ph,
           a.percent_draw / nullif(a.percent_home + a.percent_draw + a.percent_away, 0) as pd,
           a.percent_away / nullif(a.percent_home + a.percent_draw + a.percent_away, 0) as pa
      from api_predictions a
      join finished f on f.id = a.fixture_id
     where a.collected_at < f.kickoff_at
       and a.percent_home is not null and a.percent_draw is not null and a.percent_away is not null
     order by a.fixture_id, a.collected_at desc
  ),
  model_run as (
    -- last pre-kickoff run per fixture, ensemble preferred over Dixon-Coles
    select distinct on (p.fixture_id) p.fixture_id, p.model_version_id, p.computed_at
      from probability_predictions p
      join finished f on f.id = p.fixture_id
     where p.market = 'MATCH_WINNER' and p.computed_at < f.kickoff_at
       and (p.model_version_id = 'ensemble-v0.1' or p.model_version_id like 'dixon-coles-%')
     order by p.fixture_id, (p.model_version_id = 'ensemble-v0.1') desc, p.computed_at desc
  ),
  model as (
    select r.fixture_id,
           max(p.probability) filter (where p.selection = 'HOME') as ph,
           max(p.probability) filter (where p.selection = 'DRAW') as pd,
           max(p.probability) filter (where p.selection = 'AWAY') as pa
      from model_run r
      join probability_predictions p
        on p.fixture_id = r.fixture_id and p.model_version_id = r.model_version_id
       and p.computed_at = r.computed_at and p.market = 'MATCH_WINNER'
     group by r.fixture_id
  ),
  scored as (
    select f.league_id,
           power(m.ph - (f.result = 'HOME')::int, 2) + power(m.pd - (f.result = 'DRAW')::int, 2) + power(m.pa - (f.result = 'AWAY')::int, 2) as m_brier,
           power(b.ph - (f.result = 'HOME')::int, 2) + power(b.pd - (f.result = 'DRAW')::int, 2) + power(b.pa - (f.result = 'AWAY')::int, 2) as b_brier,
           -ln(greatest(case f.result when 'HOME' then m.ph when 'DRAW' then m.pd else m.pa end, 0.001)) as m_log,
           -ln(greatest(case f.result when 'HOME' then b.ph when 'DRAW' then b.pd else b.pa end, 0.001)) as b_log
      from finished f
      join model m on m.fixture_id = f.id
      join bench b on b.fixture_id = f.id
     where m.ph is not null and m.pd is not null and m.pa is not null and b.ph is not null
  ),
  summary as (
    select league_id,
           count(*) as n,
           avg(m_brier) as model_brier, avg(b_brier) as benchmark_brier,
           avg(m_log) as model_log_loss, avg(b_log) as benchmark_log_loss,
           avg(m_brier - b_brier) as brier_diff,
           stddev_samp(m_brier - b_brier) / sqrt(count(*)) as brier_diff_se
      from scored
     group by grouping sets ((league_id), ())
  )
  select jsonb_build_object(
           'matched', coalesce((select n from summary where league_id is null), 0),
           'model_only', (select count(*) from model m where not exists (select 1 from bench b where b.fixture_id = m.fixture_id)),
           'benchmark_only', (select count(*) from bench b where not exists (select 1 from model m where m.fixture_id = b.fixture_id)),
           'total', (select to_jsonb(s) - 'league_id' from summary s where league_id is null),
           'leagues', coalesce((
             select jsonb_agg(to_jsonb(s) || jsonb_build_object('league_name', l.name) order by s.n desc)
               from summary s join leagues l on l.id = s.league_id
              where s.league_id is not null), '[]'::jsonb)
         )
    into result;
  return result;
end $$;
revoke all on function fp_admin_benchmark() from public;
grant execute on function fp_admin_benchmark() to authenticated;

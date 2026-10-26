-- Recovery plan for migration 0045 (materialized web_benchmark_days, audit A-18).
-- 0045 creates one materialized view, points web_benchmark_days at it and adds it to
-- fp_refresh_web_results(). No table or row changes. This puts the view back on its live query (0043) and
-- the refresh function back to its 0044 body.
begin;
create or replace view web_benchmark_days as
with mkt as (
  select fixture_id,
         max(market_probability) filter (where selection = 'HOME') as mh,
         max(market_probability) filter (where selection = 'DRAW') as md,
         max(market_probability) filter (where selection = 'AWAY') as ma
    from market_closing
   where market = 'MATCH_WINNER'
   group by fixture_id
  having count(*) = 3
),
x12 as (
  select r.model_version_id, fp_football_day(r.kickoff_at) as day, r.result,
         r.p_home, r.p_draw, r.p_away,
         m.mh / (m.mh + m.md + m.ma) as q_home, m.md / (m.mh + m.md + m.ma) as q_draw, m.ma / (m.mh + m.md + m.ma) as q_away
    from web_model_result_rows r
    join mkt m on m.fixture_id = r.fixture_id
),
lines as (
  select case c.market when 'ASIAN_HANDICAP' then 'AH_MAIN' else 'OU_MAIN' end as metric,
         fp_football_day(f.kickoff_at) as day,
         c.model_probability::float8 as p, c.market_probability::float8 as q,
         fp_settle_selection(c.market, c.selection, c.line, coalesce(f.ft_home, f.goals_home), coalesce(f.ft_away, f.goals_away)) as outcome
    from market_closing c
    join fixtures f on f.id = c.fixture_id
   where c.market in ('ASIAN_HANDICAP', 'OVER_UNDER') and c.selection in ('HOME', 'OVER')
     and c.model_probability is not null
     and f.status_short in ('FT', 'AET', 'PEN')
),
picks as (
  select p.model_probability::float8 as p, p.market_probability::float8 as q, p.status as outcome, p.clv,
         fp_football_day(f.kickoff_at) as day,
         row_number() over (partition by p.fixture_id order by p.published_at desc, p.id desc) as rn
    from analysis_predictions p
    join fixtures f on f.id = p.fixture_id
   where p.kind = 'SIGNAL'
),
fair as (
  select metric, day, p, q, fp_fair_weight(outcome)::float8 as w, fp_fair_y(outcome) as y, null::float8 as clv
    from lines
  union all
  select 'PICK', day, p, q, fp_fair_weight(outcome)::float8, fp_fair_y(outcome),
         case when outcome in ('WIN', 'HALF_WIN', 'PUSH', 'HALF_LOSS', 'LOSS') then clv::float8 end
    from picks
   where rn = 1
)
-- Sums per day. w = fair weight of every decided row (hit = Σ w·y); w_scored = the part with both a model and
-- a market probability, which every probability sum (brier_*, log_loss_*, p_model, p_market) is over.
select '1X2'::text as metric, model_version_id, day,
       count(*)::int                                                                                         as n,
       count(*)::float8                                                                                      as w,
       count(*)::float8                                                                                      as w_scored,
       sum(power(p_home - (result = 'HOME')::int, 2) + power(p_draw - (result = 'DRAW')::int, 2) + power(p_away - (result = 'AWAY')::int, 2)) as brier_model,
       sum(power(q_home - (result = 'HOME')::int, 2) + power(q_draw - (result = 'DRAW')::int, 2) + power(q_away - (result = 'AWAY')::int, 2)) as brier_market,
       sum(-ln(greatest(case result when 'HOME' then p_home when 'DRAW' then p_draw else p_away end, 1e-6)))  as log_loss_model,
       sum(-ln(greatest(case result when 'HOME' then q_home when 'DRAW' then q_draw else q_away end, 1e-6)))  as log_loss_market,
       null::float8                                                                                          as hit,
       null::float8                                                                                          as p_model,
       null::float8                                                                                          as p_market,
       0                                                                                                     as clv_n,
       null::float8                                                                                          as clv_sum
  from x12
 group by model_version_id, day
union all
select metric, null, day,
       count(*) filter (where w > 0)::int,
       coalesce(sum(w), 0),
       coalesce(sum(w) filter (where p is not null and q is not null), 0),
       sum(w * power(p - y, 2)) filter (where w > 0 and p is not null and q is not null),
       sum(w * power(q - y, 2)) filter (where w > 0 and p is not null and q is not null),
       sum(w * -ln(greatest(case when y = 1 then p else 1 - p end, 1e-6))) filter (where w > 0 and p is not null and q is not null),
       sum(w * -ln(greatest(case when y = 1 then q else 1 - q end, 1e-6))) filter (where w > 0 and p is not null and q is not null),
       sum(w * y) filter (where w > 0),
       sum(w * p) filter (where w > 0 and p is not null and q is not null),
       sum(w * q) filter (where w > 0 and p is not null and q is not null),
       count(clv)::int,
       sum(clv)
  from fair
 group by metric, day
union all
select 'FINISHED', null, fp_football_day(f.kickoff_at), count(*)::int, count(*)::float8, null, null, null, null, null, null, null, null, 0, null
  from fixtures f
 where f.status_short in ('FT', 'AET', 'PEN')
   and f.league_id in (select distinct league_id from model_configs)
 group by fp_football_day(f.kickoff_at);

create or replace function fp_refresh_web_results() returns void
language plpgsql security definer set search_path = public as $$
begin
  refresh materialized view concurrently web_model_result_rows_mv;
  refresh materialized view web_model_outlook_performance_mv;
end $$;
revoke all on function fp_refresh_web_results() from public, anon, authenticated;

drop materialized view if exists web_benchmark_days_mv;
delete from fp_schema_migrations where name = '20261026000045_benchmark_materialized.sql';
commit;

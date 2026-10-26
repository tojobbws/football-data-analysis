-- =====================================================================
-- 0045 web_benchmark_days on a cold cache (audit A-18, after 0044). Measured 2026-10-26 on production
-- right after 0044: 3.8 s on its first read (anon statement_timeout is 3 s), 0.14 s warm. The time goes
-- to reading fixtures (finished matches per day) and market_closing from disk.
--
-- web_benchmark_days_mv holds the view's rows (same query as 0043; model_version_id '' instead of
-- null so a unique index covers every row and the refresh can run CONCURRENTLY); web_benchmark_days
-- reads it and gives null back. fp_refresh_web_results() refreshes it after the model result rows it
-- is built on. Names, columns and grants of the view stay as they were.
--
-- Postgres 17 builds and refreshes a materialized view with a safe search_path (pg_catalog, pg_temp):
-- a function body that calls another of our functions by bare name no longer finds it there
-- (fp_settle_selection -> fp_settle_asian). The 0043 functions get search_path = public, so the
-- view resolves them as before.
-- =====================================================================

alter function fp_settle_selection(text, text, numeric, int, int) set search_path = public;
alter function fp_settle_asian(numeric, numeric) set search_path = public;
alter function fp_fair_weight(text) set search_path = public;
alter function fp_fair_y(text) set search_path = public;
alter function fp_football_day(timestamptz) set search_path = public;

create materialized view if not exists web_benchmark_days_mv as
select metric, coalesce(model_version_id, '') as model_version_id, day, n, w, w_scored,
       brier_model, brier_market, log_loss_model, log_loss_market, hit, p_model, p_market, clv_n, clv_sum
  from (
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
     group by fp_football_day(f.kickoff_at)
  ) b;

create unique index if not exists web_benchmark_days_mv_key on web_benchmark_days_mv (metric, model_version_id, day);

create or replace view web_benchmark_days as
select metric, nullif(model_version_id, '') as model_version_id, day, n, w, w_scored,
       brier_model, brier_market, log_loss_model, log_loss_market, hit, p_model, p_market, clv_n, clv_sum
  from web_benchmark_days_mv;

revoke all on web_benchmark_days_mv from anon, authenticated;

create or replace function fp_refresh_web_results() returns void
language plpgsql security definer set search_path = public as $$
begin
  refresh materialized view concurrently web_model_result_rows_mv;
  -- built on the rows above: refreshed after them
  refresh materialized view concurrently web_benchmark_days_mv;
  -- two rows: a plain refresh holds readers back for a moment only
  refresh materialized view web_model_outlook_performance_mv;
end $$;
revoke all on function fp_refresh_web_results() from public, anon, authenticated;

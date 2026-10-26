-- =====================================================================
-- 0043 market benchmark (audit 2026-10-26, A-01 A-03 A-06 A-09; docs/audit-remediation-plan.md)
--
-- 1. fp_settle_asian / fp_settle_selection: the settlement rule of packages/analysis/src/settlement.ts
--    in SQL, so views can score Asian handicap and over/under lines. Parity with the TypeScript rule is
--    tested (packages/database/test/market-benchmark.test.ts).
-- 2. Fair target: WIN 1 at weight 1, HALF_WIN 1 at weight 1/2, HALF_LOSS 0 at weight 1/2, LOSS 0 at
--    weight 1, PUSH and VOID out (packages/analysis/src/evaluation.ts). Its weighted mean is the fair
--    hit rate, so Brier and log loss on it score the fair probability both the model and a no-vig
--    market price state.
-- 3. web_benchmark_days: per football day (06:00 -> 06:00 Thai) sums for the model and the market on
--    the same matches and the same target. One row per day lets the site compute intervals clustered
--    by day (matches of one day are not independent). Metrics:
--      1X2      last pre-kickoff probabilities of each model version vs the closing 1X2 (market_closing)
--      AH_MAIN  model vs market on the closing main Asian handicap line, home side (market_closing)
--      OU_MAIN  same on the closing main over/under line, over side
--      PICK     one Game Compass pick per match (its latest SIGNAL): the model's and the market's fair
--               probability of the picked side, both recorded at publish; CLV of settled picks
--      FINISHED finished matches in modelled leagues, for coverage
-- 4. analysis_performance_by_match: analysis_performance with one record per match (the latest
--    SIGNAL, else the latest record), so a match published in two rounds counts once. A fog record has
--    no market: its bucket is 'NONE', not 'ALL'. CLV of a VOID pick is left out.
-- 5. fp_admin_review(): fair hit used WIN 1 / HALF_WIN 0.5 over all decided picks, which counts a
--    HALF_LOSS as a full loss; now (W + HW/2) / (W + L + (HW + HL)/2) like analysis_performance and
--    trialSide, plus fair_n (the denominator) for the interval.
-- Nothing here changes a stored row.
-- =====================================================================

create or replace function fp_football_day(t timestamptz) returns date
language sql immutable as $$ select ((t at time zone 'Asia/Bangkok') - interval '6 hours')::date $$;

-- settleAsian(margin, line): quarter lines split into line +/- 0.25 at half stake each
create or replace function fp_settle_asian(margin numeric, line numeric) returns text
language plpgsql immutable as $$
declare
  a text;
  b text;
begin
  if (abs(line * 4) % 2) <> 1 then
    return case when margin + line > 0 then 'WIN' when margin + line < 0 then 'LOSS' else 'PUSH' end;
  end if;
  a := case when margin + line - 0.25 > 0 then 'WIN' when margin + line - 0.25 < 0 then 'LOSS' else 'PUSH' end;
  b := case when margin + line + 0.25 > 0 then 'WIN' when margin + line + 0.25 < 0 then 'LOSS' else 'PUSH' end;
  if a = b then return a; end if;
  if a = 'WIN' or b = 'WIN' then return 'HALF_WIN'; end if;
  return 'HALF_LOSS';
end $$;

-- settle(selection, home, away) on the 90-minute score; null for anything it cannot settle
create or replace function fp_settle_selection(market text, selection text, line numeric, home int, away int) returns text
language sql immutable as $$
  select case
    when home is null or away is null then null
    when market = 'MATCH_WINNER' then
      case when selection = (case when home > away then 'HOME' when home < away then 'AWAY' else 'DRAW' end) then 'WIN' else 'LOSS' end
    when line is null then null
    when market = 'ASIAN_HANDICAP' and selection = 'HOME' then fp_settle_asian(home - away, line)
    when market = 'ASIAN_HANDICAP' and selection = 'AWAY' then fp_settle_asian(away - home, line)
    when market = 'OVER_UNDER' and selection = 'OVER' then fp_settle_asian(home + away, -line)
    when market = 'OVER_UNDER' and selection = 'UNDER' then fp_settle_asian(-(home + away), line)
  end
$$;

create or replace function fp_fair_weight(outcome text) returns numeric
language sql immutable as $$
  select case outcome when 'WIN' then 1.0 when 'LOSS' then 1.0 when 'HALF_WIN' then 0.5 when 'HALF_LOSS' then 0.5 else 0.0 end
$$;

create or replace function fp_fair_y(outcome text) returns int
language sql immutable as $$ select case when outcome in ('WIN', 'HALF_WIN') then 1 else 0 end $$;

-- Owner's rights like web_model_results (0037): market_closing and probability_predictions stay private.
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

revoke all on web_benchmark_days from anon, authenticated;
grant select on web_benchmark_days to anon, authenticated;

-- analysis_performance (0009) counted every publish round; this counts each match once
create or replace view analysis_performance_by_match as
with ranked as (
  select p.*,
         row_number() over (partition by p.fixture_id order by (p.kind = 'SIGNAL') desc, p.published_at desc, p.id desc) as rn,
         count(*) filter (where p.kind = 'SIGNAL') over (partition by p.fixture_id) as signals_in_match
    from analysis_predictions p
),
base as (
  select r.*, f.league_id, to_char(r.published_at at time zone 'Asia/Bangkok', 'YYYY-MM') as month
    from ranked r
    join fixtures f on f.id = r.fixture_id
   where r.rn = 1
)
select
  case
    when grouping(market)        = 0 then 'market'
    when grouping(league_id)     = 0 then 'league'
    when grouping(month)         = 0 then 'month'
    when grouping(publish_round) = 0 then 'round'
    else 'all'
  end as dimension,
  case
    when grouping(market)        = 0 then coalesce(market, 'NONE')
    when grouping(league_id)     = 0 then league_id::text
    when grouping(month)         = 0 then month
    when grouping(publish_round) = 0 then publish_round
    else 'ALL'
  end as bucket,
  count(*) filter (where kind = 'SIGNAL')           as total_signals,
  count(*) filter (where kind = 'NO_CLEAR_SIGNAL')  as no_signal,
  count(*) filter (where status = 'PENDING')        as pending,
  count(*) filter (where status = 'WIN')            as win,
  count(*) filter (where status = 'HALF_WIN')       as half_win,
  count(*) filter (where status = 'LOSS')           as loss,
  count(*) filter (where status = 'HALF_LOSS')      as half_loss,
  count(*) filter (where status = 'PUSH')           as push,
  count(*) filter (where status = 'VOID')           as void,
  round(
    (count(*) filter (where status = 'WIN') + 0.5 * count(*) filter (where status = 'HALF_WIN'))::numeric
    / nullif(count(*) filter (where status in ('WIN','LOSS'))
             + 0.5 * count(*) filter (where status in ('HALF_WIN','HALF_LOSS')), 0)
  , 4) as win_rate,
  round(avg(clv) filter (where status <> 'VOID'), 5) as avg_clv,
  round(avg(case when clv > 0 then 1.0 when clv is not null then 0.0 end) filter (where status <> 'VOID'), 4) as beat_closing_rate,
  count(*) filter (where kind = 'SIGNAL' and signals_in_match > 1) as matches_with_repeat_signal
from base
group by grouping sets ((), (market), (league_id), (month), (publish_round));

alter view analysis_performance_by_match set (security_invoker = true);
grant select on analysis_performance_by_match to anon, authenticated;

create or replace function fp_admin_review() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  result jsonb;
begin
  if not fp_is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  with px as (
    select p.id, p.market, p.selection, p.publish_round, p.decision_rule_version, p.status, p.clv,
           p.model_probability, p.market_probability, f.league_id, f.kickoff_at,
           (p.status in ('WIN','HALF_WIN','LOSS','HALF_LOSS')) as decided,
           case p.status when 'WIN' then 1.0 when 'HALF_WIN' then 0.5 else 0.0 end as win_pts,
           fp_fair_weight(p.status) as fair_w
      from analysis_predictions p join fixtures f on f.id = p.fixture_id
     where p.kind = 'SIGNAL'
  ),
  versions as (
    select v.version,
           coalesce((select min(f.kickoff_at) from featured_selections fs join fixtures f on f.id = fs.fixture_id
                      where fs.version = v.version and fs.locked_at is not null), now()) as since
      from (values ('featured-v1'), ('featured-v2')) v(version)
  ),
  grp as (
    -- the confirmed featured selections of each version ...
    select fs.version as label, px.decided, px.win_pts, px.fair_w, px.clv, fs.fair_probability as fair_p
      from featured_selections fs join px on px.id = fs.prediction_id
     where fs.phase = 'CONFIRMED'
    union all
    -- ... and all LINEUP picks of the same period, outside the excluded leagues
    select 'all:' || v.version, px.decided, px.win_pts, px.fair_w, px.clv, null
      from versions v join px on px.publish_round = 'LINEUP' and px.kickoff_at >= v.since
     where px.league_id <> all (array[296, 5, 1129])
  ),
  side as (
    select label,
           count(*)::int as picks,
           count(*) filter (where decided)::int as settled,
           sum(win_pts) filter (where decided) / nullif(sum(fair_w) filter (where decided), 0) as fair_hit,
           coalesce(sum(fair_w) filter (where decided), 0) as fair_n,
           count(clv)::int as clv_n,
           avg(clv) as clv_mean,
           avg((clv > 0)::int) filter (where clv is not null) as beat_close,
           avg(fair_p) filter (where decided) as avg_fair_probability
      from grp group by label
  ),
  edge as (
    select case when model_probability - market_probability < 0.06 then '1) under 6'
                when model_probability - market_probability < 0.09 then '2) 6 to 9'
                when model_probability - market_probability < 0.12 then '3) 9 to 12'
                else '4) 12 and over' end as bucket,
           count(*)::int as settled,
           sum(win_pts) / nullif(sum(fair_w), 0) as fair_hit,
           avg(clv) as clv_mean
      from px where decided and market_probability is not null group by 1
  ),
  by_side as (
    select market, selection, count(*)::int as settled, sum(win_pts) / nullif(sum(fair_w), 0) as fair_hit,
           avg(model_probability - market_probability) as avg_edge
      from px where decided group by 1, 2
  ),
  by_rules as (
    select coalesce(decision_rule_version, '-') as rules, count(*)::int as picks,
           count(*) filter (where decided)::int as settled,
           sum(win_pts) filter (where decided) / nullif(sum(fair_w) filter (where decided), 0) as fair_hit
      from px group by 1
  ),
  days as (
    select fs.version, fs.football_date::text as day,
           count(*)::int as picks,
           count(*) filter (where px.status in ('WIN','HALF_WIN'))::int as won,
           count(*) filter (where px.status in ('LOSS','HALF_LOSS'))::int as lost,
           count(*) filter (where px.status in ('PUSH','VOID'))::int as push,
           count(*) filter (where px.status = 'PENDING')::int as pending
      from featured_selections fs left join px on px.id = fs.prediction_id
     where fs.phase = 'CONFIRMED' group by 1, 2
  )
  select jsonb_build_object(
           'sides', coalesce((select jsonb_object_agg(label, to_jsonb(side) - 'label') from side), '{}'::jsonb),
           'by_edge', coalesce((select jsonb_agg(to_jsonb(edge) order by bucket) from edge), '[]'::jsonb),
           'by_side', coalesce((select jsonb_agg(to_jsonb(by_side) order by market, selection) from by_side), '[]'::jsonb),
           'by_rules', coalesce((select jsonb_agg(to_jsonb(by_rules) order by rules) from by_rules), '[]'::jsonb),
           'days', coalesce((select jsonb_agg(to_jsonb(days) order by day desc, version) from days), '[]'::jsonb)
         )
    into result;
  return result;
end $$;
revoke all on function fp_admin_review() from public;
grant execute on function fp_admin_review() to authenticated;

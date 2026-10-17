-- =====================================================================
-- 0034 admin review: the report behind the 2026-11-06 review (ADR 0006), computed on read
--  * featured-v1 and featured-v2: confirmed LINEUP selections against all LINEUP picks of the same
--    period (leagues outside the featured scope left out), as `model:featured-report` does
--  * the release criteria of ADR 0006 per version: 300 settled, fair hit rate >= 55%, mean fair win
--    chance within 5 points of the fair hit rate, 90% lower bound of the hit rate >= 50%
--  * every settled SIGNAL pick by edge over the market, by side, and by pick-rule version
--  * confirmed selections per football day
--  Fair hit rate: WIN 1, HALF_WIN 0.5 over decided picks (WIN, HALF_WIN, LOSS, HALF_LOSS); PUSH and
--  VOID are left out. Read-only; admins only.
-- =====================================================================

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
           case p.status when 'WIN' then 1.0 when 'HALF_WIN' then 0.5 else 0.0 end as win_pts
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
    select fs.version as label, px.decided, px.win_pts, px.clv, fs.fair_probability as fair_p
      from featured_selections fs join px on px.id = fs.prediction_id
     where fs.phase = 'CONFIRMED'
    union all
    -- ... and all LINEUP picks of the same period, outside the excluded leagues
    select 'all:' || v.version, px.decided, px.win_pts, px.clv, null
      from versions v join px on px.publish_round = 'LINEUP' and px.kickoff_at >= v.since
     where px.league_id <> all (array[296, 5, 1129])
  ),
  side as (
    select label,
           count(*)::int as picks,
           count(*) filter (where decided)::int as settled,
           sum(win_pts) filter (where decided) / nullif(count(*) filter (where decided), 0) as fair_hit,
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
           sum(win_pts) / count(*) as fair_hit,
           avg(clv) as clv_mean
      from px where decided and market_probability is not null group by 1
  ),
  by_side as (
    select market, selection, count(*)::int as settled, sum(win_pts) / count(*) as fair_hit,
           avg(model_probability - market_probability) as avg_edge
      from px where decided group by 1, 2
  ),
  by_rules as (
    select coalesce(decision_rule_version, '-') as rules, count(*)::int as picks,
           count(*) filter (where decided)::int as settled,
           sum(win_pts) filter (where decided) / nullif(count(*) filter (where decided), 0) as fair_hit
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

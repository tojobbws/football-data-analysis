-- =====================================================================
-- 0055 One daily pick run (docs/adr/0014-one-daily-pick-run.md)
--
--  * publish round DAILY: the one final round of the 14:00 Thai run, allowed beside the earlier rounds in
--    analysis_predictions, hybrid_decisions and the shadow trial's locks (shadow_decisions)
--  * featured-ai-v2: the list of a pick day (14:00 → 14:00 Thai), chosen once and confirmed at once; its rows
--    use football_date for the pick day's date. Visitors may read its listed rows as they read featured-ai-v1's.
--  * fp_admin_review() reports featured-ai-v2; its comparison group is every Hybrid AI pick of the same period
-- Rollback: supabase/rollbacks/0055_rollback.sql
-- =====================================================================

-- the checks were declared inline, so their names are generated: drop whichever check tests publish_round
do $$
declare
  c record;
begin
  for c in
    select con.conrelid::regclass as tbl, con.conname
      from pg_constraint con
     where con.contype = 'c'
       and con.conrelid in ('analysis_predictions'::regclass, 'hybrid_decisions'::regclass, 'shadow_decisions'::regclass)
       and pg_get_constraintdef(con.oid) like '%publish_round%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end $$;

alter table analysis_predictions add constraint analysis_predictions_publish_round_check
  check (publish_round in ('EARLY','PREMATCH','LINEUP','DAILY'));
alter table hybrid_decisions add constraint hybrid_decisions_publish_round_check
  check (publish_round in ('EARLY','PREMATCH','LINEUP','DAILY'));
alter table shadow_decisions add constraint shadow_decisions_publish_round_check
  check (publish_round in ('LATEST','EARLY','LINEUP','DAILY'));

drop policy if exists featured_selections_public_read on featured_selections;
create policy featured_selections_public_read on featured_selections
  for select to anon, authenticated
  using (version in ('featured-v2', 'featured-ai-v1', 'featured-ai-v2') and rank is not null and phase in ('RESERVED','CONFIRMED'));

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
      from (values ('featured-v1'), ('featured-v2'), ('featured-ai-v1'), ('featured-ai-v2')) v(version)
  ),
  grp as (
    -- the confirmed featured selections of each version ...
    select fs.version as label, px.decided, px.win_pts, px.fair_w, px.clv, fs.fair_probability as fair_p
      from featured_selections fs join px on px.id = fs.prediction_id
     where fs.phase = 'CONFIRMED'
    union all
    -- ... and all comparable picks of the same period, outside the excluded leagues: every Hybrid AI pick for
    -- the AI lists, every LINEUP pick for the rules lists
    select 'all:' || v.version, px.decided, px.win_pts, px.fair_w, px.clv, null
      from versions v join px on px.kickoff_at >= v.since
       and (case when v.version like 'featured-ai-%' then px.decision_rule_version = 'hybrid-ai-v1' else px.publish_round = 'LINEUP' end)
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

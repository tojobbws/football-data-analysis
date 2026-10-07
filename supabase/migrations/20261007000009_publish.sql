-- =====================================================================
-- 0009 PUBLISH (Phase 6)
-- * performance broken down by publish round (EARLY vs LINEUP)
-- * published_analysis: website-ready view of the immutable track record
-- =====================================================================

create or replace view analysis_performance as
with base as (
  select p.*, f.league_id,
         to_char(p.published_at at time zone 'Asia/Bangkok', 'YYYY-MM') as month
  from analysis_predictions p
  join fixtures f on f.id = p.fixture_id
)
select
  case
    when grouping(market)        = 0 then 'market'
    when grouping(league_id)     = 0 then 'league'
    when grouping(month)         = 0 then 'month'
    when grouping(publish_round) = 0 then 'round'
    else 'all'
  end as dimension,
  coalesce(market, league_id::text, month, publish_round, 'ALL') as bucket,
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
  round(avg(clv), 5) as avg_clv,
  round(avg(case when clv > 0 then 1.0 when clv is not null then 0.0 end), 4) as beat_closing_rate
from base
group by grouping sets ((), (market), (league_id), (month), (publish_round));

create or replace view published_analysis as
select
  p.public_id,
  p.chain_seq,
  p.published_at,
  p.publish_round,
  p.kind,
  p.market,
  p.selection,
  p.line,
  p.odds_at_publish,
  p.model_probability,
  p.market_probability,
  p.signal_strength,
  p.reason,
  p.status,
  p.result_score,
  p.settled_at,
  p.record_hash,
  p.fixture_id,
  f.slug        as fixture_slug,
  f.kickoff_at,
  l.name        as league_name,
  th.name       as home_team,
  ta.name       as away_team
from analysis_predictions p
join fixtures f on f.id = p.fixture_id
join leagues  l on l.id = f.league_id
join teams   th on th.id = f.home_team_id
join teams   ta on ta.id = f.away_team_id;

alter view analysis_performance set (security_invoker = true);
alter view published_analysis   set (security_invoker = true);

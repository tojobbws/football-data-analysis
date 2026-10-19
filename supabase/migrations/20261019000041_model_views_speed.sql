-- =====================================================================
-- 0041 /performance timed out for anon (statement_timeout 3s): web_model_calibration and
-- web_model_outlook_performance both seq-scanned probability_predictions (346k rows and growing
-- with every match snapshot, ADR 0007), and the calibration view scanned its base three times.
--
-- 1. Partial covering index for the only rows the model views read: 1X2 and O/U 2.5 OVER.
-- 2. web_model_calibration reads web_model_result_rows once and splits each match into its three
--    outcomes with a lateral VALUES list (same output; 1.9s -> 0.7s measured before the index).
-- =====================================================================

create index if not exists probability_predictions_model_views_idx
  on probability_predictions (fixture_id, model_version_id, market, selection, line, computed_at desc)
  include (probability)
  where market = 'MATCH_WINNER' or (market = 'OVER_UNDER' and selection = 'OVER' and line = 2.5);

create or replace view web_model_calibration as
select r.model_version_id,
       least(floor(o.p * 10), 9)::int                 as bucket,        -- 0 = 0-10%, 9 = 90-100%
       count(*)::int                                   as outcomes,
       round(avg(o.p)::numeric, 4)                     as avg_probability,
       round(avg(o.hit::int)::numeric, 4)              as hit_rate
from web_model_result_rows r
cross join lateral (values (r.p_home, r.result = 'HOME'), (r.p_draw, r.result = 'DRAW'), (r.p_away, r.result = 'AWAY')) as o(p, hit)
group by r.model_version_id, least(floor(o.p * 10), 9);

revoke all on web_model_calibration from anon, authenticated;
grant select on web_model_calibration to anon, authenticated;

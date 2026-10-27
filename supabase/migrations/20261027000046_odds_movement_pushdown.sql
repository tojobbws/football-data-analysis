-- =====================================================================
-- 0046 odds_movement reads one fixture's quotes, not the whole of odds_history.
--
-- The 0002 view ranks every quote in a CTE that it joins to itself. A CTE used twice is materialized,
-- so `where fixture_id = $1` (Repository.selectionMovement, the preview job) cannot reach it: every
-- call sorted all of odds_history (3.26 M rows, 439 MB, work_mem 2 MB -> sort spilled to disk). From
-- 2026-10-26 18:05 UTC the hourly preview job ran 7-20 min and then hit the statement timeout every
-- hour, and the odds sync running beside it slowed until the 30-minute job limit cancelled it.
--
-- Same columns and rows as before. The window now partitions inside a plain subquery, so a filter
-- on fixture_id (a partition column) is pushed into it and uses the odds_history key index; the
-- current quote is the last one of the same key, read through that index.
-- =====================================================================

create or replace view odds_movement as
select
  o.fixture_id, o.bookmaker_id, o.market, o.api_bet_id, o.selection, o.line, o.home_line, o.raw_value,
  o.odds               as opening_odds,
  o.source_updated_at  as opening_at,
  c.odds               as current_odds,
  c.source_updated_at  as current_at,
  (c.odds - o.odds)    as odds_change,
  o.n_snapshots
from (
  select h.*,
         row_number() over w_asc as rn_asc,
         count(*)     over w_all as n_snapshots
    from odds_history h
  window
    w_all as (partition by fixture_id, bookmaker_id, api_bet_id, raw_value),
    w_asc as (partition by fixture_id, bookmaker_id, api_bet_id, raw_value order by source_updated_at asc)
) o
cross join lateral (
  select h.odds, h.source_updated_at
    from odds_history h
   where h.fixture_id = o.fixture_id and h.bookmaker_id = o.bookmaker_id
     and h.api_bet_id = o.api_bet_id and h.raw_value = o.raw_value
   order by h.source_updated_at desc
   limit 1
) c
where o.rn_asc = 1;

-- create or replace resets the view's options: keep it running with the caller's rights (0005)
alter view odds_movement set (security_invoker = true);

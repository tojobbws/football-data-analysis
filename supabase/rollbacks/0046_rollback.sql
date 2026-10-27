-- Recovery plan for migration 0046 (odds_movement filter pushdown).
-- 0046 only rewrites the view; no table or row changes. This puts back the 0002 body, which sorts the
-- whole of odds_history on every read (the preview job then times out again on a cold cache).
begin;
create or replace view odds_movement as
with ranked as (
  select
    o.*,
    row_number() over w_asc  as rn_asc,
    row_number() over w_desc as rn_desc,
    count(*)     over w_all  as n_snapshots
  from odds_history o
  window
    w_all  as (partition by fixture_id, bookmaker_id, api_bet_id, raw_value),
    w_asc  as (partition by fixture_id, bookmaker_id, api_bet_id, raw_value order by source_updated_at asc),
    w_desc as (partition by fixture_id, bookmaker_id, api_bet_id, raw_value order by source_updated_at desc)
)
select
  o.fixture_id, o.bookmaker_id, o.market, o.api_bet_id, o.selection, o.line, o.home_line, o.raw_value,
  o.odds               as opening_odds,
  o.source_updated_at  as opening_at,
  c.odds               as current_odds,
  c.source_updated_at  as current_at,
  (c.odds - o.odds)    as odds_change,
  o.n_snapshots
from ranked o
join ranked c
  on  c.fixture_id = o.fixture_id and c.bookmaker_id = o.bookmaker_id
  and c.api_bet_id = o.api_bet_id and c.raw_value = o.raw_value
  and c.rn_desc = 1
where o.rn_asc = 1;
alter view odds_movement set (security_invoker = true);
delete from fp_schema_migrations where name = '20261027000046_odds_movement_pushdown.sql';
commit;

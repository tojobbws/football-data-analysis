-- =====================================================================
-- 0021 STORAGE: retention for raw API responses and odds snapshots
-- (see docs/adr/0002-data-retention.md)
--
-- 1. raw_response_id becomes a plain reference, not an FK. With the FK,
--    pruning raw rows set it to null on every linked odds_history row —
--    hundreds of thousands of UPDATEs that bloat the table right when the
--    database is out of space. Raw rows are only kept a few days anyway.
-- 2. odds_history stays append-only, except that the odds snapshots of a
--    match may be deleted 7 days after kickoff once none of its picks or
--    AI shadow picks is unsettled (settlement has copied closing odds and
--    CLV onto the pick by then).
-- =====================================================================

alter table odds_history    drop constraint if exists odds_history_raw_response_id_fkey;
alter table api_predictions drop constraint if exists api_predictions_raw_response_id_fkey;

create or replace function fp_odds_snapshot_expired(p_fixture_id bigint) returns boolean
language sql stable as $$
  select exists (select 1 from fixtures f where f.id = p_fixture_id and f.kickoff_at < now() - interval '7 days')
     and not exists (select 1 from analysis_predictions p where p.fixture_id = p_fixture_id and p.status = 'PENDING')
     and not exists (select 1 from ai_shadow_rankings a
                      where a.fixture_id = p_fixture_id and a.ai_status is null and a.pick_market is not null)
$$;

create or replace function fp_odds_history_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and fp_odds_snapshot_expired(old.fixture_id) then
    return old;
  end if;
  raise exception '% on table % is not allowed (append-only; snapshots expire 7 days after a fully settled match)', tg_op, tg_table_name
    using errcode = 'P0001';
end $$;

drop trigger if exists odds_history_immutable on odds_history;
create trigger odds_history_immutable
  before update or delete on odds_history
  for each row execute function fp_odds_history_guard();

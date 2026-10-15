-- =====================================================================
-- 0027 STORAGE: odds snapshots are kept for good
-- (see docs/adr/0002-data-retention.md)
--
-- On Supabase Pro (8 GB) the 7-day expiry from 0021 is no longer needed,
-- and the full price history is kept as a future model feature.
-- odds_history is append-only again: every UPDATE and DELETE is rejected.
-- =====================================================================

drop trigger if exists odds_history_immutable on odds_history;
create trigger odds_history_immutable
  before update or delete on odds_history
  for each row execute function fp_reject_change();

drop function if exists fp_odds_history_guard();
drop function if exists fp_odds_snapshot_expired(bigint);

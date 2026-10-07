-- =====================================================================
-- 0013 STORAGE: drop the duplicated raw JSON from fixture_lineups
-- ~9.8 MB of the 11 MB table. Every lineup is also in api_raw_responses
-- (verified: 4,557/4,557 fixtures covered); no code read the column.
-- Run `vacuum full fixture_lineups` afterwards to return the space.
-- =====================================================================

alter table fixture_lineups drop column if exists raw;

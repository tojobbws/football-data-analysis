-- =====================================================================
-- 0012 STORAGE: drop the duplicated raw JSON from fixture_player_stats
-- It was ~90% of the table (115 MB of 141 MB). The same data is kept in
-- api_raw_responses (every /fixtures?ids response, incl. all player stats),
-- so nothing is lost: extra fields (duels, dribbles, ...) can be extracted
-- from there later. Run `vacuum full fixture_player_stats` afterwards to
-- return the space (VACUUM cannot run inside a migration transaction).
-- =====================================================================

alter table fixture_player_stats drop column if exists raw;

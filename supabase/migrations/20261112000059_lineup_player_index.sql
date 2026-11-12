-- =====================================================================
-- 0059 Lineup players by player: an index for the name lookups.
--
-- fixture_lineup_players had only its key and (fixture_id, team_id). Repository.playerNames (the hourly impact
-- job) and the scorer-name fallback look rows up by player_id, so every call read the whole table (181 MB,
-- 1.3 M rows): 15,590 blocks from disk for six players, measured 2026-11-12. Since 2026-10-15 these scans
-- read 5.1 billion rows, and on 2026-11-12 the project ran out of its Disk IO budget (baseline 6 MB/s): the
-- hourly runs from 10:05 to 14:05 Thai failed on statement timeouts and the site stopped answering.
-- =====================================================================

create index if not exists fixture_lineup_players_player_idx
  on fixture_lineup_players (player_id)
  where player_id is not null;

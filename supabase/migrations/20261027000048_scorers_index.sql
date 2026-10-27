-- =====================================================================
-- 0048 Home page scorers: an index for the read the page makes.
--
-- The home page reads the top scorers of every tracked league in one paged query (league, season,
-- goals > 0, ordered by goals). player_season_stats had only its primary key (player_id first), so every
-- page scanned the whole table (42 MB) and ran past anon's 3 s statement timeout on a cold cache
-- (4.8 s measured 2026-10-27). This index serves the filter and the order directly.
-- =====================================================================

create index if not exists player_season_stats_scorers_idx
  on player_season_stats (league_id, season, goals desc, player_id, team_id);

-- Rolls back 0058. Deploy the web code that reads player_season_stats directly first, or the home page widgets fail.
drop function if exists web_top_scorers(int[], int);

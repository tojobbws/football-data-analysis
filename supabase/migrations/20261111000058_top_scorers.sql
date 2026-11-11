-- =====================================================================
-- 0058 Home page top scorers in one read.
--
-- The home page's league widgets read every scorer row of the tracked leagues' current seasons (5,626 rows,
-- 6 pages of 1000 on 2026-11-11) only to show five per league; the pages were the slowest read of the page.
-- This function does the same work next to the data and returns the shown rows only (5 per league).
--
-- Same rules as the page code it replaces (apps/web/src/lib/queries.ts leagueWidgets):
--  - the league's current season (league_seasons.is_current), goals > 0;
--  - a player who moved clubs mid-season has one row per team: goals and assists are summed, and the club
--    shown is the team of the row last in (goals desc, player_id, team_id) order;
--  - ranked by goals, then assists, then the player's best row in that order.
-- The page code kept only the top 8 x limit rows of each league before summing; summing every row is the same
-- or better (a moved player's second row is never dropped).
-- Public data (anon reads these tables under RLS already): security invoker.
-- =====================================================================

create or replace function web_top_scorers(p_league_ids int[], p_limit int default 5)
returns table (league_id int, player_id int, name text, photo_url text, team_id int, goals int, assists int)
language sql stable set search_path = public as $$
  with cur as (
    select ls.league_id, ls.season
    from league_seasons ls
    where ls.is_current and ls.league_id = any(p_league_ids)
  ),
  scored as (
    select s.league_id, s.player_id, s.team_id, s.goals, coalesce(s.assists, 0) as assists,
           row_number() over (partition by s.league_id order by s.goals desc, s.player_id, s.team_id) as rn
    from player_season_stats s
    join cur on cur.league_id = s.league_id and cur.season = s.season
    where s.goals > 0
  ),
  per_player as (
    select r.league_id, r.player_id,
           sum(r.goals)::int                            as goals,
           sum(r.assists)::int                          as assists,
           (array_agg(r.team_id order by r.rn desc))[1] as team_id,
           min(r.rn)                                    as first_rn
    from scored r
    group by r.league_id, r.player_id
  ),
  ranked as (
    select pp.*, row_number() over (partition by pp.league_id order by pp.goals desc, pp.assists desc, pp.first_rn) as place
    from per_player pp
  )
  select rk.league_id, rk.player_id, p.name, p.photo_url, rk.team_id, rk.goals, rk.assists
  from ranked rk
  left join players p on p.id = rk.player_id
  where rk.place <= p_limit
  order by rk.league_id, rk.place;
$$;
revoke all on function web_top_scorers(int[], int) from public;
grant execute on function web_top_scorers(int[], int) to anon, authenticated;

-- =====================================================================
-- 0022 STORAGE: drop fixtures.raw (~20 MB, read by nothing)
-- Every field the site uses has its own column. h2h_fixtures selects f.*,
-- so it is recreated without the column. Run `vacuum full fixtures`
-- afterwards to return the space (VACUUM cannot run inside a migration).
-- =====================================================================

drop view if exists h2h_fixtures;
alter table fixtures drop column if exists raw;

create view h2h_fixtures as
select
  least(home_team_id, away_team_id)    as team_a_id,
  greatest(home_team_id, away_team_id) as team_b_id,
  f.*
from fixtures f
where status_short in ('FT','AET','PEN');
alter view h2h_fixtures set (security_invoker = true);

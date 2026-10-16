-- =====================================================================
-- 0031 admin coverage: what API-Football says each league season has vs what we actually hold
--  * flags come from league_seasons.coverage (synced daily from /leagues)
--  * shares are over the season's finished fixtures; a flag that is on with a low share points
--    at a sync gap, a flag that is off explains a missing model input
--  * the model gates on the data it holds (xG / events / lineup shares), never on these flags;
--    the one exception is injuries: no coverage means an empty list is "unknown"
-- =====================================================================

create or replace function fp_admin_coverage() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not fp_is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row order by row->>'league_name')
      from (
        select jsonb_build_object(
                 'league_id', s.league_id,
                 'league_name', l.name,
                 'season', s.season,
                 'coverage', s.coverage,
                 'finished', count(f.id),
                 'xg', count(f.id) filter (where exists (
                         select 1 from fixture_statistics x
                          where x.fixture_id = f.id and x.type = 'expected_goals' and x.value_num is not null)),
                 'events', count(f.id) filter (where exists (select 1 from fixture_events e where e.fixture_id = f.id)),
                 'lineups', count(f.id) filter (where exists (select 1 from fixture_lineup_players p where p.fixture_id = f.id)),
                 'injuries', count(f.id) filter (where exists (select 1 from injuries i where i.fixture_id = f.id))
               ) as row
          from league_seasons s
          join leagues l on l.id = s.league_id
          left join fixtures f on f.league_id = s.league_id and f.season = s.season and f.status_short in ('FT','AET','PEN')
         where s.is_current
         group by s.league_id, s.season, s.coverage, l.name
      ) t
  ), '[]'::jsonb);
end $$;
revoke all on function fp_admin_coverage() from public;
grant execute on function fp_admin_coverage() to authenticated;

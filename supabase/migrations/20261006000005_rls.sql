-- =====================================================================
-- 0005 ROW LEVEL SECURITY
-- All tables: RLS on. Workers use the service role / direct DB URL (bypasses RLS).
-- Public (anon) gets READ-ONLY access to public-facing tables only.
-- Raw odds are intentionally NOT public (served only via server-side aggregates).
-- =====================================================================

do $$
declare
  t text;
  all_tables text[] := array[
    'api_raw_responses','sync_runs','leagues','league_seasons','venues','teams','team_seasons',
    'players','player_season_stats','fixtures','fixture_events','fixture_statistics','fixture_lineups',
    'fixture_lineup_players','fixture_player_stats','injuries','standings','transfers','api_predictions',
    'bookmakers','odds_history','model_versions','probability_predictions','analysis_runs',
    'analysis_candidates','analysis_predictions','analysis_snapshots','article_categories','articles',
    'social_contents','social_publications','advertisers','campaigns','placements','banners',
    'impressions','clicks'
  ];
  public_read text[] := array[
    'leagues','league_seasons','venues','teams','team_seasons','players','player_season_stats',
    'fixtures','fixture_events','fixture_statistics','fixture_lineups','fixture_lineup_players',
    'fixture_player_stats','injuries','standings','model_versions','analysis_candidates',
    'analysis_predictions','analysis_snapshots','article_categories','placements'
  ];
begin
  foreach t in array all_tables loop
    execute format('alter table %I enable row level security', t);
  end loop;

  foreach t in array public_read loop
    execute format('drop policy if exists %I on %I', t || '_public_read', t);
    execute format('create policy %I on %I for select to anon, authenticated using (true)', t || '_public_read', t);
  end loop;
end $$;

drop policy if exists articles_public_read on articles;
create policy articles_public_read on articles for select to anon, authenticated
  using (status = 'PUBLISHED');

drop policy if exists banners_public_read on banners;
create policy banners_public_read on banners for select to anon, authenticated
  using (is_active);

-- Views run with the privileges of the caller (respect RLS)
alter view h2h_fixtures           set (security_invoker = true);
alter view odds_movement          set (security_invoker = true);
alter view odds_closing           set (security_invoker = true);
alter view prediction_chain_daily set (security_invoker = true);
alter view analysis_performance   set (security_invoker = true);
alter view analysis_calibration   set (security_invoker = true);

-- Recovery plan for migration 0049 (preview-v1.1). First deploy code that writes preview-v1.0 again.
-- v1.1 rows are part of the immutable record and are never deleted, so with v1.1 rows stored this
-- rollback keeps the columns (the site would show the older layout without them); without any it
-- restores the 0042 view and drops the columns.
begin;
do $$
begin
  if exists (select 1 from match_previews where version = 'preview-v1.1') then
    raise notice 'preview-v1.1 rows are stored: keeping their columns';
  else
    -- a view cannot lose columns through create or replace: drop and recreate it
    drop view if exists web_match_previews;
    create view web_match_previews as
    select distinct on (fixture_id)
      fixture_id, stage, kickoff_at, version, prompt_version, text_source, ai_status,
      data_support, data_notes,
      predicted_home, predicted_away, predicted_p, expected_home, expected_away,
      p_home, p_draw, p_away,
      overview_th, home_th, away_th, score_th, created_at,
      p_goals_0_1, p_goals_2, p_goals_3plus,
      attack_th, defence_th, h2h_th, key_factor_th, summary_th,
      opponent_th, main_side, confidence, confidence_notes, p_btts
    from match_previews
    order by fixture_id, created_at desc, id desc;
    alter view web_match_previews set (security_invoker = true);
    grant select on web_match_previews to anon, authenticated;
    alter table match_previews alter column score_th set not null;
    alter table match_previews drop column if exists headline_th, drop column if exists team_news_th,
      drop column if exists analysis_th, drop column if exists facts_th;
    delete from fp_schema_migrations where name = '20261028000049_preview_v11.sql';
  end if;
end $$;
commit;

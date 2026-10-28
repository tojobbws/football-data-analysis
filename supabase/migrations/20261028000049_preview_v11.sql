-- =====================================================================
-- 0049 match_previews: the v1.1 write-up (preview-v1.1)
-- Laid out like a match preview in the Thai football press:
--   headline_th   one-line headline           overview_th  the lead (also the teaser on lists)
--   home_th       the home side               away_th      the away side
--   team_news_th  absences and lineups        analysis_th  how they meet + the most likely score's reasons
--   facts_th      3-5 facts read off the data (jsonb array of Thai strings; no market, no prediction)
-- attack_th, defence_th, opponent_th, score_th and key_factor_th are not written from v1.1, so
-- score_th may be null. Rows before v1.1 are untouched.
-- =====================================================================

alter table match_previews add column if not exists headline_th  text;
alter table match_previews add column if not exists team_news_th text;
alter table match_previews add column if not exists analysis_th  text;
alter table match_previews add column if not exists facts_th     jsonb;

alter table match_previews alter column score_th drop not null;

-- same columns as 0042, the v1.1 ones appended (a view may only gain columns at the end)
create or replace view web_match_previews as
select distinct on (fixture_id)
  fixture_id, stage, kickoff_at, version, prompt_version, text_source, ai_status,
  data_support, data_notes,
  predicted_home, predicted_away, predicted_p, expected_home, expected_away,
  p_home, p_draw, p_away,
  overview_th, home_th, away_th, score_th, created_at,
  p_goals_0_1, p_goals_2, p_goals_3plus,
  attack_th, defence_th, h2h_th, key_factor_th, summary_th,
  opponent_th, main_side, confidence, confidence_notes, p_btts,
  headline_th, team_news_th, analysis_th, facts_th
from match_previews
order by fixture_id, created_at desc, id desc;

-- create or replace resets view options
alter view web_match_previews set (security_invoker = true);

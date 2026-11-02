-- =====================================================================
-- 0052 match_previews.score_matrix: the score matrix the preview was written from
-- The fan page shows the "pick-consistent scoreline" (สกอร์ที่น่าจะเกิด): the most likely score on
-- which the match's published pick wins. The pick can change after the preview is written (hybrid
-- supersedes the rules pick), so the page picks the score at read time from this matrix: rows are
-- home goals, columns away goals, the same totals matrix behind the goal bands (rounded to 6 places).
-- null on earlier rows and on matches the model had no numbers for; the page then keeps the
-- stored predicted_home/away (the plain most likely score). Rows are untouched otherwise.
-- =====================================================================

alter table match_previews add column if not exists score_matrix jsonb;

-- same columns as 0049, the new one appended (a view may only gain columns at the end)
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
  headline_th, team_news_th, analysis_th, facts_th,
  score_matrix
from match_previews
order by fixture_id, created_at desc, id desc;

-- create or replace resets view options
alter view web_match_previews set (security_invoker = true);

-- =====================================================================
-- 0023 match_previews: goal bands (total goals 0-1 / 2 / 3+)
-- The preview card leads with the goal bands instead of the single most likely scoreline,
-- which read as a prediction next to the outlook's over 2.5 (1-1 at 12% beside over 2.5 at 59%).
-- Recorded with the preview from the same score matrix; null on rows written before
-- preview-v0.5 (never backfilled: a preview stays what it was before kickoff).
-- The bands are not in `facts`: the AI never sees them.
-- =====================================================================

alter table match_previews add column if not exists p_goals_0_1   numeric(6,5);
alter table match_previews add column if not exists p_goals_2     numeric(6,5);
alter table match_previews add column if not exists p_goals_3plus numeric(6,5);

create or replace view web_match_previews as
select distinct on (fixture_id)
  fixture_id, stage, kickoff_at, version, prompt_version, text_source, ai_status,
  data_support, data_notes,
  predicted_home, predicted_away, predicted_p, expected_home, expected_away,
  p_home, p_draw, p_away,
  overview_th, home_th, away_th, score_th, created_at,
  p_goals_0_1, p_goals_2, p_goals_3plus
from match_previews
order by fixture_id, created_at desc, id desc;

alter view web_match_previews set (security_invoker = true);

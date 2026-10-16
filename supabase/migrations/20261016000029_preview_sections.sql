-- =====================================================================
-- 0029 match_previews: a sectioned write-up (preview-v0.7)
-- 1. ภาพรวม (overview_th)  2. ฟอร์ม (home_th / away_th)
-- 3. รูปเกม (attack_th, defence_th, h2h_th, key_factor_th)  4. ตัวเลขโมเดล (score_th)  + summary_th
-- Null on rows written before v0.7 (never backfilled: a preview stays what it was before kickoff);
-- h2h_th is also null when the teams have no recent meetings.
-- =====================================================================

alter table match_previews add column if not exists attack_th     text;
alter table match_previews add column if not exists defence_th    text;
alter table match_previews add column if not exists h2h_th        text;
alter table match_previews add column if not exists key_factor_th text;
alter table match_previews add column if not exists summary_th    text;

create or replace view web_match_previews as
select distinct on (fixture_id)
  fixture_id, stage, kickoff_at, version, prompt_version, text_source, ai_status,
  data_support, data_notes,
  predicted_home, predicted_away, predicted_p, expected_home, expected_away,
  p_home, p_draw, p_away,
  overview_th, home_th, away_th, score_th, created_at,
  p_goals_0_1, p_goals_2, p_goals_3plus,
  attack_th, defence_th, h2h_th, key_factor_th, summary_th
from match_previews
order by fixture_id, created_at desc, id desc;

alter view web_match_previews set (security_invoker = true);

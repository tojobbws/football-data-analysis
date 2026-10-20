-- =====================================================================
-- 0042 match_previews: the v1.0 write-up (preview-v1.0)
-- Three points on the main side and its opponent, the model's most likely score with its reasons,
-- and a game summary with a confidence level set by fixed rules (never by the AI).
--   attack_th   1. the main side's attack          defence_th  2. its weak spots and what to watch
--   opponent_th 3. the opponent                    score_th    the most likely score's reasons
--   key_factor_th  what could change the result    overview_th the lead (also the teaser on lists)
-- home_th / away_th are not written from v1.0, so they may be null. Rows before v1.0 are untouched.
-- =====================================================================

alter table match_previews add column if not exists opponent_th      text;
alter table match_previews add column if not exists main_side        text check (main_side in ('HOME','AWAY'));
alter table match_previews add column if not exists confidence       text check (confidence in ('LOW','MEDIUM','HIGH'));
alter table match_previews add column if not exists confidence_notes jsonb not null default '[]';
-- chance that both teams score, from the same matrix as the goal bands
alter table match_previews add column if not exists p_btts           numeric(6,4);

alter table match_previews alter column home_th drop not null;
alter table match_previews alter column away_th drop not null;

create or replace view web_match_previews as
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

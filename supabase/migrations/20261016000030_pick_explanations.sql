-- =====================================================================
-- 0030 pick_explanations: the Game Compass note (pick_th)
--  * one or two Thai sentences per published pick (SIGNAL), any round: what the view is and where
--    the model sees the match differently from the market, from the match facts
--  * written after the pick is published; the pick itself is never touched (hash chain)
--  * insert only before kickoff; immutable afterwards. Append-only: a failed AI attempt may be
--    followed by one retry, and the site shows the latest row per pick
--  * the AI only writes prose; when its text fails the guards the template text is stored instead
-- =====================================================================

create table if not exists pick_explanations (
  id                      bigint generated always as identity primary key,
  analysis_prediction_id  bigint not null references analysis_predictions(id),
  fixture_id              bigint not null references fixtures(id),
  kickoff_at              timestamptz not null,               -- copied from the fixture by trigger
  version                 text   not null,                    -- facts/template version (pick-note-v0.1)
  prompt_version          text,                               -- AI prompt version when the AI was asked
  model                   text,                               -- model that answered (null = not asked)
  text_source             text   not null check (text_source in ('AI','TEMPLATE')),
  ai_status               text   not null check (ai_status in ('OK','INVALID','REFUSED','SKIPPED')),
  note_th                 text   not null,
  facts                   jsonb  not null,                    -- exactly what the AI saw
  output                  jsonb,                              -- raw AI answer
  guard_violations        jsonb  not null default '[]',
  usage                   jsonb,
  created_at              timestamptz not null default now()
);
create index if not exists pick_explanations_prediction_idx on pick_explanations (analysis_prediction_id);
create index if not exists pick_explanations_fixture_idx on pick_explanations (fixture_id);

-- same rule as match_previews: stored before kickoff (DB clock), kickoff copied from the fixture
drop trigger if exists pick_explanations_insert on pick_explanations;
create trigger pick_explanations_insert before insert on pick_explanations
  for each row execute function fp_match_preview_before_insert();

drop trigger if exists pick_explanations_immutable on pick_explanations;
create trigger pick_explanations_immutable before update or delete on pick_explanations
  for each row execute function fp_reject_change();

drop trigger if exists pick_explanations_no_truncate on pick_explanations;
create trigger pick_explanations_no_truncate before truncate on pick_explanations
  for each statement execute function fp_reject_change();

alter table pick_explanations enable row level security;
drop policy if exists pick_explanations_public_read on pick_explanations;
create policy pick_explanations_public_read on pick_explanations for select to anon, authenticated using (true);

create or replace view web_pick_explanations as
select distinct on (analysis_prediction_id)
  analysis_prediction_id, fixture_id, text_source, note_th, created_at
from pick_explanations
order by analysis_prediction_id, created_at desc, id desc;

alter view web_pick_explanations set (security_invoker = true);
revoke all on web_pick_explanations from anon, authenticated;
grant select on web_pick_explanations to anon, authenticated;

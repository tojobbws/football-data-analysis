-- =====================================================================
-- 0017 🔎 วิเคราะห์เกม — a written preview for EVERY match (not a pick)
--  * one row per (fixture, stage): EARLY (within 48h) and LINEUP (XIs confirmed)
--  * insert only before kickoff (DB clock); immutable afterwards — the text a reader saw
--    before the match stays exactly as it was, like the track record
--  * numbers (probabilities, predicted score) come from the model; the AI only writes prose,
--    and when its text fails the guards the deterministic template text is stored instead
--    (text_source) so coverage never depends on the AI
--  * data_support + data_notes: how far the data can carry an opinion and why (Thai)
-- =====================================================================

create table if not exists match_previews (
  id                bigint generated always as identity primary key,
  fixture_id        bigint not null references fixtures(id),
  stage             text   not null check (stage in ('EARLY','LINEUP')),
  kickoff_at        timestamptz not null,                       -- copied from the fixture by trigger
  version           text   not null,                            -- facts/template version (preview-v0.1)
  prompt_version    text,                                       -- AI prompt version when the AI was asked
  model             text,                                       -- model that answered (null = not asked)
  text_source       text   not null check (text_source in ('AI','TEMPLATE')),
  ai_status         text   not null check (ai_status in ('OK','INVALID','REFUSED','SKIPPED')),
  data_support      text   not null check (data_support in ('GOOD','LIMITED','THIN')),
  data_notes        jsonb  not null default '[]',               -- Thai reasons, deterministic
  predicted_home    int,                                        -- most likely scoreline (model), null = no model
  predicted_away    int,
  predicted_p       numeric(6,5),
  expected_home     numeric(5,2),
  expected_away     numeric(5,2),
  p_home            numeric(6,5),
  p_draw            numeric(6,5),
  p_away            numeric(6,5),
  overview_th       text   not null,
  home_th           text   not null,
  away_th           text   not null,
  score_th          text   not null,
  facts             jsonb  not null,                            -- exactly what the text was built from / the AI saw
  output            jsonb,                                      -- raw AI answer
  guard_violations  jsonb  not null default '[]',
  usage             jsonb,
  created_at        timestamptz not null default now(),
  unique (fixture_id, stage)
);
create index if not exists match_previews_kickoff_idx on match_previews (kickoff_at);

create or replace function fp_match_preview_before_insert() returns trigger
language plpgsql as $$
declare
  v_kickoff timestamptz;
begin
  select kickoff_at into v_kickoff from fixtures where id = new.fixture_id;
  if v_kickoff is null or v_kickoff <= now() then
    raise exception 'match preview must be stored before kickoff' using errcode = 'P0001';
  end if;
  new.kickoff_at := v_kickoff;
  new.created_at := now();
  return new;
end $$;

drop trigger if exists match_previews_insert on match_previews;
create trigger match_previews_insert before insert on match_previews
  for each row execute function fp_match_preview_before_insert();

drop trigger if exists match_previews_immutable on match_previews;
create trigger match_previews_immutable before update or delete on match_previews
  for each row execute function fp_reject_change();

drop trigger if exists match_previews_no_truncate on match_previews;
create trigger match_previews_no_truncate before truncate on match_previews
  for each statement execute function fp_reject_change();

-- public read: the preview is content, written before kickoff and shown as-is
alter table match_previews enable row level security;
drop policy if exists match_previews_public_read on match_previews;
create policy match_previews_public_read on match_previews for select to anon, authenticated using (true);

-- ---------------------------------------------------------------------
-- The site shows the latest stage per fixture (LINEUP supersedes EARLY).
-- ---------------------------------------------------------------------
create or replace view web_match_previews as
select distinct on (fixture_id)
  fixture_id, stage, kickoff_at, version, prompt_version, text_source, ai_status,
  data_support, data_notes,
  predicted_home, predicted_away, predicted_p, expected_home, expected_away,
  p_home, p_draw, p_away,
  overview_th, home_th, away_th, score_th, created_at
from match_previews
order by fixture_id, created_at desc, id desc;

alter view web_match_previews set (security_invoker = true);
revoke all on web_match_previews from anon, authenticated;
grant select on web_match_previews to anon, authenticated;

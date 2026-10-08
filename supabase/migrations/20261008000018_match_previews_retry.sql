-- =====================================================================
-- 0018 match_previews: allow one retry per stage
-- A failed AI attempt (guard violation / refusal) stored the template text. The job may now
-- try the AI once more for the same stage: rows stay append-only and immutable (the first
-- text remains on record), the site shows the latest row (web_match_previews already does).
-- =====================================================================

alter table match_previews drop constraint if exists match_previews_fixture_id_stage_key;
create index if not exists match_previews_fixture_stage_idx on match_previews (fixture_id, stage);

-- =====================================================================
-- 0057 social posting from /admin/social: Facebook Reels + Instagram Reels
--
--  * the owner uploads a finished film in /admin/social and presses post: the server sends it to Meta
--    (Graph API, resumable upload) and records each channel as one social_contents row
--  * INSTAGRAM joins the channels; the status follows the upload:
--    UPLOADING -> PUBLISHING (one request holds the publish step) -> PROCESSING (Meta still encodes) -> PUBLISHED | FAILED
--  * social_publications keeps the public post (external id, url)
--  * only role ADMIN may write; ADMIN and EDITOR may read (0015)
-- Rollback: supabase/rollbacks/0057_rollback.sql
-- =====================================================================

alter table social_contents drop constraint if exists social_contents_channel_check;
alter table social_contents add constraint social_contents_channel_check
  check (channel in ('TIKTOK','FACEBOOK','INSTAGRAM','YOUTUBE_SHORTS','YOUTUBE','X','THREADS','LINE'));

alter table social_contents drop constraint if exists social_contents_status_check;
alter table social_contents add constraint social_contents_status_check
  check (status in ('DRAFT','APPROVED','UPLOADING','PUBLISHING','PROCESSING','PUBLISHED','FAILED','REJECTED'));

alter table social_contents
  add column if not exists title         text,
  add column if not exists video_name    text,
  add column if not exists video_bytes   bigint,
  add column if not exists video_seconds numeric(8,2),
  add column if not exists upload        jsonb not null default '{}'::jsonb,  -- Meta upload session: video / container id, upload url
  add column if not exists error         text,
  add column if not exists created_by    text,
  add column if not exists updated_at    timestamptz not null default now();

create index if not exists social_contents_created_idx on social_contents (created_at desc);
create index if not exists social_publications_content_idx on social_publications (social_content_id);

drop policy if exists social_contents_admin_insert on social_contents;
create policy social_contents_admin_insert on social_contents for insert to authenticated with check (fp_is_admin(array['ADMIN']));
drop policy if exists social_contents_admin_update on social_contents;
create policy social_contents_admin_update on social_contents for update to authenticated using (fp_is_admin(array['ADMIN'])) with check (fp_is_admin(array['ADMIN']));
drop policy if exists social_publications_admin_insert on social_publications;
create policy social_publications_admin_insert on social_publications for insert to authenticated with check (fp_is_admin(array['ADMIN']));
drop policy if exists social_publications_admin_update on social_publications;
create policy social_publications_admin_update on social_publications for update to authenticated using (fp_is_admin(array['ADMIN'])) with check (fp_is_admin(array['ADMIN']));

create or replace function fp_social_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists social_contents_touch on social_contents;
create trigger social_contents_touch before update on social_contents for each row execute function fp_social_touch();

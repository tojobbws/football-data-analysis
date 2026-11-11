-- Rolls back 0057. Posts already made stay on Facebook / Instagram; their rows stay, but INSTAGRAM rows and the
-- upload statuses must go first or the old checks cannot come back.
drop trigger if exists social_contents_touch on social_contents;
drop function if exists fp_social_touch();
drop policy if exists social_contents_admin_insert on social_contents;
drop policy if exists social_contents_admin_update on social_contents;
drop policy if exists social_publications_admin_insert on social_publications;
drop policy if exists social_publications_admin_update on social_publications;
delete from social_publications where social_content_id in (select id from social_contents where channel = 'INSTAGRAM' or status in ('UPLOADING','PUBLISHING','PROCESSING','FAILED'));
delete from social_contents where channel = 'INSTAGRAM' or status in ('UPLOADING','PUBLISHING','PROCESSING','FAILED');
alter table social_contents drop constraint if exists social_contents_status_check;
alter table social_contents add constraint social_contents_status_check check (status in ('DRAFT','APPROVED','PUBLISHED','REJECTED'));
alter table social_contents drop constraint if exists social_contents_channel_check;
alter table social_contents add constraint social_contents_channel_check check (channel in ('TIKTOK','FACEBOOK','YOUTUBE_SHORTS','YOUTUBE','X','THREADS','LINE'));
alter table social_contents drop column if exists title, drop column if exists video_name, drop column if exists video_bytes,
  drop column if exists video_seconds, drop column if exists upload, drop column if exists error, drop column if exists created_by,
  drop column if exists updated_at;
drop index if exists social_publications_content_idx;

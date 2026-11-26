-- =====================================================================
-- 0064 oauth_tokens: sign-ins the server keeps for /admin/social (TikTok, ADR 0026)
--
--  * TikTok hands back a NEW refresh token on every refresh and the old one stops working, so it cannot live in a
--    fixed Worker secret: the latest one is kept here, with the current access token (2 h) so polls reuse it
--  * one row per provider; scripts/tiktok-setup.ts writes the first row after the owner signs in
--  * role ADMIN only, for read and write (EDITORs read social history but never the tokens); anon has no policy
-- Rollback: supabase/rollbacks/0064_rollback.sql
-- =====================================================================

create table if not exists oauth_tokens (
  provider            text primary key check (provider in ('TIKTOK')),
  account             text,                 -- display name of the signed-in account, shown in /admin/social
  open_id             text,
  scope               text,
  refresh_token       text        not null,
  refresh_expires_at  timestamptz not null,
  access_token        text,
  access_expires_at   timestamptz,
  updated_at          timestamptz not null default now()
);

alter table oauth_tokens enable row level security;

drop policy if exists oauth_tokens_admin_read on oauth_tokens;
create policy oauth_tokens_admin_read on oauth_tokens for select to authenticated using (fp_is_admin(array['ADMIN']));
drop policy if exists oauth_tokens_admin_insert on oauth_tokens;
create policy oauth_tokens_admin_insert on oauth_tokens for insert to authenticated with check (fp_is_admin(array['ADMIN']));
drop policy if exists oauth_tokens_admin_update on oauth_tokens;
create policy oauth_tokens_admin_update on oauth_tokens for update to authenticated using (fp_is_admin(array['ADMIN'])) with check (fp_is_admin(array['ADMIN']));

revoke all on oauth_tokens from anon;

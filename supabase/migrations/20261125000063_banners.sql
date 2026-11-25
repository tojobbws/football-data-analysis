-- =====================================================================
-- 0063 Home-page banners (owner, 2026-11-25; ADR 0024, .scratch/banners/spec.md)
--
-- Replaces the unused 0004 skeleton (banners / clicks / impressions, never written) with the agreed model:
--  * banners: one clickable picture pair (wide 1340x200, phone 1080x360) shown in up to three home-page slots,
--    chosen by priority inside its run period; flagged when it advertises gambling
--  * banner_clicks: one row per counted click (the /go/<id> redirect; known bots are not counted)
--  * site_settings: owner switches; 'hide_gambling_banners' hides every gambling banner at once, no deploy
-- Public (anon) reads only the banners that may show now; clicks are recorded through fp_banner_click().
-- Only role ADMIN writes. advertisers / campaigns / placements (0004) are left as they are.
-- Rollback: supabase/rollbacks/0063_rollback.sql
-- =====================================================================

do $$
begin
  if (select count(*) from banners) + (select count(*) from clicks) + (select count(*) from impressions) > 0 then
    raise exception '0063: the 0004 skeleton tables banners/clicks/impressions hold rows; move them by hand first';
  end if;
end $$;
drop table if exists impressions;
drop table if exists clicks;
drop table if exists banners;

create table if not exists banners (
  id               bigint generated always as identity primary key,
  name             text        not null check (length(trim(name)) > 0),
  image_wide_url   text        not null check (image_wide_url like 'https://%'),
  image_phone_url  text        not null check (image_phone_url like 'https://%'),
  alt_text         text        not null check (length(trim(alt_text)) > 0),
  target_url       text        not null check (target_url like 'https://%'),
  slots            text[]      not null check (cardinality(slots) > 0 and slots <@ array['home_top','home_league_1','home_league_2']),
  priority         int         not null default 0,
  starts_at        timestamptz not null default now(),
  ends_at          timestamptz,
  is_on            boolean     not null default true,
  is_gambling      boolean     not null default false,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);

create table if not exists banner_clicks (
  id          bigint generated always as identity primary key,
  banner_id   bigint      not null references banners(id) on delete cascade,
  clicked_at  timestamptz not null default now()
);
create index if not exists banner_clicks_banner_idx on banner_clicks (banner_id, clicked_at);

create table if not exists site_settings (
  key         text primary key,
  value       jsonb       not null,
  updated_at  timestamptz not null default now(),
  updated_by  text
);
insert into site_settings (key, value) values ('hide_gambling_banners', 'false') on conflict (key) do nothing;

alter table banners enable row level security;
alter table banner_clicks enable row level security;
alter table site_settings enable row level security;

create or replace function fp_gambling_banners_hidden() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from site_settings where key = 'hide_gambling_banners'), false)
$$;
revoke all on function fp_gambling_banners_hidden() from public;
grant execute on function fp_gambling_banners_hidden() to anon, authenticated;

-- a banner the site may show right now
create or replace function fp_banner_live(b banners) returns boolean
language sql stable set search_path = public as $$
  select b.is_on and b.starts_at <= now() and (b.ends_at is null or b.ends_at > now())
         and (not b.is_gambling or not fp_gambling_banners_hidden())
$$;
grant execute on function fp_banner_live(banners) to anon, authenticated;

drop policy if exists banners_public_read on banners;
create policy banners_public_read on banners for select to anon, authenticated using (fp_banner_live(banners));
drop policy if exists banners_admin_read on banners;
create policy banners_admin_read on banners for select to authenticated using (fp_is_admin());
drop policy if exists banners_admin_insert on banners;
create policy banners_admin_insert on banners for insert to authenticated with check (fp_is_admin(array['ADMIN']));
drop policy if exists banners_admin_update on banners;
create policy banners_admin_update on banners for update to authenticated using (fp_is_admin(array['ADMIN'])) with check (fp_is_admin(array['ADMIN']));
drop policy if exists banners_admin_delete on banners;
create policy banners_admin_delete on banners for delete to authenticated using (fp_is_admin(array['ADMIN']));

drop policy if exists banner_clicks_admin_read on banner_clicks;
create policy banner_clicks_admin_read on banner_clicks for select to authenticated using (fp_is_admin());

drop policy if exists site_settings_admin_read on site_settings;
create policy site_settings_admin_read on site_settings for select to authenticated using (fp_is_admin());
drop policy if exists site_settings_admin_update on site_settings;
create policy site_settings_admin_update on site_settings for update to authenticated using (fp_is_admin(array['ADMIN'])) with check (fp_is_admin(array['ADMIN']));

create or replace function fp_banners_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists banners_touch on banners;
create trigger banners_touch before update on banners for each row execute function fp_banners_touch();

-- /go/<id>: the destination of a banner that may show now (null otherwise); counts the click when p_count
create or replace function fp_banner_click(p_id bigint, p_count boolean default true) returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_target text;
begin
  select b.target_url into v_target from banners b where b.id = p_id and fp_banner_live(b);
  if v_target is not null and p_count then
    insert into banner_clicks (banner_id) values (p_id);
  end if;
  return v_target;
end $$;
revoke all on function fp_banner_click(bigint, boolean) from public;
grant execute on function fp_banner_click(bigint, boolean) to anon, authenticated;

-- /admin/banners: clicks per banner, all time and the last 7 days
create or replace function fp_admin_banner_clicks() returns table (banner_id bigint, total bigint, last_7d bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not fp_is_admin() then
    raise exception 'admin only';
  end if;
  return query
    select c.banner_id, count(*)::bigint, count(*) filter (where c.clicked_at > now() - interval '7 days')::bigint
    from banner_clicks c group by c.banner_id;
end $$;
revoke all on function fp_admin_banner_clicks() from public;
grant execute on function fp_admin_banner_clicks() to authenticated;

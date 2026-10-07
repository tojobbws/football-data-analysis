-- =====================================================================
-- 0015 ADMIN (back office)
-- Admins log in with Supabase Auth; the website keeps using the anon /
-- publishable key. What an admin may read or write is decided HERE by RLS:
-- being logged in is not enough, the user must be listed in admin_users.
-- (No service-role key is ever deployed with the website.)
-- =====================================================================

create table if not exists admin_users (
  user_id    uuid primary key,                 -- auth.users.id (no FK: keeps local test DBs without the auth schema working)
  email      text not null,
  role       text not null default 'ADMIN' check (role in ('ADMIN','EDITOR')),
  created_at timestamptz not null default now()
);
alter table admin_users enable row level security;

-- plpgsql resolves auth.uid() at call time, so this also installs on Postgres without Supabase's auth schema
create or replace function fp_uid() returns uuid
language plpgsql stable as $$
begin
  return auth.uid();
exception when undefined_function or invalid_schema_name then
  return null;
end $$;

create or replace function fp_is_admin(p_roles text[] default array['ADMIN','EDITOR']) returns boolean
language plpgsql stable security definer set search_path = public as $$
begin
  return exists (select 1 from admin_users a where a.user_id = fp_uid() and a.role = any(p_roles));
end $$;
revoke all on function fp_is_admin(text[]) from public;
grant execute on function fp_is_admin(text[]) to anon, authenticated;

drop policy if exists admin_users_self_read on admin_users;
create policy admin_users_self_read on admin_users for select to authenticated using (user_id = fp_uid());

-- ---------- admins READ internal tables ----------
do $$
declare
  t text;
begin
  foreach t in array array['sync_runs','analysis_runs','model_configs','ai_shadow_rankings','articles','social_contents',
                           'social_publications','advertisers','campaigns','banners','impressions','clicks','api_predictions'] loop
    execute format('drop policy if exists %I on %I', t || '_admin_read', t);
    execute format('create policy %I on %I for select to authenticated using (fp_is_admin())', t || '_admin_read', t);
  end loop;
end $$;

-- ---------- admins WRITE articles (CMS) ----------
drop policy if exists articles_admin_insert on articles;
create policy articles_admin_insert on articles for insert to authenticated with check (fp_is_admin());
drop policy if exists articles_admin_update on articles;
create policy articles_admin_update on articles for update to authenticated using (fp_is_admin()) with check (fp_is_admin());
drop policy if exists articles_admin_delete on articles;
create policy articles_admin_delete on articles for delete to authenticated using (fp_is_admin(array['ADMIN']));

create or replace function fp_articles_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'PUBLISHED' and new.published_at is null then new.published_at := now(); end if;
  return new;
end $$;
drop trigger if exists articles_touch on articles;
create trigger articles_touch before insert or update on articles for each row execute function fp_articles_touch();

-- ---------- dashboard numbers that need owner rights ----------
create or replace function fp_admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not fp_is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'odds_rows', (select count(*) from odds_history),
    'odds_bytes', pg_total_relation_size('odds_history'),
    'raw_bytes', pg_total_relation_size('api_raw_responses'),
    'published', (select count(*) from analysis_predictions),
    'pending', (select count(*) from analysis_predictions where status = 'PENDING'),
    'chain_ok', (select coalesce(bool_and(ok), true) from fp_verify_prediction_chain())
  );
end $$;
revoke all on function fp_admin_overview() from public;
grant execute on function fp_admin_overview() to authenticated;

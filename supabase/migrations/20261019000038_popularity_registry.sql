-- =====================================================================
-- 0038 popularity registry (slice 03): which teams, leagues and rivalries readers care about.
--
-- Edited by admins in /admin/registry, keyed by API-Football ids, read by the public site to ORDER
-- big matches and to find the Thai section. It never feeds a probability, an edge, a pick or the
-- featured list (see packages/shared/src/popularity.ts and its test).
-- season 0 = every season; a real season overrides it for that season.
-- Readable by everyone (it is configuration, not data about people); writable by admins only (RLS).
-- =====================================================================

create table if not exists team_popularity (
  team_id     bigint      not null references teams(id) on delete cascade,
  season      int         not null default 0,
  popularity  smallint    not null check (popularity between 0 and 100),
  note        text,
  updated_at  timestamptz not null default now(),
  primary key (team_id, season)
);

create table if not exists league_importance (
  league_id   bigint      not null references leagues(id) on delete cascade,
  season      int         not null default 0,
  importance  smallint    not null check (importance between 0 and 100),
  is_thai     boolean     not null default false,
  note        text,
  updated_at  timestamptz not null default now(),
  primary key (league_id, season)
);

create table if not exists rivalries (
  team_a_id   bigint      not null references teams(id) on delete cascade,
  team_b_id   bigint      not null references teams(id) on delete cascade,
  name        text        not null,
  weight      smallint    not null default 10 check (weight between 0 and 15),
  updated_at  timestamptz not null default now(),
  primary key (team_a_id, team_b_id),
  check (team_a_id < team_b_id)
);

do $$
declare
  t text;
begin
  foreach t in array array['team_popularity', 'league_importance', 'rivalries'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_read', t);
    execute format('create policy %I on %I for select to anon, authenticated using (true)', t || '_read', t);
    execute format('drop policy if exists %I on %I', t || '_admin_insert', t);
    execute format('create policy %I on %I for insert to authenticated with check (fp_is_admin())', t || '_admin_insert', t);
    execute format('drop policy if exists %I on %I', t || '_admin_update', t);
    execute format('create policy %I on %I for update to authenticated using (fp_is_admin()) with check (fp_is_admin())', t || '_admin_update', t);
    execute format('drop policy if exists %I on %I', t || '_admin_delete', t);
    execute format('create policy %I on %I for delete to authenticated using (fp_is_admin())', t || '_admin_delete', t);
    execute format('grant select on %I to anon, authenticated', t);
    execute format('grant insert, update, delete on %I to authenticated', t);
  end loop;
end $$;

create or replace function fp_registry_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists team_popularity_touch on team_popularity;
create trigger team_popularity_touch before update on team_popularity for each row execute function fp_registry_touch();
drop trigger if exists league_importance_touch on league_importance;
create trigger league_importance_touch before update on league_importance for each row execute function fp_registry_touch();
drop trigger if exists rivalries_touch on rivalries;
create trigger rivalries_touch before update on rivalries for each row execute function fp_registry_touch();

-- ---------------------------------------------------------------------
-- Starter values (the brief's list). Rows are inserted only for ids that exist in this database,
-- so a missing team or league is skipped instead of failing the migration. All editable in /admin/registry.
-- ---------------------------------------------------------------------
insert into team_popularity (team_id, popularity, note)
select t.id, v.p, v.note
from (values
  (541, 100, 'Real Madrid'), (529, 100, 'Barcelona'), (33, 100, 'Manchester United'), (40, 100, 'Liverpool'),
  (42, 95, 'Arsenal'), (50, 95, 'Manchester City'), (157, 95, 'Bayern München'), (85, 90, 'Paris Saint Germain'),
  (496, 90, 'Juventus'), (505, 85, 'Inter'), (489, 85, 'AC Milan'), (530, 80, 'Atletico Madrid'),
  (165, 80, 'Borussia Dortmund'), (49, 85, 'Chelsea'), (47, 80, 'Tottenham'), (492, 70, 'Napoli'),
  (168, 65, 'Bayer Leverkusen'), (211, 60, 'Benfica'), (212, 60, 'FC Porto'), (194, 60, 'Ajax'),
  (2939, 65, 'Al-Nassr'), (2932, 60, 'Al-Hilal Saudi FC'),
  (2780, 70, 'Buriram United'), (2769, 60, 'BG Pathum United'), (2789, 60, 'Port FC'),
  (2770, 55, 'Bangkok United'), (2786, 60, 'Muangthong United'), (2772, 50, 'Chonburi FC')
) as v(id, p, note)
join teams t on t.id = v.id
on conflict do nothing;

insert into league_importance (league_id, importance, is_thai, note)
select l.id, v.i, v.thai, v.note
from (values
  (2, 100, false, 'UEFA Champions League'), (3, 80, false, 'UEFA Europa League'), (848, 65, false, 'UEFA Conference League'),
  (5, 70, false, 'UEFA Nations League'), (39, 95, false, 'Premier League'), (140, 90, false, 'La Liga'),
  (135, 85, false, 'Serie A'), (78, 85, false, 'Bundesliga'), (61, 75, false, 'Ligue 1'),
  (40, 45, false, 'Championship'), (88, 50, false, 'Eredivisie'), (94, 50, false, 'Primeira Liga'),
  (307, 50, false, 'Saudi Pro League'), (98, 45, false, 'J1 League'), (253, 45, false, 'MLS'),
  (1129, 55, false, 'ASEAN Club Championship'), (296, 70, true, 'Thai League 1')
) as v(id, i, thai, note)
join leagues l on l.id = v.id
on conflict do nothing;

insert into rivalries (team_a_id, team_b_id, name, weight)
select least(v.a, v.b), greatest(v.a, v.b), v.name, v.w
from (values
  (541, 529, 'El Clásico', 15), (33, 40, 'North West derby', 15), (50, 33, 'Manchester derby', 12),
  (42, 47, 'North London derby', 12), (505, 489, 'Derby della Madonnina', 12), (157, 165, 'Der Klassiker', 12),
  (541, 530, 'Madrid derby', 12)
) as v(a, b, name, w)
where exists (select 1 from teams where id = v.a) and exists (select 1 from teams where id = v.b)
on conflict do nothing;

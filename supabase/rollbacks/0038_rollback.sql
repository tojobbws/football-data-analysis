-- Recovery plan for migration 0038 (popularity registry).
-- 0038 only CREATES team_popularity, league_importance, rivalries (+ policies, a touch function and its triggers)
-- and inserts the starter rows into them. It does not change any existing table or row.
-- Run only to undo it; editing done in /admin/registry since then is lost (copy first if it matters).
-- The site keeps working without the tables: it then shows no big-match or Thai section.
begin;
drop table if exists rivalries;
drop table if exists league_importance;
drop table if exists team_popularity;
drop function if exists fp_registry_touch();
delete from fp_schema_migrations where name = '20261019000038_popularity_registry.sql';
commit;

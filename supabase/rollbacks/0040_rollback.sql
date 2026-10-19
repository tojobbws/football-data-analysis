-- Recovery plan for migration 0040 (cup rules and qualification snapshots).
-- 0040 only CREATES competition_rules, qualification_snapshots and the view web_qualification, and seeds rules
-- for the UEFA club competitions. It changes no existing table or row.
-- The site and the hourly jobs keep working without them: the match page shows no qualification card
-- and the qualification job finds no rules and does nothing.
begin;
drop view if exists web_qualification;
drop table if exists qualification_snapshots;
drop table if exists competition_rules;
delete from fp_schema_migrations where name = '20261019000040_cup_rules_qualification.sql';
commit;

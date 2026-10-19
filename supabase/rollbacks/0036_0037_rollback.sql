-- Recovery plan for migrations 0036 (scoreline_snapshots) and 0037 (web_model_results).
-- Both migrations only CREATE new objects: they do not touch, alter or delete any existing table or row.
-- Run this only to undo them. It drops the snapshots collected since 0036 (take a copy first if they matter):
--   \copy (select * from scoreline_snapshots) to 'scoreline_snapshots.csv' csv header
-- Not in supabase/migrations/, so the migration runner never applies it.
begin;
drop view if exists web_model_calibration;
drop view if exists web_model_results;
drop view if exists web_model_result_rows;
drop table if exists scoreline_snapshots;
delete from fp_schema_migrations where name in ('20261019000036_scoreline_snapshots.sql', '20261019000037_web_model_results.sql');
commit;

-- Recovery plan for migration 0039 (API request budget).
-- 0039 adds two columns to sync_runs (requests_rejected, api_daily_remaining), two new tables
-- (api_budgets, api_job_groups), two functions and one index. No existing row or column is changed.
-- After this rollback, jobs run without a budget guard again (the code falls back when the tables are missing).
-- Dropping the two columns loses only what was recorded in them since 0039.
begin;
drop function if exists fp_admin_api_usage();
drop function if exists fp_api_usage_today();
drop table if exists api_job_groups;
drop table if exists api_budgets;
drop index if exists sync_runs_started_idx;
alter table sync_runs drop column if exists requests_rejected;
alter table sync_runs drop column if exists api_daily_remaining;
delete from fp_schema_migrations where name = '20261019000039_api_budget.sql';
commit;

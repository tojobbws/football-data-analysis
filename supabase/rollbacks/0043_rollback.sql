-- Recovery plan for migration 0043 (market benchmark, audit 2026-10-26).
-- 0043 only CREATES functions and views and REPLACES fp_admin_review(). It changes no table and no row.
-- After this rollback the site must run a build from before 0043: /performance reads
-- analysis_performance_by_match and web_benchmark_days.
-- fp_admin_review() goes back to its 0034 body: re-run the function part of
-- supabase/migrations/20261017000034_admin_review.sql (the create or replace function ... grant lines) in the same session.
begin;
drop view if exists web_benchmark_days;
drop view if exists analysis_performance_by_match;
drop function if exists fp_settle_selection(text, text, numeric, int, int);
drop function if exists fp_settle_asian(numeric, numeric);
drop function if exists fp_fair_y(text);
-- fp_fair_weight is used by fp_admin_review() from 0043: restore 0034's fp_admin_review() first, then drop it
-- drop function if exists fp_fair_weight(text);
drop function if exists fp_football_day(timestamptz);
delete from fp_schema_migrations where name = '20261026000043_market_benchmark.sql';
commit;

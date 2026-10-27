-- Recovery plan for migration 0048 (home page scorers index). No data changes; the page only gets slower.
begin;
drop index if exists player_season_stats_scorers_idx;
delete from fp_schema_migrations where name = '20261027000048_scorers_index.sql';
commit;

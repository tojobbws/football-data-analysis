-- Recovery plan for migration 0047 (Hybrid AI decisions).
-- First set the engine back to legacy (GitHub variable PICK_ENGINE=legacy): nothing then writes hybrid rows.
-- The SIGNAL check can only go back to requiring model_probability when no hybrid pick has been published;
-- published picks are part of the hash-chained record and are never deleted, so with hybrid picks published
-- this rollback keeps the relaxed check and keeps hybrid_decisions (the evidence behind those picks).
begin;
do $$
begin
  if exists (select 1 from analysis_predictions where decision_rule_version like 'hybrid-%') then
    raise notice 'hybrid picks are published: keeping hybrid_decisions and the relaxed check';
  else
    alter table analysis_predictions drop constraint if exists analysis_predictions_check;
    alter table analysis_predictions add constraint analysis_predictions_check
      check (kind = 'NO_CLEAR_SIGNAL' or (market is not null and selection is not null and model_probability is not null));
    drop table if exists hybrid_decisions;
    drop function if exists fp_hybrid_decision_before_insert();
    delete from fp_schema_migrations where name = '20261027000047_hybrid_ai_decisions.sql';
  end if;
end $$;
commit;

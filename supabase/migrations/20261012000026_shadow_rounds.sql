-- =====================================================================
-- 0026 shadow_decisions: lock the shadow pick at the publish rounds (shadow trial)
-- (see docs/adr/0003-shadow-trial.md)
--
-- The shadow decision was overwritten until kickoff, so it saw later data than the
-- real picks, which lock at EARLY and LINEUP. Now each evaluation overwrites one
-- LATEST row, and the publish job copies it to an EARLY / LINEUP row under the same
-- conditions as a real pick. A locked row is never changed, except that its closing
-- odds and CLV are filled in once after kickoff. The trial starts empty.
-- =====================================================================

truncate shadow_decisions;

alter table shadow_decisions add column if not exists publish_round text not null default 'LATEST'
  check (publish_round in ('LATEST','EARLY','LINEUP'));
alter table shadow_decisions add column if not exists locked_at    timestamptz;
alter table shadow_decisions add column if not exists closing_odds numeric(8,3);
alter table shadow_decisions add column if not exists clv          numeric(8,5);

alter table shadow_decisions drop constraint if exists shadow_decisions_pkey;
alter table shadow_decisions add primary key (fixture_id, rules_version, publish_round);

create or replace function fp_shadow_decision_guard() returns trigger
language plpgsql as $$
begin
  if old.publish_round = 'LATEST' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'UPDATE'
     and (to_jsonb(new) - 'closing_odds' - 'clv') = (to_jsonb(old) - 'closing_odds' - 'clv')
     and (old.closing_odds is null or new.closing_odds is not distinct from old.closing_odds)
     and (old.clv is null or new.clv is not distinct from old.clv) then
    return new;
  end if;
  raise exception 'locked shadow decision % / % is immutable', old.fixture_id, old.publish_round using errcode = 'P0001';
end $$;

drop trigger if exists shadow_decisions_locked on shadow_decisions;
create trigger shadow_decisions_locked
  before update or delete on shadow_decisions
  for each row execute function fp_shadow_decision_guard();

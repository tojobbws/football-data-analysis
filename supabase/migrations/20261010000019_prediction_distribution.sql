-- =====================================================================
-- 0019 analysis_predictions.model_distribution
-- The model's outcome distribution of the pick ({win, halfWin, push, halfLoss, loss}), so fan
-- pages can show "ถูก x% · เสมอตัว y% · ผิด z%" instead of the push-free fair probability alone.
-- Frozen after publish like the rest of the record, but NOT part of record_hash: the canonical
-- (and every existing hash) stays as it is. See docs/adr/0001-outcome-distribution-outside-hash.md.
-- =====================================================================

alter table analysis_predictions add column if not exists model_distribution jsonb;

-- backfill published picks from the candidate they were made from (runs before the freeze below)
update analysis_predictions p
   set model_distribution = c.factors->'distribution'
  from analysis_candidates c
 where c.id = p.candidate_id
   and p.model_distribution is null
   and jsonb_typeof(c.factors->'distribution') = 'object';

create or replace function fp_prediction_before_update() returns trigger
language plpgsql as $$
declare
  v_fixture_status text;
begin
  -- 1) published content is frozen
  if fp_prediction_canonical(new) is distinct from fp_prediction_canonical(old)
     or new.record_hash  is distinct from old.record_hash
     or new.prev_hash    is distinct from old.prev_hash
     or new.run_id       is distinct from old.run_id
     or new.candidate_id is distinct from old.candidate_id
     or new.model_distribution is distinct from old.model_distribution
     or new.created_at   is distinct from old.created_at
     or new.id           is distinct from old.id then
    raise exception 'published analysis % is immutable', old.public_id using errcode = 'P0001';
  end if;

  -- 2) closing-line data: write once
  if (old.closing_odds is not null and new.closing_odds is distinct from old.closing_odds)
     or (old.closing_line is not null and new.closing_line is distinct from old.closing_line)
     or (old.clv is not null and new.clv is distinct from old.clv) then
    raise exception 'closing data of % already recorded', old.public_id using errcode = 'P0001';
  end if;

  -- 3) settlement: PENDING -> final, exactly once
  if new.status is distinct from old.status then
    if old.status <> 'PENDING' then
      raise exception 'analysis % already settled as %', old.public_id, old.status using errcode = 'P0001';
    end if;
    if new.status not in ('WIN','HALF_WIN','LOSS','HALF_LOSS','PUSH','VOID') then
      raise exception 'invalid settlement status %', new.status using errcode = 'P0001';
    end if;
    select status_short into v_fixture_status from fixtures where id = old.fixture_id;
    if new.status <> 'VOID' and v_fixture_status not in ('FT','AET','PEN') then
      raise exception 'fixture % not finished (status %)', old.fixture_id, v_fixture_status using errcode = 'P0001';
    end if;
    new.settled_at := now();
  elsif new.settled_at is distinct from old.settled_at
        or new.result_score is distinct from old.result_score then
    raise exception 'settlement fields of % can only change together with status', old.public_id using errcode = 'P0001';
  end if;

  return new;
end $$;

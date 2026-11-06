-- Rolls back 0055. Run only before any DAILY row exists (the checks below refuse them otherwise):
--   select count(*) from analysis_predictions where publish_round = 'DAILY';  -- and hybrid_decisions, shadow_decisions
-- fp_admin_review() goes back to the 0053 definition (re-run the function of 20261103000053_featured_ai_v1.sql);
-- featured-ai-v2 rows stay in the table.
alter table analysis_predictions drop constraint if exists analysis_predictions_publish_round_check;
alter table analysis_predictions add constraint analysis_predictions_publish_round_check
  check (publish_round in ('EARLY','PREMATCH','LINEUP'));
alter table hybrid_decisions drop constraint if exists hybrid_decisions_publish_round_check;
alter table hybrid_decisions add constraint hybrid_decisions_publish_round_check
  check (publish_round in ('EARLY','PREMATCH','LINEUP'));
alter table shadow_decisions drop constraint if exists shadow_decisions_publish_round_check;
alter table shadow_decisions add constraint shadow_decisions_publish_round_check
  check (publish_round in ('LATEST','EARLY','LINEUP'));

drop policy if exists featured_selections_public_read on featured_selections;
create policy featured_selections_public_read on featured_selections
  for select to anon, authenticated
  using (version in ('featured-v2', 'featured-ai-v1') and rank is not null and phase in ('RESERVED','CONFIRMED'));

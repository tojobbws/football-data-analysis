-- Rolls back 0056. fp_admin_review() goes back to the 0055 definition (re-run the function of
-- 20261106000055_daily_pick_run.sql); featured-ai-v3 rows stay in the table, hidden from visitors.
drop policy if exists featured_selections_public_read on featured_selections;
create policy featured_selections_public_read on featured_selections
  for select to anon, authenticated
  using (version in ('featured-v2', 'featured-ai-v1', 'featured-ai-v2') and rank is not null and phase in ('RESERVED','CONFIRMED'));

-- Rolls back 0060. fp_admin_review() goes back to the 0056 definition (re-run the function of
-- 20261110000056_featured_ai_v3.sql); featured-ai-v4 rows stay in the table, hidden from visitors.
drop policy if exists featured_selections_public_read on featured_selections;
create policy featured_selections_public_read on featured_selections
  for select to anon, authenticated
  using (version in ('featured-v2', 'featured-ai-v1', 'featured-ai-v2', 'featured-ai-v3') and rank is not null and phase in ('RESERVED','CONFIRMED'));

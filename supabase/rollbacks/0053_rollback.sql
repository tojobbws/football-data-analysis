-- Rolls back 0053: visitors read featured-v2 only again. fp_admin_review() goes back to the 0043 definition
-- (re-run the function of 20261026000043_market_benchmark.sql); featured-ai-v1 rows stay in the table.
drop policy if exists featured_selections_public_read on featured_selections;
create policy featured_selections_public_read on featured_selections
  for select to anon, authenticated
  using (version = 'featured-v2' and rank is not null and phase in ('RESERVED','CONFIRMED'));

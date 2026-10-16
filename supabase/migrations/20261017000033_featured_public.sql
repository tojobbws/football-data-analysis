-- =====================================================================
-- 0033 featured_selections: fan pages read the daily list (ADR 0006)
--
-- featured-v2 goes on the site: only its slots that are in the list right now
-- (RESERVED with a rank, or CONFIRMED) are readable by visitors. featured-v1 and every
-- DROPPED / SKIPPED row stay admin-only, as before.
-- =====================================================================

create policy featured_selections_public_read on featured_selections
  for select to anon, authenticated
  using (version = 'featured-v2' and rank is not null and phase in ('RESERVED','CONFIRMED'));

-- Rolls back 0061. Only the admin read is removed; the stored Decisions answers stay (no data is deleted).
-- To hide the experiment completely, also run: revoke all on table decisions_shadow from authenticated, anon;
drop function if exists fp_admin_decisions_shadow(timestamptz, timestamptz);

-- Rolls back 0062. Only the admin read is removed; the stored Decisions v2 rows and their before-kickoff and
-- append-only triggers stay (no data is deleted). Stop the job first by unsetting the DECISIONS_V2 variable.
-- To hide the experiment completely, also run: revoke all on table decisions_v2 from authenticated, anon;
drop function if exists fp_admin_decisions_v2(timestamptz, timestamptz);

-- =====================================================================
-- 0010 FIX: Asian Handicap AWAY lines
--
-- API-Football quotes BOTH sides of an Asian Handicap with the HOME handicap:
--   "Home -0.5" (home -0.5)  <->  "Away -0.5" (= away +0.5)
-- Rows stored before this fix parsed "Away -0.5" as away -0.5, so `line` / `home_line`
-- of AWAY rows had the wrong sign and AH books were mis-paired.
--
-- The original API text (`raw_value`), odds and timestamps are untouched; only the two
-- DERIVED columns are recomputed from `raw_value`. Idempotent (always derived from raw_value).
-- The append-only guard is disabled only for this statement.
-- =====================================================================

alter table odds_history disable trigger odds_history_immutable;

update odds_history o
set home_line = s.v,
    line      = case when s.v = 0 then 0 else -s.v end
from (
  select id, nullif(trim(regexp_replace(raw_value, '^\s*Away\s*', '', 'i')), '')::numeric as v
  from odds_history
  where market = 'ASIAN_HANDICAP'
    and selection = 'AWAY'
    and raw_value ~* '^\s*Away\s*[+-]?[0-9]+(\.[0-9]+)?\s*$'
) s
where o.id = s.id
  and (o.home_line is distinct from s.v or o.line is distinct from case when s.v = 0 then 0 else -s.v end);

-- "Away" with no number = line 0
update odds_history
set home_line = 0, line = 0
where market = 'ASIAN_HANDICAP' and selection = 'AWAY' and raw_value ~* '^\s*Away\s*$'
  and (home_line is distinct from 0 or line is distinct from 0);

alter table odds_history enable trigger odds_history_immutable;

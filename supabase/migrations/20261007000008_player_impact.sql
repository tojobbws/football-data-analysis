-- =====================================================================
-- 0008 PLAYER IMPACT LAYER
-- * model_configs gets purpose 'IMPACT' (α calibrated on historical lineups)
-- * indexes for player-level lookups
-- Impact-adjusted prices are stored as probability_predictions rows with
-- model_version_id = 'dc-impact-v0.1' (base Dixon-Coles rows stay untouched).
-- =====================================================================

alter table model_configs drop constraint if exists model_configs_purpose_check;
alter table model_configs add constraint model_configs_purpose_check
  check (purpose in ('SIDES','TOTALS','ELO','ENSEMBLE','IMPACT'));

create index if not exists fixture_player_stats_team_idx on fixture_player_stats (team_id, fixture_id);
create index if not exists injuries_fixture_idx on injuries (fixture_id);

-- Readable view of who is missing per upcoming fixture (for content: 🩹 Injury Impact)
create or replace view player_impact_latest as
select distinct on (p.fixture_id)
  p.fixture_id, f.kickoff_at, f.league_id, f.home_team_id, f.away_team_id,
  p.computed_at,
  p.inputs -> 'impact' -> 'home' as home_impact,
  p.inputs -> 'impact' -> 'away' as away_impact,
  (p.inputs -> 'impact' ->> 'alpha')::numeric as alpha,
  (p.inputs -> 'impact' ->> 'enabled')::boolean as trusted
from probability_predictions p
join fixtures f on f.id = p.fixture_id
where p.model_version_id = 'dc-impact-v0.1' and p.inputs ? 'impact'
order by p.fixture_id, p.computed_at desc;

alter view player_impact_latest set (security_invoker = true);

-- =====================================================================
-- 0007 ANALYSIS RUNS (Phase 5 Candidate Generator)
-- One run = one evaluation of one fixture by the decision rules.
-- Runs are written complete (outcome + summary) and are immutable.
-- =====================================================================

alter table analysis_runs add column if not exists inputs  jsonb;
alter table analysis_runs add column if not exists summary jsonb;
create index if not exists analysis_runs_fixture_idx on analysis_runs (fixture_id, started_at desc);

drop trigger if exists analysis_runs_immutable on analysis_runs;
create trigger analysis_runs_immutable before update or delete on analysis_runs
  for each row execute function fp_reject_change();

-- Latest decision per fixture (what the system currently "thinks", before publishing)
create or replace view analysis_latest_decision as
select distinct on (r.fixture_id)
  r.id as run_id, r.fixture_id, f.kickoff_at, f.league_id, f.home_team_id, f.away_team_id,
  r.outcome, r.decision_rule_version, r.model_version_id, r.started_at,
  c.id as candidate_id, c.market, c.selection, c.line, c.odds,
  c.model_probability, c.market_probability, c.edge, c.support_score,
  c.factors ->> 'strength' as strength,
  r.summary
from analysis_runs r
join fixtures f on f.id = r.fixture_id
left join analysis_candidates c on c.run_id = r.id and c.rank = 1
order by r.fixture_id, r.started_at desc, r.id desc;

alter view analysis_latest_decision set (security_invoker = true);
alter table analysis_runs enable row level security;
drop policy if exists analysis_runs_public_read on analysis_runs;
create policy analysis_runs_public_read on analysis_runs for select to anon, authenticated using (true);

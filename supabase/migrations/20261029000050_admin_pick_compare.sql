-- =====================================================================
-- 0050 Admin: what the rules and the Hybrid AI chose, per day (read-only)
--
-- hybrid_decisions is internal (RLS on, no policy). This admin-only function returns, for the fixtures
-- kicking off in [p_from, p_to), the latest Hybrid AI decision of each publish round with the legacy rules'
-- decision of the same moment (hybrid_decisions.legacy), the fixture's score and whether the decision
-- was published. The big `input` column is left out. Nothing is written.
-- =====================================================================

create or replace function fp_admin_pick_compare(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not fp_is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(x.r order by x.r->>'kickoff_at', x.r->>'round')
      from (
        select jsonb_build_object(
                 'fixture_id',  f.id,
                 'slug',        f.slug,
                 'kickoff_at',  f.kickoff_at,
                 'status_short', f.status_short,
                 'home',        th.name,
                 'away',        ta.name,
                 'goals_home',  coalesce(f.ft_home, f.goals_home),
                 'goals_away',  coalesce(f.ft_away, f.goals_away),
                 'round',       d.publish_round,
                 'decided_at',  d.decided_at,
                 'engine_version', d.engine_version,
                 'ai_status',   d.status,
                 'side',        d.side,
                 'market',      d.market,
                 'selection',   d.selection,
                 'line',        d.line,
                 'odds',        d.odds,
                 'confidence',  d.confidence,
                 'summary_th',  d.summary_th,
                 'legacy',      d.legacy,
                 'published',   exists (select 1 from analysis_predictions p
                                         where p.fixture_id = d.fixture_id and p.publish_round = d.publish_round
                                           and p.decision_rule_version like 'hybrid-%')
               ) as r
          from (
            select distinct on (h.fixture_id, h.publish_round) h.*
              from hybrid_decisions h
              join fixtures ff on ff.id = h.fixture_id
             where ff.kickoff_at >= p_from and ff.kickoff_at < p_to
             order by h.fixture_id, h.publish_round, h.decided_at desc
          ) d
          join fixtures f on f.id = d.fixture_id
          join teams th on th.id = f.home_team_id
          join teams ta on ta.id = f.away_team_id
      ) x
  ), '[]'::jsonb);
end $$;
revoke all on function fp_admin_pick_compare(timestamptz, timestamptz) from public;
grant execute on function fp_admin_pick_compare(timestamptz, timestamptz) to authenticated;

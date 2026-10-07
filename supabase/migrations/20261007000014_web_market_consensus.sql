-- =====================================================================
-- 0014 WEB: public market consensus (📈 แรงตลาด) without raw odds
-- odds_history stays private (per-bookmaker quotes are never public).
-- The website reads only this aggregate: per selection, the median of each
-- bookmaker's first and last pre-kickoff quote, plus how many bookmakers.
--
-- This view intentionally runs with the owner's rights (NOT security_invoker)
-- so it can read odds_history; anon gets SELECT on the aggregate only.
-- =====================================================================

create or replace view web_market_consensus as
with q as (
  select o.fixture_id, o.bookmaker_id, o.market, o.selection, o.line, o.odds, o.source_updated_at,
         row_number() over (partition by o.fixture_id, o.bookmaker_id, o.api_bet_id, o.raw_value order by o.source_updated_at asc)  as rn_first,
         row_number() over (partition by o.fixture_id, o.bookmaker_id, o.api_bet_id, o.raw_value order by o.source_updated_at desc) as rn_last
  from odds_history o
  join fixtures f on f.id = o.fixture_id
  where o.source_updated_at < f.kickoff_at
    and o.market in ('MATCH_WINNER','ASIAN_HANDICAP','OVER_UNDER')
)
select
  fixture_id,
  market,
  selection,
  line,
  count(*) filter (where rn_last = 1)::int                                                     as bookmakers,
  round(percentile_cont(0.5) within group (order by odds) filter (where rn_first = 1)::numeric, 3) as opening_odds,
  round(percentile_cont(0.5) within group (order by odds) filter (where rn_last = 1)::numeric, 3)  as current_odds,
  min(source_updated_at)                                                                       as first_quote_at,
  max(source_updated_at)                                                                       as last_quote_at
from q
group by fixture_id, market, selection, line;

-- Supabase grants anon/authenticated ALL on new relations by default: read-only here.
revoke all on web_market_consensus from anon, authenticated;
grant select on web_market_consensus to anon, authenticated;

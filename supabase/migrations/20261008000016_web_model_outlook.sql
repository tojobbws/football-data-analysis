-- =====================================================================
-- 0016 WEB: 📊 มุมมองโมเดล (model outlook) — model probabilities as information,
-- separate from 🧭 (a pick needs market odds; API-Football has none for e.g. Thai League 1).
--
-- Per fixture: the LAST probabilities computed BEFORE kickoff (nothing after kickoff ever counts)
--   1X2  = ensemble if the league has one, else Dixon-Coles
--   O/U  = Dixon-Coles OVER 2.5
--   *_tested = the league's latest tuned config for that market is enabled (passed `model:tune`);
--              false -> the site shows a ⚠️ "not tested" warning
-- Model version ids are spelled out here; bump them together with packages/analysis.
--
-- Owner's rights (NOT security_invoker): probability_predictions and model_configs stay private,
-- anon only gets SELECT on these views.
-- =====================================================================

create or replace view web_model_outlook as
with pre as (
  select p.fixture_id, p.model_version_id, p.computed_at, p.market, p.selection, p.probability, f.league_id
  from probability_predictions p
  join fixtures f on f.id = p.fixture_id
  where p.computed_at < f.kickoff_at
    and (
      (p.market = 'MATCH_WINNER' and p.model_version_id in ('ensemble-v0.1', 'dixon-coles-v0.2'))
      or (p.market = 'OVER_UNDER' and p.selection = 'OVER' and p.line = 2.5 and p.model_version_id = 'dixon-coles-v0.2')
    )
),
side_model as (
  select fixture_id, case when bool_or(model_version_id = 'ensemble-v0.1') then 'ensemble-v0.1' else 'dixon-coles-v0.2' end as model_version_id
  from pre where market = 'MATCH_WINNER'
  group by fixture_id
),
latest as (
  select pre.*, row_number() over (partition by pre.fixture_id, pre.market, pre.selection order by pre.computed_at desc) as rn
  from pre
  left join side_model s on s.fixture_id = pre.fixture_id
  where pre.market = 'OVER_UNDER' or pre.model_version_id = s.model_version_id
),
cfg as (
  select distinct on (league_id, purpose) league_id, purpose, enabled
  from model_configs
  order by league_id, purpose, tuned_at desc
)
select
  l.fixture_id,
  max(l.league_id)                                                                   as league_id,
  max(s.model_version_id)                                                            as model_version_id,
  max(l.computed_at) filter (where l.market = 'MATCH_WINNER')                        as computed_at,
  max(l.probability) filter (where l.market = 'MATCH_WINNER' and l.selection = 'HOME') as p_home,
  max(l.probability) filter (where l.market = 'MATCH_WINNER' and l.selection = 'DRAW') as p_draw,
  max(l.probability) filter (where l.market = 'MATCH_WINNER' and l.selection = 'AWAY') as p_away,
  max(l.probability) filter (where l.market = 'OVER_UNDER')                          as p_over25,
  coalesce(bool_or(c1.enabled), false)                                               as sides_tested,
  coalesce(bool_or(c2.enabled), false)                                               as totals_tested
from latest l
left join side_model s on s.fixture_id = l.fixture_id
left join cfg c1 on c1.league_id = l.league_id and c1.purpose = (case when s.model_version_id = 'ensemble-v0.1' then 'ENSEMBLE' else 'SIDES' end)
left join cfg c2 on c2.league_id = l.league_id and c2.purpose = 'TOTALS'
where l.rn = 1
group by l.fixture_id;

revoke all on web_model_outlook from anon, authenticated;
grant select on web_model_outlook to anon, authenticated;

-- ---------------------------------------------------------------------
-- How the outlook did on finished matches (90-minute result), split by tested / not tested.
--   1X2: "pick" = highest probability; expected = average of that probability (calibration in one number)
--   O/U 2.5: side with probability >= 0.5
-- ---------------------------------------------------------------------
create or replace view web_model_outlook_performance as
with r as (
  select o.*,
         case when coalesce(f.ft_home, f.goals_home) > coalesce(f.ft_away, f.goals_away) then 'HOME'
              when coalesce(f.ft_home, f.goals_home) < coalesce(f.ft_away, f.goals_away) then 'AWAY'
              else 'DRAW' end                                               as result,
         coalesce(f.ft_home, f.goals_home) + coalesce(f.ft_away, f.goals_away) as total_goals,
         greatest(o.p_home, o.p_draw, o.p_away)                              as p_top,
         case when o.p_home >= o.p_draw and o.p_home >= o.p_away then 'HOME'
              when o.p_away >= o.p_draw then 'AWAY' else 'DRAW' end          as top
  from web_model_outlook o
  join fixtures f on f.id = o.fixture_id
  where f.status_short in ('FT', 'AET', 'PEN')
    and coalesce(f.ft_home, f.goals_home) is not null
    and o.p_home is not null
)
select
  sides_tested                                                              as tested,
  count(*)::int                                                             as matches,
  count(*) filter (where top = result)::int                                 as correct,
  round(avg(p_top)::numeric, 4)                                             as expected_rate,
  count(*) filter (where p_over25 is not null)::int                         as ou_matches,
  count(*) filter (where p_over25 is not null and (p_over25 >= 0.5) = (total_goals > 2.5))::int as ou_correct,
  round(avg(greatest(p_over25, 1 - p_over25)) filter (where p_over25 is not null)::numeric, 4)  as ou_expected_rate
from r
group by sides_tested;

revoke all on web_model_outlook_performance from anon, authenticated;
grant select on web_model_outlook_performance to anon, authenticated;

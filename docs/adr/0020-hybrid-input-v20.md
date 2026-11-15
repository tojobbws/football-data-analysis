# Hybrid AI input v2.0: the owner's list of added context, then frozen until 100 settled picks

Status: accepted by the owner on 2026-11-15. Prompt `hybrid-ai-v2.0`, engine version unchanged (`hybrid-ai-v1`). No migration. Live from the 14:00 Thai daily pick run of 16 Nov 2026.

## Problem

The owner asked which data we hold that the AI does not see, then which values we could compute from it. The audit of 15 Nov found that the input (v1.9) leaves out:
- the market's movement
- the state of a two-legged tie
- the stakes in the table, and the season home and away record
- red cards in recent matches
- how much an injured player matters
- head to head, derby and neutral venue
- the other match statistics
- API-Football's own prediction

It also found values we could compute and store that no input carries:
1. a team's results and xG against the closing market
2. Elo ratings
3. a red-card flag per match
4. the share of goals and minutes missing through injury
5. line movement
6. starters' workload
7. table stakes
8. the two-legged tie state

The owner chose to add all of it at once, not one at a time, and to stop changing the prompt afterwards. The change is then judged on 100 settled picks.

## Decision

**Input v2.0.** Everything is read or computed by us from stored data, as of the decision time. No API call.

| block | where | source |
|---|---|---|
| possession, corners, yellow cards, minutes of each red card | each recent match; window averages and counts | `fixture_statistics`, `fixture_events` |
| results against the closing market: the team's closing handicap line, goal difference + line, xG difference + line, the same for totals | each recent match; window `vs_closing_market` | `market_closing` (kept from 2026-10-04, tracked leagues only) |
| Elo before each recent match (team and opponent), current ratings, difference, home expected score | recent matches; `elo_ratings` | every stored result (65,108 on 15 Nov), elo-v0.1 settings (K 20, home advantage 60), one book per run |
| table zone and stakes: zone, nearest better and worse zone with points between, leader's gap, league matches left | `table_context.stakes` | `standings`, `fixtures` |
| season home and away record | `table_context` | `standings.home` / `standings.away` |
| injured players' season figures (appearances, minutes, goals, assists, average rating, share of team goals and minutes); team share missing | `injuries[].season_figures`, `absences` | `fixture_player_stats` (the analysed competition's season, every stored competition) |
| starters' workload: minutes in the 7 and 14 days before kickoff, with how many matches have complete player minutes | `starters_workload` | `fixture_player_stats` |
| market movement: main lines and 1X2 chances at the opening, 24 hours ago and now, with the changes | `market.movement` | `odds_history` (first stored quotes + 30 minutes) |
| stage, neutral venue, derby name, two-legged tie (leg, first-leg score, aggregate, the home margin that levels it), head to head (last 5) | `match_context` | `competition_rules`, `rivalries` (name only), `fixtures` |
| API-Football's prediction: percentages, predicted winner, advice, goals hint | `api_football_prediction` | `api_predictions` (collected before the decision) |

**The prompt.** It explains each value and what it is for, in `HYBRID_V20_GUIDE`. The cautions it states:
- head to head is weak
- a derby is a reason for caution, not a direction
- Elo is rough between clubs of different countries
- a match played with ten men is discounted
- results against the line are noisy; xG against the line is steadier
- movement is what the market learned, not an order to follow
- API-Football's prediction is a third party's opinion, never evidence on its own

The Over/Under rule of v1.9, the number guard and the three-answer majority are unchanged.

**What is stored.** The full input, with every computed value, is kept in `hybrid_decisions.input` as before. That is the store of these values per decision: no new table.

**The derby and the popularity rule.** CONTEXT.md kept the popularity registry (team popularity, league importance, rivalries) out of every pick. The owner asked for the derby, so the input carries the rivalry's name only. Its weight and the popularity scores stay out. The guard test (`packages/shared/test/popularity.test.ts`) no longer forbids `rivalries`, and still forbids the rest.

**API-Football's prediction and ADR 0013.** ADR 0013 took the Dixon-Coles voice out because it was biased and added nothing beside the market. API-Football's prediction is another such voice. It is added because the owner asked for it, and it is marked in the prompt as an opinion only. Whether it helps or hurts is part of the review below.

## Measured before going live (read-only, 15 Nov)

- The 22 matches of the 16 Nov pick day (all national teams) built without error.
- The input grew from 12–16k to 22–31k characters. One answer took about 12,800 input tokens; the extra cost is roughly 70% per decision.
- Building the input took about 1 s more per match, plus about 5 s once per run for the Elo book. The 22 matches took 41 s in all.
- One live answer each for Kazakhstan–Slovakia and Manchester City–Fulham passed validation (number guard included), and the text used Elo, the results against the closing line, the season home record and the movement.
- Gaps seen:
  - The provider leaves some player minutes out (95.5% of starters in the last 14 days have them; Sudan's last match had 4 of 11). The workload block says so.
  - National teams have few rated matches and thin head to head.
  - Closing lines exist only from 2026-10-04.

## Consequences

- **Frozen.** No change to the prompt or the input until 100 settled DAILY picks from v2.0, unless the owner decides otherwise. Then compare v2.0 with v1.8–v1.9 at the same review:
  - fair hit rate with its 95% interval
  - CLV
  - the share of no-picks
  - Use `npx tsx scripts/hybrid-shadow-report.ts --from 2.0` and `/admin/review`.
- The v1.8 club handicap freeze of ADR 0019 ends here at the owner's request; v1.8–v1.9 and v2.0 are counted apart by prompt version.
- A v2.0 pick may differ from what v1.9 would have chosen on the same match: the input of every decision changed.
- No redo: matches already decided keep their pick (ADR 0014).
- Rollback: pass `v20: false` in the hybrid job's `collectHybridInput` call and set the prompt version back. Stored decisions are untouched.

## Amendment, 2026-11-15: Over/Under is published again

The owner chose to publish the AI's Over/Under choices again from v2.0, instead of keeping them as shadow until 30
settled decisions (ADR 0019 amendment 2). Both markets are then judged together at the same review: 100 settled v2.0
picks, Over/Under and handicap each also read on its own row.

- `HYBRID_PUBLISHED_MARKETS` = `['ASIAN_HANDICAP', 'OVER_UNDER']`; `hybridShadowReason` returns null for both.
- An Over/Under pick is again a pick like any other: it shows on the site, and it can enter the featured list,
  previews, pick notes and films where their own rules allow (MEDIUM or higher for the list).
- The Over/Under rule of prompt v1.9 stays in the prompt: a total needs both teams' chance figures to agree.
- Known risk, stated before the review: the 28 Over/Under decisions of v1.6–v1.7 went 8-19-1 (fair hit 28.8%,
  market expected 50.7%). Most misses came from the fixed 2.5 count fixed in v1.8. Too few Over/Under decisions of
  v1.8–v1.9 had settled by this date to tell whether the fixes work.
- Rollback: take `OVER_UNDER` out of `HYBRID_PUBLISHED_MARKETS`.

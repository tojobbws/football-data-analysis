# The pick day's featured list takes the UEFA Nations League: featured-ai-v3

Status: accepted by the owner on 2026-11-10. Replaces `featured-ai-v2` (ADR 0014) for new pick days. Keeps every other rule of ADR 0012 and ADR 0014.

## Problem

Every featured version so far leaves the national-team competitions out (`excludedLeagues` 5, 536, 36, 7). In an international window the tracked club leagues hardly play, so the list goes empty. For the window of 10 to 19 November 2026 the production schedule held, per pick day, 0 club matches the list could take on 10, 11, 12, 13, 15, 16 and 17 November (3 on the 14th, 7 and 2 on the 18th and 19th), while the Nations League plays 52 matches from 12 to 17 November, every one with market odds in `odds_history`. No list means no spotlight film and no recap the next day.

The Hybrid AI already picks national-team matches like any other (no league filter in `pickFixtures`). Only the featured list leaves them out.

## Decision

- **`featured-ai-v3`** = `featured-ai-v2` with the UEFA Nations League (5) in scope. Its excluded leagues are Thai League 1 (296), the ASEAN Club Championship (1129), the CONCACAF Nations League (536), the AFCON qualifiers (36) and the Asian Cup (7).
- **Nations League cap: 5 a day** (`leagueCaps`), in place of the cap of 2 per league. The owner chose it: the competition is one league id for many groups and four divisions, and on a window day it is most of what plays. Every other league keeps 2, and the day keeps 5.
- Order, pool and choice are unchanged: AI confidence MEDIUM or higher, then the big five, fewer data gaps, earlier kick-off; chosen once after the daily run and confirmed at once.
- **One list per pick day.** `featured-ai-v3` gives no list to a pick day that `featured-ai-v2` (or any other chosen-once version) already listed, so the switch day keeps the list it had.
- Per ADR 0004 a new version starts its count again. `featured-ai-v2` had 15 confirmed matches over 3 pick days (6 to 8 November), so little is lost.
- The comparison group of the report and of `fp_admin_review()` follows the version's own excluded leagues: for `featured-ai-v3` every Hybrid AI pick of the period outside 296, 1129, 536, 36 and 7. The earlier versions keep theirs.

## Considered options

- **Add the Nations League to `featured-ai-v2` in place.** Rejected: it changes a frozen version's rules mid-count (ADR 0004).
- **A separate national-team list beside ai-v2.** Its count would stay apart from the club list. Rejected for now: a second list on the site and in the films for a few days a window.
- **A video of the big national-team matches without a list.** Gives the content, but the site's list stays empty on those days.
- **The other national-team competitions too.** Rejected for now: the AFCON qualifiers and the CONCACAF Nations League had no odds rows in the window, so the Hybrid AI would answer NO_PICK for want of a main line.

## Consequences

- National-team picks have no track record yet (0 published before this window), and their input is thinner than a club match's. The Nations League has no injury rows in the database (`injuries_coverage` reads `unavailable_for_league`). Teams have about 4 recent results each, from `sync:support`. The AI gets no rank for opponents, as with any league played in groups. The 12 to 17 November matches are group matchdays 5 and 6, where a team that is already through or out may rotate, and nothing in the input says so. The AI's own confidence is the only gate, and the data gaps rank it below the big five.
- On a window day the list may be mostly or only Nations League matches.
- The spotlight and recap scripts read `featured-ai-v3` first. `league_importance` already holds the Nations League (70), so the film's league order needs no change.
- The verdict of ADR 0004 for `featured-ai-v3` counts national-team and club selections together. The report can split them by league if the owner wants to see them apart.

## Rollout

1. Migration 0056 (the visitors' read policy and `fp_admin_review()` for `featured-ai-v3`), before the code reaches main.
2. Merge, push and deploy the web (the gold frame, /performance and the admin review read the new version).
3. The next hourly `featured` run after the deploy chooses the next unlisted pick day's list with `featured-ai-v3`. To catch the Nations League from 12 November, this must be live before 14:00 Thai on 12 November.
4. Rollback: point the `featured` job back at `FEATURED_AI_V2` and redeploy. `featured-ai-v3` rows stay in the table; supabase/rollbacks/0056_rollback.sql hides them from visitors.

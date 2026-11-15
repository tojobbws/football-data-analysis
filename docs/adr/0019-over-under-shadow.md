# Over/Under and national-team matches go to shadow; the AI input is corrected

Status: accepted by the owner on 2026-11-15. Prompt `hybrid-ai-v1.8`. No migration.
**Amended the same day:** the national-team shadow is withdrawn (see "Amendment, 2026-11-15" at the end). The
Over/Under shadow and the input fixes stand.

## Problem

The owner asked why the AI took Sweden −1 against Bosnia (14 Nov, 3–2: a push) instead of a high-scoring game, and
then asked for a full audit of the analysis conditions. Four weaknesses came out.

1. **The input counted totals at a fixed 2.5.** Every window carried `total_goals_over: { line: 2.5 }`, whatever
   the market's main line was. That night the line was 3. The AI wrote "the market set the line at 3 goals, not 2.5"
   as a point against Over: it had no count at the line it was judging.
2. **The Hybrid AI's Over/Under record is poor, while its handicap record is not.**
3. **National-team matches give the AI almost nothing to work with.** DAILY inputs, 2026-11-15:

   | in the input | clubs (189) | national teams (65) |
   |---|---|---|
   | days the 10 recent matches span | 75 | 389 |
   | recent matches without xG | 14% | 85% |
   | recent matches without the opponent's table position | 29% | 100% |
   | friendlies among recent matches | 0% | 19% |

4. **Rest days and fixture congestion were wrong in two ways:**
   - **Measured to the wrong moment.** `rest_days_before_this_match` and `recent_congestion` were counted to the
     decision time, not the kickoff. Under the daily pick run (ADR 0014) a decision comes up to a day before the
     match, about 10 hours on average.
   - **Missing cup matches.** The FA Cup, DFB-Pokal, Coppa Italia, Coupe de France, KNVB Beker and Taça de Portugal
     are not in the database. A team's midweek cup match in them is missing from its recent matches, rest days and
     congestion, and the input did not say so.

The record behind points 2 and 3: DAILY decisions from prompt v1.6 (production, read-only, 2026-11-15,
`scripts/hybrid-shadow-report.ts --from 1.6`). Fair hit leaves pushes out and counts a half outcome as half:

| group | settled | won-lost-push | fair hit | 95% interval | market expected |
|---|---|---|---|---|---|
| Asian handicap, clubs | 74 | 40-31-3 | 55.2% | 42.9–67.5% | 50.2% |
| Asian handicap, national teams | 25 | 12-11-2 | 52.3% | 31.4–73.1% | 50.6% |
| Over/Under, all | 28 | 8-19-1 | 28.8% | 11.4–46.3% | 50.7% |

The Over/Under interval lies below what the market expects. The national-team shadow rests on the thin input, not on
their record, which is too small to judge. No handicap figure is proof of an edge.

## Decision

**Input, prompt v1.8:**
- `total_goals_vs_line` replaces `total_goals_over`:
  - It counts each window's 90-minute totals over, exactly on (whole lines only, where that total is a push) and
    under the market's main over/under line.
  - With no usable over/under line, it falls back to 2.5, and `data_quality.total_goals_vs_line` says so.
  - The prompt says to judge Over and Under on that count, never on a count at another total.
- `rest_days_before_this_match` and `recent_congestion` (14 days) are counted to the kickoff.
- `data_quality.recent_matches_scope` says a team's matches in competitions we do not store are missing. These are
  most domestic cups. The prompt says to treat a long rest or a quiet schedule as uncertain.

**Shadow decisions** (`hybridShadowReason` in the publish job):
- The shadow covers:
  - an Over/Under choice (`HYBRID_PUBLISHED_MARKETS = ['ASIAN_HANDICAP']`)
  - any choice in a national-team competition (`NATIONAL_TEAM_COMPETITIONS`: UEFA Nations League, CONCACAF Nations
    League, AFCON qualification, Asian Cup)
- The AI still decides these matches, and its decision is stored in `hybrid_decisions` as before.
- The round publishes a no-pick with its own fixed line of text. The AI's own text for that choice is not published.
- Fog stays off the fan pages, so fans see no pick for these matches.
- Featured lists, previews, pick notes and films read only published picks, so these matches drop out of them too.
  The UEFA Nations League place in the featured list (ADR 0015) is therefore empty until the review below.

**Measurement:**
- `npx tsx scripts/hybrid-shadow-report.ts` settles the shadow decisions on the 90-minute score. It sets them beside
  the published club handicap picks of the same prompts.
- `/admin/picks` keeps showing each day's AI decision, published or not.

**The club handicap pick is frozen for measurement from v1.8.** No prompt change to it before the review, unless the
owner decides otherwise.

## Consequences

**Review at 100 settled decisions in each shadow group.** A group comes back to the site only if its fair hit beats
the market's expectation over those decisions. At the same review:
- read the club handicap record of v1.8 with a 95% interval
- read its CLV (DAILY handicap picks beat the close 58 of 92 times up to 2026-11-15)

National-team matches come only in international windows, so that group fills slowly.

**Fewer published picks per day.** Two kinds of AI pick no longer reach the site:
- Over/Under, about a fifth of the AI's picks since v1.6
- every pick on a national-team matchday

The AI is not asked for another choice in their place, so those matches show no pick.

**A v1.8 club handicap pick may differ from v1.7.** The input of every decision changed.

**Rollback:**
- Over/Under: add `OVER_UNDER` back to `HYBRID_PUBLISHED_MARKETS`.
- National teams: drop the national-team check in `hybridShadowReason`.

**Still open:**
- Storing the missing domestic cups would cost API calls under the sync cap.
- The national-team input would need a measure of opponent strength. API-Football's data has none we use today.

## Amendment, 2026-11-15: national-team picks are published again

The first v1.8 daily run (14:00 Thai, 15 Nov) fell in an international window: all nine matches were national-team
games, so the site had no pick and no featured list that day. The owner chose to publish national-team picks again.

- `hybridShadowReason` now takes the market only. Over/Under is still shadow; a national-team handicap pick is
  published like a club one and can enter the featured list where ADR 0015/0018 allow it (UEFA Nations League only,
  MEDIUM confidence or higher).
- The DAILY rounds already published on 15 Nov stay as they are: `analysis_predictions` rejects updates and deletes.
  At the owner's request the same afternoon, `scripts/oneoff-national-early-2026-11-15.ts` added an EARLY round to
  the four matches whose handicap choice had been shadowed. The AI decided them afresh at 15:36 Thai, and two picks
  came out: Montenegro −0.25 and Türkiye +2.25. Belarus–Albania came out a no-pick, and Panama–Curaçao an
  Over/Under shadow. The pick day's featured list was then chosen from those two picks. From the 16 Nov run on,
  national picks go out through the normal DAILY round.
- The thin national-team input above still holds, and so does the caution: their record (52.3%, n=25 up to
  15 Nov) proves nothing either way. `scripts/hybrid-shadow-report.ts` keeps "AH national" as its own row, so the
  group is still measured apart; read it at 100 settled decisions with the club review.

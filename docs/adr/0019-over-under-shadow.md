# Over/Under goes to shadow; the AI reads totals at the market's own line

Status: accepted by the owner on 2026-11-15. Prompt `hybrid-ai-v1.8`. No migration.

## Problem

The owner asked why the AI took Sweden −1 against Bosnia (14 Nov, 3–2: a push) instead of a high-scoring game. The
decision showed two things.

1. **The input counted totals at a fixed 2.5.** Every window carried `total_goals_over: { line: 2.5 }`, whatever
   the market's main line was. That night the line was 3. The AI wrote "the market set the line at 3 goals, not 2.5"
   as a point against Over: it had no count at the line it was judging.
2. **The Hybrid AI's Over/Under record is poor, while its handicap record is not.** DAILY decisions from prompt v1.6
   (production, read-only, 2026-11-15, `scripts/hybrid-ou-shadow-report.ts --from 1.6`). Fair hit leaves pushes out
   and counts a half outcome as half:

| group | settled | won-lost-push | fair hit | 95% interval | market expected |
|---|---|---|---|---|---|
| Asian handicap | 99 | 52-42-5 | 54.4% | 43.8–65.1% | 50.3% |
| Over/Under | 28 | 8-19-1 | 28.8% | 11.4–46.3% | 50.7% |
| Over | 15 | 5-10-0 | 34.5% | | 51.3% |
| Under | 13 | 3-9-1 | 21.7% | | 49.9% |

The Over/Under sample is small, but its interval lies below what the market expects. Neither handicap figure is
proof of an edge: at 99 picks the interval still covers 50%.

## Decision

- **Input, prompt v1.8:**
  - `total_goals_vs_line` replaces `total_goals_over`. It counts each window's 90-minute totals over, exactly on
    (whole lines only, where that total is a push) and under the market's main over/under line.
  - With no usable over/under line, the count falls back to 2.5, and `data_quality.total_goals_vs_line` says so.
  - The prompt says to judge Over and Under on that count, never on a count at another total.
- **Over/Under is shadow only** (`HYBRID_PUBLISHED_MARKETS = ['ASIAN_HANDICAP']` in the publish job).
  - The AI still weighs all four options, and its decision is stored in `hybrid_decisions` as before.
  - When the majority choice is Over or Under, the round publishes a no-pick with its own fixed line of text.
    The AI's Over/Under text is not published.
  - Fog stays off the fan pages, so fans see no pick for that match. Featured lists, previews, pick notes and
    films read only published picks, so Over/Under drops out of them too.
- **Measurement:** `npx tsx scripts/hybrid-ou-shadow-report.ts` settles the shadow decisions on the 90-minute score
  and sets them beside the published handicap picks of the same prompts. `/admin/picks` keeps showing each day's
  AI decision, published or not.
- **The handicap pick is frozen for measurement from v1.8.** No prompt change to it before the review below,
  unless the owner decides otherwise.

## Consequences

- **Review at 100 settled Over/Under shadow decisions:**
  - Over/Under comes back to the site only if its fair hit beats the market's expectation over those decisions.
  - The handicap record of v1.8 is read at the same time, with a 95% interval.
- **Fewer published picks per day.** Over/Under was about a fifth of the AI's picks since v1.6. The AI is not asked
  for a handicap choice instead, so those matches show no pick.
- **A v1.8 handicap pick may differ from v1.7.** The input of every decision changed, even where the choice was a
  handicap.
- **Rollback:** add `OVER_UNDER` back to `HYBRID_PUBLISHED_MARKETS`.

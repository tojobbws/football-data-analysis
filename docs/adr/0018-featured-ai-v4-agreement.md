# Featured list v4: three answers that agree come first, no cap per league

Status: accepted by the owner on 2026-11-13 (option 1, with the league cap removed). List version `featured-ai-v4`, migration 0060.

## Problem

The pick day's list (featured-ai-v3, ADR 0015) puts the AI's confidence first: HIGH before MEDIUM. Since ADR 0013 the Hybrid AI answers three times, and the confidence stored with a pick is that of the first answer that gave the majority side. Two things showed up in the record:

- No answer has said HIGH since v1.6. Across the 120 settled hybrid picks, all 360 answers were MEDIUM or LOW. The confidence step of the order never decided anything, so in practice the order was big five leagues, fewer data gaps, earlier kick-off.
- How many of the three answers agree separates the picks better than the stored confidence does.

## Evidence (production, read-only, 2026-11-13)

The 120 settled hybrid picks with three answers stored (`hybrid_decisions.votes`), from 2026-11-05. Fair hit rate leaves pushes out and counts a half outcome as half. Units are at the published price.

| group | n | fair hit | units per pick |
|---|---|---|---|
| all | 120 | 43.5% | −0.086 |
| 3 of 3 agree | 62 | 50.0% | +0.004 |
| 2 of 3 agree | 58 | 36.6% | −0.182 |
| 3 of 3, MEDIUM | 50 | 56.4% | +0.122 |
| 2 of 3, MEDIUM | 39 | 36.5% | −0.162 |
| MEDIUM (the ai-v3 pool) | 89 | 47.6% | −0.002 |

The 20-point gap between 3 of 3 and 2 of 3 among MEDIUM picks is about 1.9 standard errors. Several groupings were tried before this one, so the gap is likely overstated. It is a lead, not a proof.

## Decision

- **Order** (`compareAi` with `rankByAgreement`):
  1. the number of answers that gave the pick: 3 of 3 before 2 of 3. A pick without stored answers (before v1.6) counts as none.
  2. then the ai-v1 order: confidence, big five leagues, fewer data gaps, earlier kick-off.
- **No cap per league.** `maxPerLeague` equals the day's cap of 5, and the Nations League's own cap is gone. One league may fill the day.
- **Unchanged:** the pool (Hybrid AI picks at MEDIUM or higher), the leagues left out (ai-v3's list with Copa del Rey), and the list being chosen once after the daily run.
- **The agreement is read, never stored again.** `featuredDayMatches` counts the answers in `hybrid_decisions.votes` that gave the decision's side.
- **Switch day.** ai-v4 replaces ai-v3 from the first pick day ai-v3 has not listed.
- **Migration 0060:**
  - visitors may read ai-v4 rows
  - `fp_admin_review()` reports ai-v4 against every Hybrid AI pick of its period outside its left-out leagues

## Consequences

- A new version, so the list's count starts again (ADR 0004).
- Check point declared now: at 150 settled ai-v4 picks, compare the list's fair hit rate and CLV with all Hybrid AI picks of the same period (/admin/review). Measure the 3-of-3 versus 2-of-3 gap again on picks made after this date.
- More days may show 2 or 3 matches of one league, typically the Premier League on a weekend. The owner chose that over the variety the old cap gave.

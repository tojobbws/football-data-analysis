# The daily featured list (คู่น่าจับตา) gets its own version, featured-ai-v1, for Hybrid AI picks

Status: accepted by the owner on 2026-11-03 (the big-leagues-first order as drafted). Amends ADR 0006 for the pool and the ranking; the caps and the review criteria of ADR 0004 stay.

## Problem

Since the Hybrid AI publishes the pick (ADR 0010, 2026-10-27) the list has been empty every day: `featuredJob` only takes a pick with a `model_distribution`, and an AI pick has none. The web then fell back to a gold frame on every finished pick of the day, so a day showed more than 5 frames and no record said which matches had been called คู่น่าจับตา.

## Decision

**A new version, `featured-ai-v1`** (ADR 0004: a change of rules is a new version and its count starts again). `featured-v1` and `featured-v2` keep their rows and stop receiving new ones from the day this goes live.

**Pool.** The latest pick of a match that is a SIGNAL of `hybrid-ai-v1`: Asian handicap and Over/Under (the owner's choice; Over/Under had been left out of v2 for lack of a second signal, which does not apply to a pick the AI reads from verified data). Only a pick whose confidence is **MEDIUM or HIGH** (the AI has not stated HIGH yet). The AI states LOW when its evidence is weak, so LOW is left out on the AI's own word, not on results.

**Order.** The owner asked for the picks with the highest confidence first (2026-11-03). The AI states only two levels in practice (125 picks: MEDIUM 92, LOW 33, never HIGH), so on a normal day every candidate ties on confidence and the rest of the rule, an editorial one declared before any result, decides:
0. the AI's confidence (HIGH before MEDIUM);
1. the five big leagues first (Premier League 39, La Liga 140, Bundesliga 78, Serie A 135, Ligue 1 61): the readers know these teams best, and the list is also what leads readers into the match articles;
2. fewer gaps in `data_quality.missing` of the decision;
3. earlier kick-off.

**Caps unchanged:** 1 per match, 2 per league, 5 per day, excluded leagues stay excluded. Thresholds are never relaxed to fill a day: a day may have no list, and then it has no gold frame.

**Locking.** (A match that kicks off without ever having held a slot is not offered: nothing is chosen after the whistle.) An AI pick is published at the EARLY round and almost never gets a LINEUP round (121 of 122 EARLY picks of 2026-10-27 to 11-02 have no later round), so the lock of v1/v2 (CONFIRMED only at the LINEUP round) would drop nearly every slot. For `featured-ai-v1` a match is locked at its LINEUP round if it has one, otherwise at kick-off: CONFIRMED if it holds a reserved slot at that moment, DROPPED if it held one earlier, SKIPPED otherwise. Before the lock the slots may move as new picks arrive; after it a match never comes back.

**On the site.** The gold frame, the day's list and the 7-day calendar read only matches with a rank in the day's list (RESERVED with a rank, or CONFIRMED). The fall-back "every finished pick gets the frame" is removed. A day without a list shows no frame; past days are not filled in afterwards. For each day the site reads the newest version that has rows for it (`featured-v2` before the switch, `featured-ai-v1` after).

## What this does not claim

The order is an editorial choice for readers, not a measured one. The record of 125 settled Hybrid picks (2026-10-27 to 11-02) does not separate any criterion: hit rate on full results 48% for LOW (n=27) against 55% for MEDIUM (n=71); AH 49% with CLV +1.1%, Over/Under 68% with CLV -0.5% (n=22); no pick had complete data, and picks with more gaps did not do worse. These groups are too small to read. No claim about accuracy or the market is made next to the list.

## Measured

The ADR 0004 criteria, judged on confirmed selections of `featured-ai-v1` against all Hybrid picks of the same days: at least 150 settled, CLV mean and hit rate both higher; extended to 300, then FAIL. At 5 a day that is about a month, so no verdict before December. The report splits AH and Over/Under. If the list is no better than all picks, it stays a reader-facing selection and is described as that.

## Consequences

- Migration: the visitors' policy of migration 0033 opens `featured-v2` only; it must also open `featured-ai-v1` rows that are in the list. `fp_admin_review()` and `featuredLocked` learn the new version (an AI pick has no `fair_probability`, so its fair hit rate uses the settled status).
- `model:featured-report` and `/admin/review` print the new version.
- The home page and `/today` show an empty band on a day without a list, as they already do.

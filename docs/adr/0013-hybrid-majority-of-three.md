# Hybrid AI: three answers, the majority decides; no Dixon-Coles voice in the input

Status: accepted by the owner on 2026-11-05 (live at once, no shadow period). Amends ADR 0010; prompt `hybrid-ai-v1.6`, engine version unchanged (`hybrid-ai-v1`).

## Problem

Two measurements of 2026-11-05 on the live Hybrid AI (dry-runs, nothing written to the database):

1. **One answer is partly chance.** Replaying the exact stored inputs (`hybrid_decisions.input`) with the same model and prompt, the AI gave the same answer twice on only 118 of 201 inputs (59%). Three identical runs on the same 204 fixtures ranged from +1.07 to +9.67 units: the gap between identical runs is as large as any change we could test. Script: `scripts/research/hybrid-replay.ts`.
2. **The Dixon-Coles voice is biased and adds nothing beside the market.** On 262 AH and 260 O/U main-line options the AI was shown, DC put the favourite 5.2 points and the over 5.7 points below the market, while the results went the other way (favourite 56.7%, over 53.4%, market about 50%). Fitted as a correction on top of the market (`logit P = logit(market) + a + k·(logit DC − logit market)`) its weight is k = −0.04 (AH) and −0.01 (O/U): corrected, it is the market, which the AI already sees. Out of sample (5-fold) the raw DC log loss is the worst of the three (AH 0.727 vs market 0.694; O/U 0.714 vs 0.692). Script: `scripts/research/dc-bias-in-hybrid-input.ts`.

What was not shown: that a majority of three, or the input without DC, picks better. On the 204 replayed fixtures the majority of three (74 picks) won 60.0% at +0.107 units a pick, ±0.193 at 95%, and the input without DC did as well as the input with it; both are within the noise. Removing DC did not reduce the AI's underdog picks (the replay's underdog share stayed the same), so the losing underdog picks of 2026-10-27 to 11-05 (52 picks, 43%) are the AI's own reading, in a period when favourites covered unusually often.

## Decision

**Three answers, the majority decides.** For every decision the AI answers `HYBRID_VOTES` = 3 times on the same input, in parallel, each answer validated as before (up to `HYBRID_MAX_ATTEMPTS` per answer). The decision is the choice at least `HYBRID_MAJORITY` = 2 valid answers gave: an option (AH favourite, AH underdog, Over, Under) or NO_PICK. Its text, confidence and raw output are those of the first answer that gave it, so every published word still comes from one validated answer (number guard and banned words unchanged).
- Three valid answers, three different choices: **NO_PICK** (the evidence does not point one way).
- Fewer valid answers than needed to reach or rule out a majority (an answer invalid, refused or not reached, and the other two differ): the decision **fails** (INVALID, else REFUSED, else ERROR), nothing is published, and the next hourly run tries again while the round is open, as before.
- An API error that would hit the next call too (no credit, bad key) stops the run after that fixture's three calls.

**No Dixon-Coles in the input.** `legacy_statistical_model` is removed from the input and the prompt. The rules engine (`rules-v0.6`) keeps running beside the AI and its decision is still stored in `hybrid_decisions.legacy` for comparison; it was never shown to the AI.

**Record.** `hybrid_decisions.votes` (migration 0054) keeps each answer's status, choice, confidence and attempts, in order. `attempts` and `usage` are summed over all answers. Decisions before v1.6 have no votes.

## Consequences

- About three times the AI calls and tokens of v1.5 (v1.5 inputs are already about 60% larger than v1.4's). The time per fixture stays about the same, the three calls being parallel. The 2026-11-05 replay used up the OpenAI credit once: the credit must cover three calls per decision.
- Fewer picks: in the replay, the majority of three gave a pick on 74 of 204 fixtures where one answer gave 91 to 105.
- `/performance` counts v1.6 picks under the same engine version; the prompt version on each pick tells them apart, and v1.6 is compared against the v1.x picks before it with the stated sample.
- Not measured yet, to revisit with the live v1.6 record: whether the majority picks better than one answer, with a stated sample (about 1,000 picks are needed to see a difference of the size the replay showed).

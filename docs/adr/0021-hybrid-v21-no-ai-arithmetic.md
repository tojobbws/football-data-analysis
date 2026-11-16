# Hybrid AI v2.1 (experimental): the AI quotes totals it is given and never computes one

Status: experimental, dry-run only. The owner approved development and a replay on 2026-11-16, and production
approval is still to come. v2.0 stays the locked production baseline (ADR 0020).

## Problem

The audit of 16 Nov (`docs/research/hybrid-invalid-audit-2026-11-16.md`) inspected 1,560 AI answers.

- **What was rejected:** 151 answers (9.7%). The number guard rejected 148 and a banned word 3.
- **v2.0:** it rejects 51 of 111 answers (46%), against 0–6% for v1.6–v1.9.
- **Why:** 153 of the 172 rejected numbers were correct arithmetic done by the AI. Examples are a match's xG for plus
  against ("xG รวม 4.01") and a window's goals for plus against.
- **Rejecting them is right:** the guard cannot check arithmetic, so it must reject them.
- **Retries do not help:** a retry re-asks the same request with no feedback, and 31 of the 33 retries that failed
  again repeated the same number.
- **Result on 16 Nov:**
  - Central African Republic v Benin and Trinidad and Tobago v Antigua and Barbuda got no pick.
  - Two more matches were decided 58 minutes late.
  - คู่น่าจับตา waited for the 16:05 run.

The owner's order: first make the AI stop computing numbers, then make retries correct their error, then make the
guard read numbers correctly, then prove v2.1 by replay, and only then decide on production. The guard must never be
loosened.

## Decision

**A. Number guard, production fix (approved at once).** `inventedNumbers` (`packages/ai/src/guards.ts`) reads a comma
between well-formed groups of three digits as a thousands separator ("1,474" = an Elo rating of 1474), as well as the
decimal comma it read before. Either reading must be in the input.

- A dot is always a decimal mark.
- A number cut from a malformed group keeps the decimal reading only.
- Nothing else changes. On the 31,268 stored AI texts, the old and new guard give the same result.
- This lives on branch `number-guard-thousands` and is not merged yet.

**B. Hybrid AI v2.1 (experimental), `packages/ai/src/hybrid-v21.ts`.** No production job imports it.

1. **Aggregates in the input:** `withAggregatesV21(input)`.
   - Per recent match: `goals_total`, `xg_total` and `npxg_total`.
   - Per window: `goals_for_sum`, `goals_against_sum`, `goals_total_sum`, `goals_total_avg`, `goal_difference_avg`,
     `xg_for_sum`, `xg_against_sum`, `xg_total_sum`, `xg_total_avg` with `xg_total_matches`, and `npxg_total_avg`.
   - `comparison`: both teams side by side with sum and gap for each window, the league table and rest days.
   - Everything is computed from the input's own `recent_matches`.
   - A missing value stays null and is never counted as zero; each average says how many matches it rests on.
   - The definitions are in `data_quality.aggregates`.
   - The function is pure, so the stored v2.0 snapshot is not changed.
2. **Prompt:** `HYBRID_SYSTEM_PROMPT_V21` is the v2.0 prompt plus three additions.
   - A guide to the aggregates.
   - The owner's rule, verbatim: "Do not calculate, derive, aggregate, subtract, average, or invent any numerical
     values. …"
   - In the output rules: a no-vig price is written ราคาที่ตัดค่าน้ำแล้ว and never กำไร.
3. **Retry with feedback.**
   - `locateViolations` names each rejected number or word, its field (such as
     `options_review[2].supporting_evidence[1]`) and the text around it.
   - `retryFeedbackV21` says the reason and the fix.
   - The retry sends the same input, the previous answer and the feedback.
   - The attempt limit stays `HYBRID_MAX_ATTEMPTS` (2), and the guard is the same `validateHybridOutput`.

**C. Versioning.**

- `hybrid-ai-v2.0` remains `HYBRID_PROMPT_VERSION`, and its prompt, input builder and stored snapshots are untouched.
- v2.1 is `HYBRID_PROMPT_VERSION_V21` = `hybrid-ai-v2.1`.
- The replay records, for each answer:
  - the stored v2.0 `input_hash`
  - the sha256 of the input it sent (v2.1 adds the aggregates)
  - the sha256 of the prompt
- Unchanged: pick selection logic, market candidate selection (options are rebuilt from the stored input), the
  majority of three, and Decisions (not adopted).

## Replay (dry-run)

`scripts/research/hybrid-v21-replay.ts` runs on gpt-6-luna with two arms on the same stored inputs.

- **control:** v2.0 exactly as in production, with the fixed guard.
- **v21:** the aggregates, the v2.1 prompt and the feedback retry.

It replays two groups, reported apart:

- **G1:** the 16 decisions that ended INVALID.
- **G2:** the 82 decisions that passed only after a rejected attempt.

It measures:

- INVALID decisions
- the rejection and number-guard rejection rates
- the retry success rate and attempts per decision
- the pick distribution, including NO_PICK
- invented numbers
- numbers that passed but look like the AI's own arithmetic
- cost and latency

It reads no match result. The results are in `reports/hybrid-v21/` and in the report to the owner.

## Consequences

- Production is unchanged until the owner approves: no prompt or input change, nothing published, no scheduled job,
  no database write.
- If v2.1 goes to production later:
  - wire `withAggregatesV21` into `collectHybridInput`
  - switch the prompt version
  - replace `askOnce` with the feedback retry
  - count v2.1 picks apart from v2.0 by `prompt_version`
  - decide what that means for the ADR 0020 review at 100 settled v2.0 picks
- Rollback:
  - **Guard:** revert the commit on `number-guard-thousands`.
  - **v2.1:** delete `hybrid-v21.ts` and its export. Nothing else depends on it.

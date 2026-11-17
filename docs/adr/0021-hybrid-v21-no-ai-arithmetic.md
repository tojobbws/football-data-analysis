# Hybrid AI v2.1 (experimental): the AI quotes totals it is given and never computes one

Status: v2.1 experimental (dry-run, 2026-11-16). **v2.1.1 approved for production on 2026-11-16** (amendment below).
v2.0 stays the locked baseline and the rollback (ADR 0020).

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

## Amendment, 2026-11-16 evening: v2.1.1 goes to production

The owner approved production for v2.1.1 without a shadow period. The conditions were a replay with 0 INVALID decisions, checked aggregates, no data leakage, and the number guard left as strict as before.

### What v2.1.1 adds to v2.1

- **Match counts.** Every sum and average has the number of matches it rests on:
  - per window: `goals_matches`, `xg_for_matches`, `xg_against_matches`, `xg_total_matches`, `npxg_total_matches`
  - in `comparison`: `home_matches` and `away_matches`
- **The owner's rule, verbatim, plus a pointer to the counts.** "Whenever citing an average, explicitly state the
  number of matches used to calculate it. If the sample count is unavailable, do not cite the average as a factual
  statement."
- **A check of that rule.** `averagesWithoutCount` finds an average value cited without its count. The count can be in
  digits or in Thai words ("ในสิบเกม", "เกมเดียว"). "ราคาเฉลี่ย", the median price, does not count. The check is part
  of `validateHybridOutputV211`, and its feedback goes into the retry.
- **The cut-off check.** `enforceCutoffV211` compares every dated value in the input with `prediction_timestamp_utc`:
  - recent matches
  - head to head
  - recent starters
  - the market movement points
  - the API prediction

  It removes anything later and records it in `data_quality.cutoff_warnings`. The job also writes it as a GitHub
  `::error::` annotation.
- **Persistent errors.** `isPersistentOpenAIError` now also catches "no credits remaining" without the code
  `insufficient_quota`, quota or billing messages, and an unknown model. A persistent error marks the hybrid run as
  FAILED, so the workflow fails and GitHub notifies the owner. An INVALID or ERROR decision becomes a GitHub
  `::warning::` annotation.
- **Runtime version and rollback.** The version is chosen at runtime by `HYBRID_VERSION`: v2.1.1 by default, and `v2.0`
  restores the locked baseline exactly as before. Rollback needs no deploy:
  `gh variable set HYBRID_VERSION --body v2.0`.
- **Unchanged:**
  - market options
  - the majority of three
  - `HYBRID_MAX_ATTEMPTS` (2)
  - pick selection and publishing
  - the v2.0 prompt and input builder
  - stored v2.0 decisions

### Checked before deploy

- **Aggregates** (`scripts/research/v211-aggregate-audit.ts`):
  - all 742 stored inputs were recomputed by an independent implementation: 151,567 checks, 0 mismatches
  - the cross-check against the v2.0 window values covered 4,452 windows and proved the same matches and denominators
  - no average is zero-filled
- **Leakage:** 15,765 dated values were checked, and none is after the decision time. `enforceCutoffV211` gave 0
  warnings. The repository queries filter by the decision time; the tables without a time (standings, injuries, the
  match's lineups) are the state at the decision in a live run.
- **Replay** (`scripts/research/hybrid-v21-replay.ts`, arm `v211r`, gpt-6-luna):

  | Measure | G1 (16 INVALID) | G2 (82 retried) |
  |---|---|---|
  | v2.1.1 INVALID | 0/16 | 0/82 |
  | v2.0 control INVALID | 7/16 | 1/82 |
  | Number-guard rejections | 0/49 | 0/249 |
  | Rejected attempts | 1/49 | 3/249 |
  | Feedback retries that passed | 1/1 | 3/3 |

  - Every derived-looking number that passed is an exact aggregate field. One borderline case at 1-decimal precision
    was not reproduced on a closer check.
  - A first v2.1.1 detector read counts in digits only. It rejected 106 G2 attempts that had their counts in Thai words
    and left 3/82 INVALID. It was fixed before this replay.
- **Live smoke test** (`scripts/hybrid-v211-smoke.ts`) passed through the production functions with no write.
  Central African Republic v Benin, INVALID on 16 Nov for "xG รวม 4.01", now has `xg_total` 4.01 in its input and
  passed first time.
- **Watch item: the pick distribution.**
  - G2 decisions: NO_PICK was 36/82 for v2.1.1, against 42 for the v2.0 control and 45 for v2.1.
  - Answers: 102/246 (41%), against 112 and 115 (46–47%).
  - The first v2.1.1 replay gave 94/246.
  - Feedback retries never changed a side (20/20).
  - The prompt is not tuned against this. It is measured on live picks, with v2.1.1 counted apart.

## Amendment 17 Nov 2026: plain words for fans

The owner saw "จากอันดับ Elo และตารางที่ดีกว่า" in a published `summary_th`, under the Game Compass on a match page.
Fans do not know Elo. The v2.1.1 output rules now end with `PLAIN_WORDS_RULE_V211`: no Elo, npxG, xPTS,
goals_prevented, closing line, no-vig or input field names in Thai text, and no rating numbers. Each term gets a plain
Thai wording, for example ความแข็งแกร่งของทีมจากผลงานที่ผ่านมา for Elo. xG stays, explained the first time.

- It is a wording rule only. The input, the schema, the guards and the pick rules are unchanged, so the label stays
  `hybrid-ai-v2.1.1`. Decisions made before the push used the prompt without this rule.
- No guard checks it, so a stray "Elo" is not rejected and costs no retry. If it still shows up, a check can follow.
- The v2.0 rollback prompt is not changed.
- The preview prompt (`PREVIEW_SYSTEM_PROMPT`) got the same rule, and it no longer says the page shows the data gaps
  and the confidence level, since the match page stopped showing both on 17 Nov 2026.

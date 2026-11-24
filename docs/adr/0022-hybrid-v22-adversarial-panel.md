# Hybrid AI v2.2-panel (experimental): three adversarial lenses instead of three identical answers

Status: **experimental, draft (2026-11-24).** Not in production. v2.1.1 stays the default and the production version
(ADR 0021); `HYBRID_VERSION=v2.1.1` (or unset) is the rollback. No paid replay has run yet: the owner approves it first.

## Problem

Since prompt v1.6 (ADR 0013) the Hybrid AI answers three times on the same input and a choice needs two of three. The
three answers are the same request, so they share the same blind spots. They are three draws of one opinion, not three
opinions. The v2.1.1 miss diagnosis of 23 Nov found one repeated pattern: favourites argued from table rank, with no
check against what the market already prices. Three identical calls cannot catch that, because each one makes the same
argument.

Reader value: a pick that survives a sceptic is easier to trust and to explain, and `/performance` should show whether
that holds. The measure is closing-line value (CLV) on the main line, read with its sample size, and never an edge
claim (market benchmark rules, 2026-10-19).

## Decision (experimental)

**A. Three lenses, one round.** `packages/ai/src/hybrid-panel.ts`, `HYBRID_PROMPT_VERSION_V22_PANEL` =
`hybrid-ai-v2.2-panel`. The three answers of a decision are asked in parallel, one per lens (`PANEL_ROLES`):

| Lens | Looks first at | Adversarial rule |
|---|---|---|
| `metrics` | npxG, xG difference, xPTS against points, shooting performance, goals prevented, opponent Elo, `vs_closing_market` | argue in `market_comparison_th` and `counter_evidence` why the main line may already price these numbers or why the sample is noisy; pick only when the underlying evidence over several matches clearly disagrees |
| `context` | injuries (season figures, absences share, recent starts), confirmed lineup, starters' workload, rest days, table stakes, two-legged tie, derby, neutral venue, `market.movement` | assume the movement has priced public team news; pick only when structural context or high-impact absences stay underpriced |
| `defender` | traps: small counts, red-card distortions, `data_quality.missing`, adverse movement, recent goals, H2H, the API prediction | the main lines are efficient and NO_PICK is the default; leave it only when performance and context converge on the same mispricing with no major counter-evidence |

Each lens text ends with a reminder that field names never appear in Thai text (`PLAIN_WORDS_RULE_V211`).

**B. Prompt.** `HYBRID_SYSTEM_PROMPT_V22_PANEL` is `HYBRID_SYSTEM_PROMPT_V211` plus one shared line: follow the
`[PANEL ROLE]` section at the end of the user message while still obeying every rule above (no new calculation, match
counts, plain Thai, allowed numbers, output format).

**C. Prompt caching.** All three calls send the same `instructions` and start the user message with
`userMessage(input)`, byte for byte. The lens text comes after it (`\n\n[PANEL ROLE]\n…`). The long prefix (system
prompt plus about 36k characters of match data, about 17k tokens) is therefore identical across the three calls and
across a feedback retry. Tests check this, and the replay's `--dry-run` checks it on every sampled input.

- Caveat: the three calls start at the same moment. OpenAI caches a prefix only once a request has been processed, so
  parallel calls may miss the cache. The replay measures the cached-token share. If it is low, staggering the calls a
  little or adding `prompt_cache_key` is the next step, but neither is in this version.

**D. Unchanged guards.** Everything except the prompt and the text a majority keeps is v2.1.1:

- `HYBRID_OUTPUT_SCHEMA`
- `validateHybridOutputV211`: the number guard, the match-count rule and the banned words
- `enforceCutoffV211` and `withAggregatesV21` through `prepareHybridInputV211`, the same input for all three lenses
- `retryFeedbackV21` and `HYBRID_MAX_ATTEMPTS` (2)
- `majorityVote` with `HYBRID_MAJORITY` = 2: two agreeing valid lenses decide; all three valid and split = NO_PICK; too
  few valid lenses = INVALID / REFUSED / ERROR, tried again next run
- market options, the publish job, and featured-ai-v4, which counts votes for the decision's side (3/3 before 2/3)

**E. Which text a majority keeps.** With lenses, `combineVotes` keeps the `output` and `summary_th` of the agreeing lens
first in `PANEL_TEXT_PRIORITY`: `defender`, then `metrics`, then `context`. So a 3/3 pick shows the most
market-sceptical explanation. Without lenses (v2.0, v2.1.1) the first agreeing answer is kept, as before.

**F. Storage, no migration.** Each vote in `hybrid_decisions.votes` (jsonb) gets two optional fields, `role` and
`model`. v2.0 and v2.1.1 votes are written exactly as before. `prompt_version` is `hybrid-ai-v2.2-panel`.

**G. Configuration.**

- `HYBRID_VERSION=v2.2-panel` selects it. The env schema accepts it; `hybridVersion()` still defaults to v2.1.1.
- It is OpenAI only, with no Claude fallback. The model of each lens is `OPENAI_PANEL_METRICS_MODEL`,
  `OPENAI_PANEL_CONTEXT_MODEL` or `OPENAI_PANEL_DEFENDER_MODEL`, falling back to `OPENAI_HYBRID_MODEL`, then
  `OPENAI_MODEL`.
- `OPENAI_PANEL_<ROLE>_EFFORT` sets `reasoning.effort` for that lens. When unset, nothing is sent and the model's
  default applies.
- These variables are not passed by `.github/workflows/sync.yml`. A live run would need them added there, and only
  after approval.

## Replay (read-only A/B)

`scripts/research/hybrid-v22-panel-replay.ts` writes nothing to the database. It uses the latest stored DAILY input of
each fixture that has kicked off, stored under v2.0 or v2.1.1 (262 from 16 Nov as of 24 Nov). A v2.0 input goes
through `prepareHybridInputV211`, as production would build it. Both arms get the identical input and options.

- **control:** v2.1.1, three identical calls
- **panel:** v2.2-panel, one call per lens

Both arms run the production `askOnce` and `combineVotes`. Flags: `--limit` (default 60), `--from`, `--to`, `--seed`
(a seeded shuffle, so a rerun takes the same fixtures), `--budget` (a hard cap in USD, default 5), `--dry-run` (no
call: the sample, the caching check and a cost estimate) and `--report-only`. Results go to
`reports/hybrid-v22-panel/`, and an interrupted run resumes from the cache.

It reports, for each arm:

- INVALID decisions and answers
- number-guard rejections per attempt
- NO_PICK rate and side distribution
- 3/3 against 2/3 picks
- CLV against `market_closing`: closing no-vig probability minus the decision's, same market, selection and line, in
  probability points with n and a 95% interval, overall and split by 3/3 and 2/3. A closing line that moved is counted
  apart, in or against the pick's favour.
- each lens's NO_PICK and pick counts
- cached-token share, estimated USD, and p50/p95 latency per call and per decision
- how often the two arms reach the same decision

Dry-run estimate for 60 decisions on gpt-6-luna: 360 first calls, about $0.6 at 50% cached and at most $1.8.

## Evaluation criteria (proposed, for the owner to confirm)

A first replay of 60 decisions is a screen, not a verdict: about 20–30 picks cannot measure CLV better than about ±3
points. Before any production change, v2.2-panel must meet all of these:

1. **Guards no weaker.** INVALID decisions no more than control. Number-guard rejections per attempt no higher than
   control's.
2. **CLV.** Mean CLV of panel picks at least control's, read with n and the interval. 3/3 picks should not have lower
   CLV than 2/3 picks; otherwise the featured-ai-v4 order (3/3 first) loses its meaning for the panel.
3. **Volume.** The defender makes NO_PICK the default, so fewer picks are expected. A pick rate far below control's
   (for example under half) needs the owner's judgement: fewer but better picks, or too few for คู่น่าจับตา.
4. **Cost and time.** Cost per decision at most 1.3× control's, and p95 decision time inside the 14:00–16:00 daily run
   budget (`DAILY_CONCURRENCY` 6).
5. **Reading the misses.** Read the panel's wrong picks the way the 23 Nov diagnosis did, not only the totals.

If the screen passes, the next step is a larger replay on all stored inputs or a live shadow, chosen by the owner.

## Consequences

- Production is unchanged. Nothing reads `hybrid-ai-v2.2-panel` unless `HYBRID_VERSION` is set to it.
- Switching production to the panel would start a new count. v2.1.1 is frozen until 100 settled picks and counted alone
  (ADR 0020 and its 21 Nov note), so panel picks would be counted apart by `prompt_version`, and the switch would
  postpone that review.
- The `publish-job` rounds schedule maps `HYBRID_VERSION=v2.2-panel` to its prompt version, so a published pick carries
  `hybrid-ai-v2.2-panel`.
- **Rollback:** `gh variable set HYBRID_VERSION --body v2.1.1` (or delete the variable). To remove the experiment, delete
  `hybrid-panel.ts` and its export, the `v2.2-panel` branch in `hybrid-job.ts` and `publish-job.ts`, and the enum value
  and `OPENAI_PANEL_*` variables in `env.ts`.

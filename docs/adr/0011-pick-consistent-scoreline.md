# The scoreline beside a pick is chosen from the stored score matrix at read time

The owner decided on 2026-11-02 that a match with a published pick shows "สกอร์ที่น่าจะเกิด": the likeliest score on which that pick wins, instead of the model's single most likely score. In the 1,121 previews stored by then, the plain most likely score was 1–1 in 807 (72%) at about 12% each, so it told readers nothing about the match and often contradicted the pick (an Over 2.5 pick beside 1–1).

**Rule.** `pickScoreline(matrix, selection)` takes the totals score matrix behind the goal bands and returns the highest-probability score on which the pick wins outright. Only when no score wins outright does a half win, then a push count (so Under 2.0 gives 1–0, never the 1–1 push). The chance shown is the score's own chance in the matrix, not conditional on the pick. Matches without a pick, or previews without a stored matrix, keep the stored most likely score and its old wording. The "ถ้าจบ X–Y เข็มทิศเกม = ผล" line is dropped where the score is pick-consistent: it would always read "win".

**Where it is computed.** The preview job stores the matrix in `match_previews.score_matrix` (migration 0052, exposed through `web_match_previews`). The page computes the score when it renders, with the pick it is showing. A pick can be published or replaced after the preview is written (a PREMATCH round, the hybrid engine), and recomputing at read time means the score follows the pick without a new preview or a new AI call. `predicted_home/away/p` stay as written.

## Consequences

- Earlier previews have no matrix and keep the old score until the next stage's preview is written.
- Migration 0052 must run on prod before the worker writes `score_matrix`.
- The AI and template prose of a preview may still name the plain most likely score (its inputs are written before the pick is known). Not changed here.
- Not measured in `/performance`; the scoreline stays supporting analysis, never a second pick.

## Considered Options

- **Regenerate the preview whenever the pick changes**: rejected, one AI call per change and a new immutable row for a display detail.
- **Store λ, μ, ρ and rebuild the matrix on the page**: rejected, it would not reproduce the stored totals matrix or the cross-league blend that the goal bands use.
- **Keep the plain mode and explain that it repeats**: rejected by the owner, it still gives readers no information.

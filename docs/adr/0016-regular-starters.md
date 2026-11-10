# Regular starters before the lineup: a count of past starts on the match page and in the Hybrid AI input

Status: accepted by the owner on 2026-11-10 (option A of .scratch/regular-starters/spec.md). Prompt `hybrid-ai-v1.7`; the engine version stays `hybrid-ai-v1`.

## Problem

Lineups come about 1 hour before kick-off, after the daily pick run (14:00 Thai, ADR 0014) and after most readers open a preview. Until then the match page and the Hybrid AI see only the injury list, as bare names. Neither can tell a first-choice player from a reserve, so neither can say whether an absence matters.

## Evidence (production, read-only, 2026-11-10)

We guessed each XI as the 11 players with the most starts in the team's last stored lineups, then counted how many of them actually started (spec, "What the data says"):

- league matches, last 5 lineups in any competition: **7.87 of 11** (5,654 team-matches); league lineups only: 7.81
- continental cups: **7.49** any competition, 7.25 the cup's own lineups (1,116)
- domestic cup (League Cup, the only one tracked): 4.02 (120). Where the same cup had an earlier round this season (63), that round's XI got **5.48**, against 3.75 for the last 5
- national teams: 7.15 (54)
- leaving out injured players first: 7.80 → 7.84

A guessed XI misses about 3 players per team, so we show a fact, not a forecast.

## Decision

- **Regular starters** (`regularStarters()`, `packages/analysis/src/regular-starters.ts`): for each team, its last 5 stored lineups (at least 11 starters each) of finished matches before kick-off, in any competition. Each player gets his starts. For a **domestic cup**, each player is also marked for whether he started the previous round of the same cup in the same season. The competition kind comes from `competitionKind()` (`@fp/shared/leagues`): national team, continental cup (type Cup, country World), domestic cup, or league.
- **Regular starter** = started at least 80% of at least 3 lineups (4 of 5).
- **Match page**, "ผู้เล่น" card, before kick-off and only while the lineup is not confirmed:
  - "ขาดตัวจริงประจำ N คน" above the injury list, counting the `Missing Fixture` players who are regular starters
  - each injured player's `ตัวจริง s/5 นัดหลังสุด`
  - a "ตัวจริงในช่วงหลัง" list with each player's `s/5`, injured players struck through, and a `ถ้วยรอบก่อน` badge in a domestic cup. The note says it counts the last stored lineups in any competition and is not this match's XI.
- **Hybrid AI input** (prompt v1.7):
  - `recent_starters`, with the window as a value (`window_lineups`), the basis, and, for a domestic cup, a note on rotation and `started_previous_cup_round`
  - each injury gets `recent_starts` out of `recent_lineups`
  - a team with fewer than 3 stored lineups is listed in `data_quality.missing`
  - the prompt says to weigh an absence by its starts and never to state or guess who will start

## Consequences

- From the first daily run after the deploy, picks are made under v1.7. `analysis_predictions.prompt_version` splits the track record. There is no backtest of the change's effect on picks: replaying stored inputs would need the lineups as they stood at each decision, which the stored inputs do not hold.
- National teams: `sync:support` stores friendlies and qualifiers without lineups, so a national team's window may reach back months or hold fewer than 5 lineups. The count says so (`of`, and the dates in the AI input).
- The domestic-cup rule rests on 63 League Cup matches. It should be measured again once more domestic cups are tracked.
- Each match page before kick-off makes 5 more small reads (the league, then two queries per team). Each AI decision makes 2 more queries.

## Considered options

- **A predicted XI or formation.** Rejected: about 3 wrong per team.
- **The match page only (option B).** Lower risk, but the AI would keep weighing injuries blind. The owner chose both.
- **Counting only the same competition type.** Rejected: worse for leagues and continental cups (above). Kept only as the previous-round mark for domestic cups.

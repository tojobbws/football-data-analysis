# One daily pick run at 14:00: every match of the pick day gets one final pick

Status: accepted by the owner on 2026-11-06. Replaces the EARLY / PREMATCH / LINEUP rounds for new picks (ADR 0005 and ADR 0009 no longer apply to them) and the lock of ADR 0012. Restarts the shadow trial of ADR 0003.

## Problem

Picks were published hourly, in up to three rounds per match, and the daily featured list re-ranked itself every hour until each match locked. A list read at one moment was not the list of the day. On 2026-11-05 the spotlight video was made from the list at 18:00. At 18:28 the PREMATCH round of a prompt change (v1.5 to v1.6) withdrew St. Truiden and Palmeiras, and two other matches took their slots. The posted video no longer matched the site. The later rounds bought little: under the Hybrid AI only 3 LINEUP rounds were published in 8 days (2026-10-29 to 11-05).

## Decision

- **Daily pick run.** Once a day, at the 14:00 Thai hourly run, every match of the pick day is analysed and gets its pick or no pick. That pick is final. There is no LINEUP and no PREMATCH round, and the round is named `DAILY` (fan-facing: วิเคราะห์ก่อนเกม). A decision that fails is tried again in each hourly run until 16:00, and then the match has no pick.
- **Pick day.** The run covers kick-offs from 14:00 on day D to 14:00 on day D+1, named D. This keeps the 16% of matches that kick off 06:00 to 14:00 Thai (mostly South America; 156 of 969 in the 30 days to 2026-11-06), which a run inside the football day (06:00 to 06:00) would lose. A match kicking off before its pick can be published (about 14:00 to 14:45; 15-minute rule) has no pick. So does a match added to the schedule after the run.
- **Featured list `featured-ai-v2`.** Uses the ADR 0012 order and caps. It is chosen once, when the run ends (every match has a decision, or 16:00 has passed), and every match in it is confirmed at once. There are no DROPPED rows. Per ADR 0004 a new version starts its count again. The list, the spotlight and recap videos and the day groups of the track record follow the pick day. The scoreboard and /today keep the football day.
- **No redo.** A change to the pick engine or prompt applies from the next run. A match that already has a pick is never picked again: not when its kick-off moves (the pick stays in its first pick day, settled by the 48-hour rule), and not on the switch day, when matches already published at EARLY keep that pick.
- **Injuries** are fetched again at the 13:05 run for the pick day's matches, since no lineup round corrects the pick later.
- **Shadow trial (ADR 0003)** starts again, with shadow picks locked at the DAILY round. Its criteria stay as they are.

## Considered options

- Keep hourly rounds and make the video wait for the list to lock. Rejected: the list locks at kick-off, which is after the video is posted.
- A pick span of 16:00 to 16:00 (no match lost to the retry window). Rejected: 14:00 is easier to explain, and few matches kick off from 14:00 to 16:00.

## Consequences

- A pick never sees confirmed lineups. A late absence after 14:00 does not change it.
- /performance groups the days before the switch by football day and the days after it by pick day.
- The video skills read the list after the run. A list is final once published, so the 2026-11-05 mismatch cannot recur.
- If no hourly run happens between 14:00 and 16:00, the pick day has no picks. The 15-minute rule, and matches added after the run, leave some matches without a pick, and health reports them as unpublished warnings.
- The Hybrid AI decides 6 matches at a time in the daily run (3 answers each, so up to 18 calls in flight). One match one at a time took about 33 s on 2026-11-05 (22 in 12.2 min), so a full day of about 100 matches should fit in one 15-minute budget. This is an estimate that the OpenAI rate limits have not been tested against, and the 15:00 run picks up the rest.

## Rollout

Behind the GitHub variable `PICK_SCHEDULE` (`rounds` when unset, `daily`), like `PICK_ENGINE`:

1. Migration 0055 (the `DAILY` round, the `featured-ai-v2` read policy, `fp_admin_review`), before the code reaches main.
2. Merge, push and deploy the web (the gold frame and /performance read pick-day lists).
3. Set `PICK_SCHEDULE=daily` between the 13:05 and 14:05 runs. From that run: no new EARLY / PREMATCH / LINEUP round, `featured-ai-v1` takes no new match and locks the slots it holds at kick-off, and the first `featured-ai-v2` list is chosen after that afternoon's run.
4. Rollback: unset the variable (the hourly rounds return the next hour). DAILY rows stay in the record.

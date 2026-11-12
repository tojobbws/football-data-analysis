# The match preview follows the khemthit-football-writer brief

Status: accepted by the owner on 2026-11-13. Write-up `preview-v1.2`, prompt `preview-ai-v2.0`.

## Problem

The owner handed over a writing skill, `khemthit-football-writer`, for the per-match preview. It asks for a story first, one short paragraph per side, the model against the market, what is not known yet, the Game Compass in plain words and a closing line a reader remembers. It also drops caveats from the prose. preview-v1.1 was a Thai-press layout instead: team news, an analysis that had to name every source pointing away from the model, and a list of 3-5 facts.

## Decision

The owner chose the full six-part structure and to follow the brief even where it clashed with earlier choices.

- **Parts the AI writes** (`PreviewText`):
  - `headline_th`
  - `overview_th`: a story-first lead that copies `fixture.kickoffTh` (Thai time, written out by `thaiKickoff`) and the venue
  - `home_th`, `away_th`: 2-3 numbers each, the player to watch, confirmed absences
  - `analysis_th`, "โมเดลกับตลาดมองยังไง": the 1X2 chances, compared with the market only where the two differ, plus the model's chance of 3+ goals. It is empty when neither the model nor the market has numbers.
  - `summary_th`: the closing line, with no แต่ and no data caveat
  - `team_news_th` and `facts_th` are no longer written.
- **Parts the page builds** (the brief keeps the system's fields out of its scope):
  - "ยังไม่รู้อะไรบ้าง" lists `dataGaps`. It always reflects the page as it stands now, for example lineups announced since the preview was written.
  - The game summary with its rules-based confidence
  - The Game Compass section after it. It adds a plain-words line of the win conditions (`compassConditionsLine`). The table with its chances folds under "ดูเงื่อนไขและโอกาสของเข็มทิศเกม".
  - The closing line comes last.
- **Why the AI does not write the Game Compass part.** Previews are written in the morning of the football day, and the pick comes at 14:00 (ADR 0014), so the writer usually has no pick to describe. The pick's own reason (its note, or the Hybrid AI's sentence) stands in for "เหตุผลหลักหนึ่งประโยค".
- **Overrides of earlier decisions:**
  - The chance of 3+ goals is now given to the writer (`pGoals3plus`), worded as "อย่างน้อย 3 ประตู". The over/under words stay banned.
  - The disagreement guard now covers the market only. Form, xG or the second model pointing elsewhere no longer have to be stated.
  - The prose has no caveats. `CAVEAT_WORDS` rejects confidence-level and data-limit wording, and certainty words such as แน่นอน.
- **Rules kept:**
  - No scoreline for this match in the prose. The page shows the one that fits the pick (ADR 0011), and quoting the matrix's top score could contradict it.
  - Numbers trace to the input field by field. Percentages appear only in the side paragraphs (possession) and the model part.
- **New guards:**
  - Numbers are written in digits, so that they can be checked.
  - Text in a script that is neither Thai nor Latin is rejected unless the input has it. The smoke test turned up a stray "الأبرز".

## Consequences

- Rows written before this decision keep their v1.1 layout. Only new rows use v1.2, and `--refresh` rewrites today's rows once.
- The smoke test (`scripts/preview-smoke.ts`, now built from the job's own `previewWriterInput`) passed on 4 real matches.
  - In a first run, England vs Croatia failed the guards: the closing line used แม้...แต่, and a "ความมั่นใจ" that meant morale was flagged. The second false positive led to narrowing the caveat list.
  - The brief's 350-550 words were not reached on these THIN-data matches (about 1,000-1,200 characters). The brief allows that.
- The effect on readers has no measurement yet. Watch the AI pass rate by `prompt_version` (`guard_violations`), and read a sample each day for a week.

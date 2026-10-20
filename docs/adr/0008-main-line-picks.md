# The Game Compass picks on the market's main line only (rules-v0.6)

The owner decided on 2026-10-20 to replace rules-v0.5 at once rather than run the change as a shadow first (ADR 0003). The change is about what a reader sees, not about results: a published line should be the line the market is actually trading.

**What went wrong.** rules-v0.5 evaluated every offered Asian handicap and over/under line and published the passing one with the highest `supportScore`, which grows with the edge. The 12-point edge cap (ADR 0006 addendum) rejects the line where the model disagrees most, so the pick slid to whichever far line still fell under the cap. Liverpool–Villarreal (fixture 1635688) is the case that surfaced it. The market's main line was Liverpool -1.25 (2.045 / 1.805 median, 6 bookmakers), where the model was 17 points above the market. The EARLY round published Liverpool -2.5 at 3.64 (A000405, edge 11.9 points). Later runs moved to -0.25. A reader took -2.5 for the market's price.

**How often.** Of the published AH picks, 112 of 148 (76%) were not on the main line of their own run; for O/U 21 of 23. The settled outcome scores of off-main and on-main AH picks do not differ in any meaningful way (mean −0.076, n=106 vs −0.067, n=35; win 1, half ±0.5, loss −1). Replaying the stored candidates, about 104 of 173 runs that produced a published signal had a passing main-line selection. Most of the rest failed on the main line because the edge was above the cap. Expect noticeably fewer picks; there is no evidence the change makes the record better or worse.

**rules-v0.6** (`DEFAULT_RULES`):
- **Main line** (`mainLines`): API-Football's pre-match odds mark no main line, so it is derived. Every bookmaker's two sides of a line are de-margined (proportional), lines with at least **3** bookmakers quoting both sides fresh (≤ 12 h) and sane (sum of 1/odds 1.00–1.25) are kept, and the main line is the one whose median no-vig probability sits closest to 50%. Ties go to more bookmakers, then the smaller line. The line with the most bookmakers is not the rule (Liverpool -1.5 had 8).
- Only fresh quotes define it: a bookmaker that stopped quoting a line after the market moved keeps its old quote as its latest one. When no fresh line qualifies, the status says why: `NO_QUOTES`, `TOO_FEW_BOOKMAKERS`, `STALE` (it qualifies only among older quotes), or `UNBALANCED` (the best line is more than 15 points from 50/50, so the real main line is missing). Nothing is picked on that market (`MAIN_LINE_UNAVAILABLE`). A far line never stands in.
- Both sides of the main line go through the unchanged v0.5 gates: edge 3–12 points, EV ≥ 2%, odds 1.3–6, market gate, data and absence guards. Every other line is still evaluated and stored, rejected as `NOT_MAIN_LINE`, for later study.
- Nothing passes: `NO_CLEAR_SIGNAL`, with `decisionReason` `NO_QUALIFIED_SIGNAL` or `MAIN_LINE_UNAVAILABLE`. The published fog reason counts only main-line candidates, so it names the real cause (for Liverpool: the gap with the market is unusually large).
- The model side was already right and is unchanged: the model's fair probability comes from the whole score matrix and the settlement rule (a quarter line is half on each neighbouring line; a one-goal win at -1.25 is a half loss), pushes left out and half outcomes counted as half; EV uses the full outcome distribution at the median price.

**Logged per run** (`analysis_runs.summary`): `decisionReason`, and for AH and O/U the main line's `status`, `source` (`CONSENSUS_CLOSEST_TO_EVEN`), `line`, `nBookmakers`, `incompleteBookmakers`, `firstProbability`, median `odds` for both sides, `updatedAt`, and each side's model probability, market probability, EV, pass and reject reasons. Each candidate's `factors.onMainLine` is stored too.

**On the site.** The match page's แรงตลาด card reads the main lines from the last v0.6 run before kickoff: the line, both median prices, the bookmaker count and their time, the same numbers the decision used. An earlier pick off the main line is shown under "เส้นตลาดอื่น". Matches without a v0.6 run keep the old table. The published reason says "เส้นหลักของตลาด". No EV or value claim is shown to fans, and no gambling wording.

**Shadow rules stay frozen.** rules-v0.4-shadow keeps choosing among every offered line (`mainLineOnly: false`), as when its trial began. The real rules changed, so per ADR 0003 the trial count restarts on rules-v0.6. Already published picks, A000405 among them, stay in the record unchanged.

## Considered Options

- **Run v0.6 as a shadow first**: what ADR 0003 asks. Overruled by the owner. The change fixes what the published line means, and v0.5 would keep publishing far lines in the meantime.
- **Main line = the line with the most bookmakers**: rejected. On real data it picks -1.5 for Liverpool, and the count of lines a bookmaker opens changes with the market and the time.
- **AH only**: rejected. Over/under had the same problem (21 of 23 picks off the main line; the shadow picked Over 5.0 at 5.50 the same day).
- **Two bookmakers as the minimum**: rejected for 3, to trust the line more. Leagues with thin markets get fewer picks.

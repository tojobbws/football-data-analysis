# เข็มทิศฟุตบอล

A football analysis media site: the model publishes one analysed view per match, then the site settles it against the real result and reports performance openly.

## Language

### Picks and settlement

**เข็มทิศเกม (Game Compass)**:
The site's published analytical lean for a match — one pick, or fog when there is no clear signal. The pick is where the model's view differs most clearly from the market's, within limits; it is not the most likely outcome of the match.
_Avoid_: tip, bet, prediction (on fan pages); "the option the data supports most" (reads as the most likely outcome)

**Market (ตลาด)**:
The combined view of the football market on a selection's chance, read from many bookmakers' prices. On fan explanations it is called ตลาด and described as that combined view.
_Avoid_: เจ้ามือ, ราคา (in explanatory copy about the Game Compass)

**Edge (ส่วนต่าง)**:
How far the model's fair probability for a pick sits above the market's, in percentage points. Fan copy says the model "sees it differently" (มองต่าง) from the market.
_Avoid_: claiming the market got it wrong (ตลาดประเมินพลาด) — the record does not yet show the model beats the market

**Pick**:
A single published selection of the Game Compass for one match (market, side, line), made before kickoff and never edited afterwards. Its market is Asian handicap or over/under; 1X2 is never picked (a few early 1X2 picks stay as published).
_Avoid_: tip, bet

**Publish round (รอบเผยแพร่)**:
A point in time at which a match's Game Compass is locked as a new record: EARLY (before lineups), LINEUP (after both confirmed XIs, only when they are known in time) or PREMATCH (rare, ADR 0005). A later round replaces the earlier one on fan pages; the earlier one stays in the record and is never edited. A match may get only its EARLY round. Fan-facing names: ก่อนประกาศตัวจริง, หลังประกาศตัวจริง, ก่อนเตะ.
_Avoid_: รอบแรก (promises a second round that may never come)

**Unsettled pick**:
A pick whose outcome has not yet been decided — regardless of whether the match is upcoming, live, or already finished.
_Avoid_: pending result (as a fan-facing phrase)

**Settled pick**:
A pick whose outcome (win, half win, loss, half loss, push, void) has been decided from the 90-minute result; settling happens exactly once.

**Outcome**:
How a settled pick turned out: win, half win, push, half loss, loss, or void. In Thai fan-facing text: ถูก, ถูกครึ่ง, เสมอตัว, ผิดครึ่ง, ผิด, โมฆะ.
_Avoid_: ได้/เสีย, คืนทุน, จ่าย (betting language)

**Win condition**:
The plain-language list of match results that lead to each outcome of a pick, e.g. "Bremen แพ้ 2 ลูกพอดี → เสมอตัว".

**Outcome distribution**:
The model's chance of each outcome of a pick before kickoff (ถูก / ถูกครึ่ง / เสมอตัว / ผิดครึ่ง / ผิด), summing to 100%.

**Fair probability**:
A single "chance of being right" for a pick with pushes left out, half outcomes counted as half; the only figure directly comparable with the market.
_Avoid_: presenting it as the chance the win condition happens

**Settlement**:
The act of deciding a pick's outcome from the match result; it is separate from the match finishing and may lag behind full time.

**Odds snapshot**:
One bookmaker's quoted price for one selection at one moment. Snapshots feed pick selection and settlement, and are kept for good so that price movement can become a model input later.

**Closing odds**:
The median of each bookmaker's last pre-kickoff price for the pick's selection; recorded on the pick at settlement and kept for good.

**Shadow pick**:
The selection an alternative set of pick rules would have made for a match, kept aside and measured against results but never published or counted in the track record. The AI shadow pick is one; the bias-corrected rules are another.
_Avoid_: calling it a pick on fan pages

**Shadow trial**:
A fixed-length comparison of shadow pick rules against the real ones, judged on criteria set before any result is seen; the shadow rules are frozen for its length, and only its verdict can change the rules behind the published picks.
_Avoid_: tweaking shadow rules mid-trial (that starts a new trial)

**Daily featured list (คู่เด่นประจำวัน)**:
Up to 5 of a football day's picks, chosen from real picks only (never a separate opinion), ranked by support score with at most one per match and two per league; a slot is reserved from the EARLY pick and confirmed or dropped by the LINEUP pick. Runs in shadow until ADR 0004's verdict. Fan-facing name: "เข็มทิศฟุตบอลชี้ คู่เด่นประจำวัน".
_Avoid_: best bets, sure picks, ฟันธง (as fan-facing copy); filling the list by relaxing thresholds

**Closing market**:
The market's view of a match at kickoff — the 1X2 and the main Asian handicap and over/under line (sides closest to 50/50), with the model's probability beside each side; kept for good, so the model can be measured against the market over time.
_Avoid_: closing odds (that is the price recorded on a pick)

**CLV (closing line value)**:
How much better the price at publish was than the closing odds; recorded on the pick at settlement, so it survives the odds snapshots it came from.

### Around the pick

**Supporting analysis**:
Everything on a match page besides the Game Compass — preview, model outlook, market, form. It explains the match and the pick, is never measured, and must never read as a second pick.
_Avoid_: prediction, tip (for anything that is not the pick)

**Most likely scoreline**:
The single exact score the model rates highest; usually well under 20%, so "some other score" is far more likely. A secondary detail under the goal bands, never the headline: a low score like 1–1 can top the list while 3+ goals is the likelier band.
_Avoid_: predicted score, สกอร์คาดการณ์

**Gated-off market**:
A market whose model is not enabled for picks (not yet back-tested, or failed it); it can't produce a pick. Its figures may appear in the model outlook of a league whose side model is tested, always with a quiet "being measured" note, never anywhere else on fan pages.

**Goal band**:
A range of total goals in the match — 0–1, 2, 3 or more — with the model's chance of each; the headline of the preview's score section, because it lines up with over/under where a single scoreline does not. Recorded with the preview, so its "3 or more" may differ a little from the model outlook's "over 2.5", which can be computed at another time; each shows when it was computed.
_Avoid_: predicted goals

**Match phase**:
Where the match itself stands — upcoming, live, or finished. Fan pages describe an unsettled pick by its match phase, not by the bare fact that it is unsettled.
_Avoid_: using the pick's status to imply match state

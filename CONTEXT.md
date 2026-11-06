# เข็มทิศฟุตบอล

A football analysis media site: the model publishes one analysed view per match, then the site settles it against the real result and reports performance openly.

## Language

### Picks and settlement

**เข็มทิศเกม (Game Compass)**:
The site's published analytical lean for a match — one pick, or fog when there is no clear signal. The pick is a side of the market's main line (ADR 0008): under the rules engine, where the model's view differs clearly from the market's, within limits; under the Hybrid AI engine (ADR 0010), the option the evidence supports best against the market. It is not the most likely outcome of the match, and never a far line chosen for its larger gap.
_Avoid_: tip, bet, prediction (on fan pages); "the option the data supports most" (reads as the most likely outcome)

**Main line (เส้นหลัก)**:
The Asian handicap or over/under line the market is mainly trading: among lines with at least 3 bookmakers quoting both sides fresh, the one whose de-margined sides sit closest to 50/50. The provider does not mark it, so it is derived from the quotes; when no line qualifies there is no main line and no pick on that market. Other offered lines are "other market lines" (เส้นตลาดอื่น).
_Avoid_: calling the line with the most bookmakers the main line; showing a far line as the market's price

**Market (ตลาด)**:
The combined view of the football market on a selection's chance, read from many bookmakers' prices. On fan explanations it is called ตลาด and described as that combined view.
_Avoid_: เจ้ามือ, ราคา (in explanatory copy about the Game Compass)

**Edge (ส่วนต่าง)**:
How far the model's fair probability for a pick sits above the market's, in percentage points. Fan copy says the model "sees it differently" (มองต่าง) from the market.
_Avoid_: claiming the market got it wrong (ตลาดประเมินพลาด) — the record does not yet show the model beats the market

**Pick**:
A single published selection of the Game Compass for one match (market, side, line), made before kickoff. A later publish round replaces it on fan pages as a new record; it is not rewritten in place (ADR 0007 lifts the tamper-proof requirement, it does not ask for edits). Its market is Asian handicap or over/under; 1X2 is never picked (a few early 1X2 picks stay as published). Since the daily pick run, a match gets one pick and it is final.
_Avoid_: tip, bet

**Publish round (รอบเผยแพร่)**:
A point in time at which a match's Game Compass is locked as a new record. Now one round only: DAILY, made by the daily pick run and never followed by another. Before it: EARLY (before lineups), LINEUP (after both confirmed XIs, only when they are known in time) or PREMATCH (rare, ADR 0005), where a later round replaced the earlier one on fan pages; those rows stay in the record and are never edited. Fan-facing names: วิเคราะห์ก่อนเกม (DAILY); earlier ก่อนประกาศตัวจริง, หลังประกาศตัวจริง, ก่อนเตะ.
_Avoid_: รอบแรก (promises a second round that may never come)

**Daily pick run (รอบเลือกประจำวัน)**:
The one moment each day, 14:00 Thai, when every match of the coming pick day is analysed and gets its final pick or no pick. A match whose decision fails is tried again until 16:00, then has no pick. A match kicking off before its pick could be published, or added to the schedule after the run, has no pick. A change to the pick engine or its prompt applies from the next run; published picks are never redone, and a match whose kick-off moves keeps its pick in its first pick day (ADR 0014).
_Avoid_: calling it a round (it makes one round for many matches)

**Pick day (วันเข็มทิศ)**:
The matches one daily pick run covers: kick-off from 14:00 Thai on day D to 14:00 on day D+1, named by D. The daily featured list, the spotlight and recap videos and the day groups of the track record follow it.
_Avoid_: football day, for this span

**Football day (วันฟุตบอล)**:
06:00 to 06:00 Thai: how the scoreboard and /today group matches for fans. Not the span of picks.
_Avoid_: using it to group picks or the featured list

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

**Fair target**:
What a settled selection is scored against: a win counts 1 and a loss 0 at full weight, a half win 1 and a half loss 0 at half weight, a push or void not at all. Its weighted average is the fair hit rate, so a fair probability, the model's or the market's, is scored on it directly (Brier, log loss).

**Pick engine**:
What makes the published pick, set per run by PICK_ENGINE (ADR 0010): `legacy` = the rules over the model's edge, `hybrid` = the Hybrid AI, `shadow` = the rules publish while the Hybrid AI's decisions are only stored. Each pick records its engine in `decision_rule_version`; one round never mixes engines, and the rules keep running in every mode.
_Avoid_: calling an AI pick "the model's pick"; showing a model probability for it

**Hybrid AI decision**:
The Hybrid AI's choice for one publish round — AH favourite, AH underdog, Over, Under on the market's main lines, or no pick — from verified pre-match data and the market at that moment, with the evidence for and against. Its confidence is the strength of the evidence, not a probability. Stored whatever its validity; published only when valid and the engine is `hybrid`.
_Avoid_: treating its confidence as a chance of winning

**Market benchmark (เทียบกับตลาด)**:
The model and the market scored on the same matches and the same target: 1X2 against 1X2, Asian handicap and over/under on the same line and side. Reported with an interval clustered by football day and a verdict that says "not enough evidence" below 100 matches over 20 football days. It is a measurement, not an input: it never feeds the model.
_Avoid_: comparing the model with a 1/3 guess as if that were the bar to clear

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

**Daily featured list (เข็มทิศเกมประจำวัน)**:
Up to 5 of a football day's picks, chosen from real picks only (never a separate opinion), with at most one per match and two per league. For rules picks (featured-v2, ADR 0006; v1 ranked by support score) it is ranked by the model blended with the market, a slot is reserved from the EARLY pick and confirmed or dropped by the LINEUP pick. For Hybrid AI picks (featured-ai-v1, ADR 0012) it is ordered by the AI's confidence, then big five leagues, fewer data gaps, earlier kick-off, and a slot is confirmed or dropped at the LINEUP round or at kick-off. Since the daily pick run (featured-ai-v2) the list belongs to a pick day, uses the featured-ai-v1 order and caps, and is chosen once, at the end of the run: every match in it is confirmed at once and none is dropped. A day with no qualifying pick has no list. Fan-facing name: "เข็มทิศเกมประจำวัน".
_Avoid_: คู่เด่นประจำวัน (old name), best bets, sure picks, ฟันธง (as fan-facing copy); filling the list by relaxing thresholds

**Watched match (คู่น่าจับตา)**:
A match that held a confirmed slot in a day's list when it was locked (a pick day's list since featured-ai-v2, a football day's before). Kept for good with its rank and the pick it was locked on, and listed with its result on /performance. Matches that held a slot and lost it before the lock (dropped), and days without a list, have none.
_Avoid_: calling a pick with no slot a watched match

**Gold frame (กรอบทอง)**:
How the site shows a watched match, or a match still holding a slot in today's list. A display only: it is not stored, and it is drawn from the list rows alone, never from the pick.
_Avoid_: giving it to every pick of a day with no list

**Closing market**:
The market's view of a match at kickoff — the 1X2 and the main Asian handicap and over/under line (sides closest to 50/50), with the model's probability beside each side; kept for good, so the model can be measured against the market over time.
_Avoid_: closing odds (that is the price recorded on a pick)

**CLV (closing line value)**:
How much better the price at publish was than the closing odds; recorded on the pick at settlement, so it survives the odds snapshots it came from.

**Model snapshot**:
The model's probabilities for one match at one moment under one model version, kept for every match the model can analyse, not only picked ones. Append-only so history is kept; it is the base for measuring the model without selection bias. It is not a pick and carries no hash chain (ADR 0007). A **live** snapshot was computed before the match; a **backtest** snapshot was computed afterwards from earlier data only. Model results lead with live snapshots and show backtest ones apart, never merged.
_Avoid_: pick, prediction (on fan pages)

**Model result (ผลโมเดล)**:
How the model's snapshots turned out against real results over all settled matches — hit rate of the most likely 1X2 outcome, Brier score, log loss, calibration, always with the sample size. Shown on /performance apart from the pick track record; it never mentions profit.
_Avoid_: ROI, yield, profit; mixing it with the pick track record

### Around the pick

**Supporting analysis**:
Everything on a match page besides the Game Compass — preview, model outlook, market, form. It explains the match and the pick, is never measured, and must never read as a second pick.
_Avoid_: prediction, tip (for anything that is not the pick)

**Most likely scoreline**:
The single exact score the model rates highest; usually well under 20%, so "some other score" is far more likely. A secondary detail under the goal bands, never the headline: a low score like 1–1 can top the list while 3+ goals is the likelier band.
_Avoid_: predicted score, สกอร์คาดการณ์

**Pick-consistent scoreline** (fan-facing: "สกอร์ที่น่าจะเกิด"):
The exact score the model rates highest among the scores on which the match's published pick wins outright (a push does not count while any outright win exists). So Over 2.5 gives a 2–1, Under 2 a 1–0, and it can never contradict the pick. Not the **Most likely scoreline**: a match without a pick has none, and its probability is the score's own chance, usually low. Replaces the Most likely scoreline wherever the match has a pick.
_Avoid_: predicted score, สกอร์ฟันธง, calling it the model's top score

**Gated-off market**:
A market whose model is not enabled for picks (not yet back-tested, or failed it); it can't produce a pick. Its figures may appear in the model outlook of a league whose side model is tested, always with a quiet "being measured" note, never anywhere else on fan pages.

**Goal band**:
A range of total goals in the match — 0–1, 2, 3 or more — with the model's chance of each; the headline of the preview's score section, because it lines up with over/under where a single scoreline does not. Since preview-v0.8 it comes from the same totals matrix as the model outlook's "over 2.5", so the two agree when computed in the same run; recorded with the preview, it can still differ from a later outlook, and each shows when it was computed.
_Avoid_: predicted goals

**Match phase**:
Where the match itself stands — upcoming, live, or finished. Fan pages describe an unsettled pick by its match phase, not by the bare fact that it is unsettled.
_Avoid_: using the pick's status to imply match state

**Big match (คู่ใหญ่)**:
A match ranked high by its popularity score, shown for reader interest whether or not it has a pick. A big match without a pick shows only the model outlook, where the league's model is tested; it is never a second pick.
_Avoid_: calling it a best signal or a recommended match

**Popularity score**:
A number from team popularity, league and competition importance and derby or rivalry, kept in an admin-editable registry keyed by provider ids. It only orders what is shown; it never enters a probability, an edge, a pick or the daily featured list.
_Avoid_: confidence, strength

**Tie**:
The pairing of a cup round's first and second leg between the same two teams, with its aggregate score; a single-leg round is a match, not a tie. Each competition and season has its own rules for deciding a tie.
_Avoid_: one rule for every cup

**Qualification probability**:
The model's chance that a team goes through a two-legged tie, simulated from the remaining leg under that competition's rules. It is not the 90-minute win chance, and its extra-time and penalty parts are stated assumptions (extra time scaled from 30 minutes, penalties 50/50), shown on the page. Supporting analysis, never a pick.
_Avoid_: using the 90-minute win chance as a stand-in

### Data

**Benchmark forecast (ตัวเทียบ)**:
An outside source's match probabilities, kept only to score the model against; it never feeds the model, the pick rules or fan pages.
_Avoid_: using it as a model input or a second opinion on the pick

**Data coverage**:
Which kinds of match data a league season provides (statistics, lineups, events, injuries, odds …); it decides which model inputs that league can use. A gap turns those inputs off for the league but never removes the league from picks.

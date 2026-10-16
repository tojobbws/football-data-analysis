# The daily featured list goes public on featured-v2, ranked by the model blended with the market

Supersedes the publication rule of ADR 0004 (shadow first, public only after a verdict and an ADR 0003 verdict). The owner decided on 2026-10-17 to show the list at once.

**State of the evidence when this was decided** (8 days, 45 settled picks): fair hit rate 49.4%, indistinguishable from 50%; mean CLV +0.018, beat the close 55.6%. STRONG picks hit 46.2%, below LEAN at 50.0%. In the 0.51–0.69 model-probability buckets the model said 55–63% and got 42–45% (n=23). No featured selection had been confirmed or settled. The record does not show that the model beats the market, and the list is published knowing this.

**Why v1 ranking changes.** `supportScore` grows with the edge over the market, so the "most confident" pick was the one where the model disagreed with the market most. The model is less sharp than the market (ADR 0003), so that is the least trustworthy kind of confidence. featured-v2 ranks by the model's probability blended 50/50 with the market's no-vig probability. The edge band (0.03–0.15) stays a gate, because it is already one of the pick rules.

**featured-v2** (`FEATURED_V2`): the same pool, gate, caps (1 per match, 2 per league, 5 per day), 0.55 fair-win floor and excluded leagues as v1; only the rank differs. Thresholds are never relaxed, so a day may have no list. Over/Under is left out until it has a second independent signal (Elo has no goals model), planned at 1 per day at most. Strength labels (STRONG/MEDIUM/LEAN) take no part in the choice.

**On the site.** `/today` and the home compass band show the list, from featured-v2 rows that are in the list now (RESERVED with a rank, or CONFIRMED; migration 0033 opens exactly these to visitors). Pick rules (rules-v0.3) and match pages are unchanged. `FEATURED_LIST=off` in the web environment hides the list. No claim about results or about the market is made next to it, and no gambling wording.

**Still measured.** featured-v1 and featured-v2 both run and settle; `npm run model:featured-report` prints both against all LINEUP picks. The ADR 0004 criteria, plus at least 55% fair hit rate on 300 picks, calibration of the high-confidence bucket within ±5 points and a 90% lower bound of the hit rate not below 50%, are now a review, not a gate. First review **2026-11-06**, or when 300 settled selections exist, whichever is later. If the list fails it, the next decision is to hide it or change it.

Rules-v0.4 (bias table) is not promoted: its table was measured as model-versus-market difference, not against results, and waits for a walk-forward check on settled picks.

## Considered Options

- **Keep it admin-only until the ADR 0004 verdict**: the earlier decision, and the safer one for credibility. Overruled by the owner.
- **Show a "being measured" note beside the list**: rejected by the owner, because it costs credibility.
- **Rank by edge (v1)**: kept only as a shadow comparison.

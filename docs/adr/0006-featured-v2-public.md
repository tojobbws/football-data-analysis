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

## Addendum 2026-10-17: edge cap and strength labels

On the football day 2026-10-16 the published picks went 1 win, 1 push, 5 losses; all four STRONG picks lost, each 10–14 points above the market. Over all 49 settled picks since 2026-10-07 the fair hit rate was 46.9%; by edge over the market: under 6 points 44.4% (n=9), 6–9 58.3% (n=12), 9–12 50.0% (n=10), 12 and over **38.9%** (n=18); by label: STRONG 40.9% (n=22), MEDIUM 62.5% (n=8), LEAN 47.4% (n=19). The groups are small, so this is a direction, not proof; it agrees with ADR 0003 (the model is less sharp than the market, so the largest disagreements are the likeliest model errors).

- **Pick rules become rules-v0.5**: the edge cap drops from 0.15 to 0.12, nothing else changes. Picks with a larger edge are rejected as `EDGE_TOO_LARGE`. The cap was set from the 18 picks above, so it may be overfitted; it is reviewed with the rest on 2026-11-06. The shadow rules (v0.4) inherit the new cap, so shadow and real stay comparable. Per ADR 0003 the shadow trial count restarts on the new rules.
- **Strength labels leave the fan pages**: the card meter ("ข้อมูลหนักแน่น" and the like), the badge on the match page and the label in the /performance table are gone. The labels are still stored and shown in admin, and they still do not decide the featured list.

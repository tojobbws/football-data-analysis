# Bias-corrected pick rules are judged by a shadow trial with criteria fixed in advance

On 2026-10-12 the published picks were all on the side getting the start or at AH 0: none on the side giving it. The model's edge against the market leaned that way on almost every match (+9 points for the underdog at the main AH line, ~+4 for unders at 2.5). A walk-forward check on 4,882 matches showed the model is well calibrated against results, but less sharp than the market, so measured against the market it always sees the underdog as underpriced. The pick rules (rules-v0.3) therefore mostly report the model's own lean, not a market error.

`rules-v0.4-shadow` keeps every rule and takes the model's usual lean per selection and line off before measuring the edge. That lean is a frozen table measured from model-vs-market differences of ~33k evaluated candidates, not from results, so the trial tests it on unseen outcomes. The shadow rules run on the same inputs as the real ones and their pick is locked at the EARLY and LINEUP rounds under the same conditions as a real pick, never published. Closing odds and CLV are recorded for each locked shadow pick the same way settlement records them for real picks.

The decision is made on LINEUP-round picks, one per match (EARLY is reported beside it, never decides), with criteria set before any result was seen:

1. at least **300** settled shadow picks;
2. shadow mean **CLV** above the real rules' by more than **2 standard errors** (same period);
3. shadow **fair hit rate** (pushes and voids left out, half outcomes counted as half) no more than **5 points** below the real rules'.

All three hold → the shadow rules replace the real ones on the site. Otherwise the trial is extended once, to **600** picks; still not all three → the real rules stay, and the fix moves to the model itself (its sharpness). The shadow rules and their bias table are frozen for the trial: any change is a new rules version and the count restarts. `npm run model:shadow-report` shows progress and the verdict.

Only after this verdict is a daily "best picks" selection reconsidered, since it would rank whatever the pick rules choose.

## Considered Options

- **Blend model and market probabilities (e.g. 50/50) before the edge**: rejected; it only scales the edge down and keeps its direction, so the picks stay on the underdog.
- **Hit rate as the main criterion**: rejected; at ~50% a few-point difference needs thousands of picks to separate from luck, while CLV shows it within a few hundred.
- **Let the shadow decision follow every evaluation until kickoff**: rejected; it would see later data than the real picks and win the comparison for the wrong reason.
- **Switch the site to the corrected rules now**: rejected; the correction is untested on results and the record must not change rules on a hunch.

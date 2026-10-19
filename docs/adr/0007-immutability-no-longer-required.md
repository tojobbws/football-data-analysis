# Immutable records are no longer a requirement; predictions of every match are measured and shown

Supersedes the "cannot be edited or deleted" positioning that ADRs 0001–0006 and `PRODUCT.md` were built around. The owner decided on 2026-10-19: the tamper-proof record (database triggers plus the public hash chain) is not needed any more, because what readers of the site want is the results of the model's predictions, not proof that a record was never edited.

**What changes.**
- Immutability and the hash chain stop being a requirement. New tables need no triggers and no chain, and the `analysis_predictions` / pick / settlement tables may be redesigned when that serves the work, with the existing rows migrated, never dropped.
- Predictions of every match the model can analyse are kept as model snapshots: append-only per model version and `computed_at`, so history is still kept and old rows are not turned into new ones. They are the base for measuring Brier score, log loss and calibration without selection bias. A snapshot is not a pick.
- `/performance` gains the results of those predictions for all settled matches, separate from the pick track record and under the fan-facing name "ผลโมเดล". Readers of the performance pages are now a primary audience.

**What stays.**
- The existing triggers, hash chain, `fp_verify_prediction_chain()` and their data are left running as they are. Nothing is deleted without a specific reason.
- Everything that does not depend on the chain: at most one pick per match or fog (hidden on fan pages), 1X2 never picked, `rules-v0.5`, featured-v2 and the daily featured list (this is the "Best Signals" of the product brief), shadow rules frozen for the length of a shadow trial, settlement exactly once on the 90-minute result, the brand voice and disclaimer. EV, ROI and `market_edge_score` stay internal and admin-only; fans see Edge and CLV as before.

**Why.** The brief for the next phase asks for predictions of all matches, a performance dashboard and the freedom to rewrite storage. A frozen schema blocks the rewrite, and the public chain only proves non-tampering, not quality. The cost is that "a tipping site cannot truthfully copy this record" is no longer the pitch; credibility now rests on the measured results and their sample sizes.

## Considered Options

- **Keep the requirement**: rejected by the owner.
- **Remove the triggers and the chain now**: rejected, because it destroys evidence for no gain; keeping them costs nothing.

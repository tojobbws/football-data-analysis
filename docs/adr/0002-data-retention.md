# Raw API responses and odds snapshots are kept only while they are used

The database hit 498 MB of the 500 MB Supabase Free limit five days after launch. Two write-only stores were most of it: `api_raw_responses` (172 MB, growing ~35 MB/day, of which raw `/odds` pages were 105 MB) and `odds_history` (91 MB, ~15–20 MB/day). The old prune kept raw rows 14 days, which alone would settle at ~490 MB. We stay on Free and keep data only while something reads it:

- `sync:odds` no longer stores its raw pages; every quote is already in `odds_history`.
- Other raw responses are kept 3 days (`db:prune`, daily).
- ~~Odds snapshots of a match are deleted 7 days after kickoff once none of its picks or AI shadow picks is unsettled.~~ Superseded 2026-10-15 (migration 0027): the database moved to Supabase Pro (8 GB) and odds snapshots are kept for good, so that price movement can become a model feature. `odds_history` is append-only again: its trigger rejects every UPDATE and DELETE. Snapshots deleted before 2026-10-15 are gone; history before then is only what `market_closing` and the picks kept.
- An odds quote is stored only when its price differs from the last stored price for that selection, or that was stored 6 h or more before (a heartbeat, since pick selection ignores quotes older than 12 h). Added 2026-10-12 at 411 MB: `odds_history` had grown to 152 MB at ~150k rows/day, 71% of them a new API timestamp on an unchanged price. Opening, current and closing prices are unaffected; "last updated" times can lag by up to 6 h.
- Before its snapshots go, each match's closing market is kept for good in `market_closing` (`model:closing`, hourly and daily): the 1X2 and the main Asian handicap and over/under line (sides closest to 50/50), each side's median closing odds and no-vig probability, beside the model probability the last pre-kickoff candidates run used. ~7 rows per match. Added 2026-10-12: the model's edge leaned to the underdog on almost every match (+9 points at the main AH line) because the model is less sharp than the market, and without a market history that bias can be neither measured over time nor corrected.
- `raw_response_id` is a plain reference, not an FK: with `on delete set null`, pruning raw rows rewrote every linked odds row and bloated the table while the database was full.
- `fixtures.raw` is dropped; nothing read it.

Settled picks, match results and match detail tables (events, statistics, lineups, player stats) are kept for good: /performance, match pages and backtests use their full history.

## Considered Options

- **Upgrade to Supabase Pro (8 GB)**: fixes it at once, rejected at first to stay free while traffic is small; taken on 2026-10-15. The rest of this policy stays (raw rows 3 days, de-duplicated odds quotes), since nothing reads what it drops.
- **Keep opening and closing odds per selection before deleting snapshots**: would allow using market prices as a model feature later. Rejected at first because nothing read them; superseded on 2026-10-12 by the compact closing market above (main lines only, not every selection or the opening price).
- **Prune old `probability_predictions` runs and unpublished `analysis_candidates`** (~33 MB): deferred; they are the audit trail of what the model said and when.

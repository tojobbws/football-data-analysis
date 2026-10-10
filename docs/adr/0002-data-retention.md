# Raw API responses and odds snapshots are kept only while they are used

The database hit 498 MB of the 500 MB Supabase Free limit five days after launch. Two write-only stores were most of it: `api_raw_responses` (172 MB, growing ~35 MB/day, of which raw `/odds` pages were 105 MB) and `odds_history` (91 MB, ~15–20 MB/day). The old prune kept raw rows 14 days, which alone would settle at ~490 MB. We stay on Free and keep data only while something reads it:

- `sync:odds` no longer stores its raw pages; every quote is already in `odds_history`.
- Other raw responses are kept 3 days (`db:prune`, daily).
- Odds snapshots of a match are deleted 7 days after kickoff once none of its picks or AI shadow picks is unsettled. Settlement has by then copied the price at publish, closing odds and CLV onto the pick, and backtest/tune do not read odds. The `odds_history` trigger still forbids every UPDATE and any other DELETE.
- `raw_response_id` is a plain reference, not an FK: with `on delete set null`, pruning raw rows rewrote every linked odds row and bloated the table while the database was full.
- `fixtures.raw` is dropped; nothing read it.

Settled picks, match results and match detail tables (events, statistics, lineups, player stats) are kept for good: /performance, match pages and backtests use their full history.

## Considered Options

- **Upgrade to Supabase Pro (8 GB)**: fixes it at once, rejected to stay free while traffic is small.
- **Keep opening and closing odds per selection before deleting snapshots**: would allow using market prices as a model feature later. Rejected for now; nothing reads them, and it can be added before the next deletion if that changes — deleted snapshots cannot be recovered.
- **Prune old `probability_predictions` runs and unpublished `analysis_candidates`** (~33 MB): deferred; they are the audit trail of what the model said and when.

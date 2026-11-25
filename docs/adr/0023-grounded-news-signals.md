# Grounded news signals: a research shadow, tested against the market before any decider sees it

Status: **Proposed (draft), 2026-11-24.** Awaiting the owner's approval. Nothing is built, no migration is applied.
Spec: `.scratch/grounded-news/spec.md`.

## Context

- API-Football's `injuries` lags or misses late team news, worst in secondary leagues and after international breaks
  (18 Nov 2026, Brazil Serie A: no injury rows at 14:00 for the round). The Hybrid AI input already says that an empty
  list is not "nobody is out", but it has nothing to put in its place.
- Every stats-only route to an edge over the 14:00 price has failed so far (market-anchor experiment, Decisions v2,
  sharp-vs-soft backtest). Late, unstructured team news is the remaining candidate the market might not have priced.
- Hybrid AI ×3 v2.1.1 is frozen until 100 settled picks (ADR 0020, 0021) and must not change during this work.

## Decision (proposed)

1. A separate news job (`GROUNDED_NEWS=shadow`, own workflow and concurrency group, 13:20–13:50 Thai) finds articles
   about each pick-day fixture's teams, reads them itself, and has OpenAI (Responses API, strict JSON schema, no tools)
   extract **categorical** signals: late injury / illness, suspension or eligibility, rotation hint, manager change,
   disruption.
2. Every signal carries its source URL, name and tier, the article's `published_at_utc`, our `collected_at_utc`, and a
   verbatim quote of at most 200 characters that code checks against the fetched text. Both timestamps must be at or
   before the decision time; a signal without a verifiable publication time is `UNVERIFIED` and never counted or passed
   on.
3. Code, not the model, matches each player signal against the fixture's API injuries **as of the collection time**
   (`injuries.first_seen_at`), the regular starters (ADR 0016) and the season figures (ADR 0020), and tags novelty and
   impact. The model never writes a number.
4. Storage is append-only (`fixture_news_runs`, `news_articles`, `fixture_news_signals`); a trigger refuses rows after
   kickoff and pre-run rows after the planned decision time. "No news found" is a stored run, never a missing row.
5. Discovery uses Google News RSS plus official-club feeds; OpenAI `web_search` only as a capped comparison arm. Estimated
   cost ≈ $0.003–0.015 per fixture with articles (model-dependent), ≈ $0.25–1.2 a day.
6. **The first test costs no decider call:** for fixtures with a novel, high-impact absence found before 14:00, does
   Pinnacle's 1X2 price move against that team between 14:00 and kickoff, beyond price-band-matched controls? Gate A:
   ≥ 100 such fixtures over ≥ 20 football days, clustered 95 % lower bound > 0 and point estimate ≥ 1.0 pp, a null
   placebo on news the API already had, ≥ 85 % of OUT signals confirmed by the lineup, zero leakage rows.
7. Only after Gate A and the owner's approval: a shadow decider (v2.1.1 + a `news_context` block, stored in
   `decisions_shadow`, never published). Promotion needs Gate B and a new ADR.

## Consequences

- No backfill is possible: news cannot be re-collected "as it stood" in the past, so the sample grows only from the start
  date. Gate A needs at least four weeks.
- If Gate A fails, the result is still useful: it says team news is priced by 14:00 in the leagues we cover, and the
  record stays, as with Decisions v2.
- The same verified signals could later feed a sourced "ข่าวทีมก่อนเกม" block for fans; that is a separate decision.

## Alternatives considered

- OpenAI `web_search` as the only fetcher: simplest to build, but costlier ($10 per 1,000 searches plus content tokens),
  not replayable, and its citations carry no publication time, so every page has to be fetched again anyway.
- A paid news API: free tiers are delayed or non-commercial; paid plans cost more than the whole pipeline is worth before
  it shows any value.
- Feeding news straight into v2.1.1: rejected; it would break the frozen count and could not tell an edge from noise.

# A PREMATCH round, never an edit, when a league's gates change after its EARLY round

On 2026-10-15 the UEFA cups and 18 new leagues were (re-)tuned in the afternoon. Their matches that evening had already published EARLY as fog, because the markets were gated off when EARLY was locked. The owner wanted those matches analysed again with the new gates. The record cannot change: published rows are hash-chained and protected by triggers, and the site promises that nothing is ever edited.

So a third publish round, PREMATCH, is added as a new row in the chain. Every published row stays as it was. A match gets it only when all of these hold:

1. its EARLY round was fog;
2. its league's pick gates (sides or totals) were tuned **after** that EARLY row was published;
3. no LINEUP round has been published, and kickoff is at least 15 minutes away;
4. the decision was made after that re-tune;
5. it has not had a PREMATCH yet: it is published once only.

It is published **whatever the decision**, pick or fog. The rule is fixed in advance and does not depend on the outcome, so it is not a second draw kept only when it gives a pick. The LINEUP round still follows as usual. The shadow trial (ADR 0003) is judged on LINEUP and does not lock PREMATCH. The site shows PREMATCH as ก่อนเตะ, and performance reports it as its own round.

This also applies every week: matches whose EARLY fog was published before the Monday tune can get a PREMATCH after it.

## Considered Options

- **Lift the no-edit rule and re-publish EARLY**: rejected. It breaks the hash chain and the site's central promise.
- **Publish PREMATCH only when it gives a pick**: rejected. Keeping only the favourable draw biases the record.

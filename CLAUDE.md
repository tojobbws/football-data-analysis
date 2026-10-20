## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

## Product thinking

The goal is a distinctive football analysis platform and a sustainable content business, not another stats site. Judge a feature by what it gives readers:

- casual fans understand the match faster;
- raw data becomes an insight other sites don't offer;
- trust grows through a transparent, measured track record (`/performance`);
- articles are readable, shareable, and findable through SEO and AI search;
- one analysis feeds both the site and social posts;
- ad placements earn without hurting the read.

### Data integrity

- Work from the data the pipeline actually holds (API-Football, the database, the analysis jobs) and name the inputs that are missing or unreliable.
- Every statistic, injury, team fact, and result traces to a stored source.
- Keep data-driven conclusions apart from assumptions and editorial opinion.
- Judge a recommendation against historical results, with a stated metric and sample size.
- Present a prediction as a probability or a lean, never as a certain outcome.

### Significant product decisions

1. Name the reader problem or business opportunity.
2. Inspect the current implementation and data.
3. Offer the best practical options, including one differentiated idea where it fits.
4. Rank them by reader value, business impact, effort, and risk.
5. Recommend the next step, then wait for the owner's approval before building a major product change.

Prefer measurable reader value and a lasting advantage over features that exist only because competitors have them.

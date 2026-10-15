# The daily featured list runs in shadow first, with criteria fixed in advance

The owner wants each football day to name at most 5 matches whose Game Compass pick is the strongest of the day ("เข็มทิศฟุตบอลชี้ คู่เด่นประจำวัน"). ADR 0003 defers any such selection until the rules-v0.4 shadow trial gives its verdict, because a ranking only reorders whatever the pick rules choose. So the selection is built now but runs **in shadow**. It is locked, settled and reported in admin only, and is never shown on fan pages.

The selection only ever takes real published picks (AH or O/U), so it can never contradict a match page. A pick qualifies when its fair win chance is at least 0.55 and its market is enabled by the league's tuning gate. Qualifying picks are ranked by `supportScore`, with at most 1 per match, 2 per league and 5 per football day. The list is never filled by lowering thresholds.

Slots are reserved from EARLY picks at 06:00 Thai. Each slot is then confirmed or dropped by the match's LINEUP pick, and is locked at that point and never edited. Only confirmed LINEUP selections count.

The decision is made with criteria set before any result was seen:

1. at least **150** settled featured selections;
2. featured mean **CLV** above the mean CLV of **all LINEUP picks** in the same period;
3. featured **fair hit rate** (pushes and voids left out, half outcomes counted as half) above that of all LINEUP picks in the same period.

All three hold, and ADR 0003 has a verdict → the list goes on the site (top of /today and home, with its own record on /performance). Otherwise the trial is extended once, to **300**. If it still fails, the feature is dropped: ranking adds nothing over the picks themselves. The threshold and limits are frozen for the trial, and any change starts a new version whose count restarts. If ADR 0003 replaces the pick rules, the count also restarts on the new rules.

## Considered Options

- **Always show at least 3 by relaxing thresholds**: rejected. Filler picks would either contradict match pages or dilute the record the list is meant to prove.
- **A separate model for the list**: rejected. Two answers for one match on the same site destroy trust.
- **Rank once in the morning from EARLY picks only**: rejected. The scored pick must be the LINEUP one, the same as in ADR 0003.
- **Publish now on rules-v0.3**: rejected. The bias found in ADR 0003 would put the most-biased picks at the top.

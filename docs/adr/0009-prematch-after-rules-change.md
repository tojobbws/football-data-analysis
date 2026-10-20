# A PREMATCH round when the pick rules change after a match's EARLY round

rules-v0.6 (ADR 0008) went live on 2026-10-20 at the 17:05 Thai run. That evening's matches had already published EARLY under rules-v0.5, some of them on far lines the new rules no longer allow (Liverpool -2.5 beside a -1.25 main line). Their match pages kept showing those picks until a LINEUP round, and a LINEUP round only comes when both lineups arrive in time. The owner asked for the matches to be corrected under the new rules at once.

The record is not edited (ADR 0005, ADR 0007). The PREMATCH round gets a second cause instead: **RULES_CHANGED**. A match gets it when all of these hold:

1. its EARLY round was published under pick rules other than the ones in force (`decision_rule_version` ≠ `DEFAULT_RULES.version`);
2. no LINEUP round and no PREMATCH round has been published, and kickoff is at least 15 minutes away;
3. the decision comes from the rules in force and is fresh enough (the usual 240 minutes).

It is published **whatever the new decision is**, pick or fog. It is published even when the decision equals the EARLY pick (Porto–PSV on 2026-10-20). The condition depends only on the rules version, never on the outcome, so it cannot be used to keep the favourable draws. The original GATES_RETUNED cause (ADR 0005) is unchanged.

**What changes for readers.** The match page and the lists show a match's latest round, so the PREMATCH round replaces the EARLY pick there. Its reason opens with "ก่อนเตะ หลังปรับกติกาให้วิเคราะห์เฉพาะเส้นหลักของตลาด". The home list of upcoming picks now takes each match's latest round first and keeps it only if it is a pick. Before this change, a later fog round left the earlier pick on the list. The daily featured list already re-ranks from each match's latest round.

**What does not change.** The EARLY rows, A000405 among them, stay in the record and are settled and counted on `/performance`. PREMATCH is reported as its own round. LINEUP still follows as usual. The shadow trial is judged on LINEUP and is unaffected. Matches that had already used their PREMATCH (Wolves, Roma, Man City on 2026-10-20) wait for LINEUP. Their latest round was fog already.

**First use, 2026-10-20** (read-only dry run before publishing): 15 matches qualified. Their latest v0.6 decisions:
- Fenerbahçe–Slavia: Slavia +1 (was +1.25)
- Sabah–Dortmund: Under 3.25 (was Under 4.0)
- Stuttgart–Atletico: Stuttgart +0.25 (was 0)
- Porto–PSV: PSV +1 (unchanged)
- Liverpool–Villarreal, PSG–Barcelona, Napoli–Bodø/Glimt, Al Diriyah–Al Riyadh, Al Taawon–Al-Qadisiyah: fog
- Six matches whose EARLY was already fog: fog

The round publishes the decision fresh at publish time, which may differ if prices moved.

The same rule applies to every later change of the pick rules: upcoming matches are re-published once under the new rules.

## Considered Options

- **Wait for LINEUP**: rejected by the owner. Far-line picks would stay on the pages for hours, and indefinitely where lineups never arrive.
- **Edit or hide the EARLY rows**: rejected. It breaks the record's central promise.
- **Re-publish only matches whose pick changes**: rejected. It makes publishing depend on the outcome.

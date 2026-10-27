# Hybrid AI rollout and rollback (ADR 0010)

Every step is a command the owner runs; nothing here is automatic. Production is unchanged until step 3.

## 0. Before

- `npx vitest run` and `npm run typecheck` pass on the branch.
- An AI key that works: with `OPENAI_API_KEY` and `OPENAI_MODEL` set the engine uses OpenAI, else Claude (`ANTHROPIC_API_KEY`, model `HYBRID_AI_MODEL` or claude-sonnet-5-5). On 2026-10-27 the Anthropic account answered "credit balance is too low"; OpenAI (`gpt-6-luna`) answered.
- Smoke test on real data, writes nothing: `npx tsx scripts/hybrid-smoke.ts --fixtures 3 --provider openai`. Every answer should say `valid: yes`.

## 1. Schema

```
npm run db:migrate      # applies 20261027000047_hybrid_ai_decisions.sql
```

Additive: a new table and a relaxed check that only accepts a missing model probability for `hybrid-*` engines.

## 2. Code

Merge and push the branch, then deploy the site (`npm run deploy -w @fp/web`; the site code is unchanged, the deploy keeps it in step with main). `PICK_ENGINE` is unset, so the hourly run behaves exactly as before.

## 3. Shadow

```
gh variable set PICK_ENGINE --body shadow
```

From the next hourly run the AI decides every due round; the rules still publish. Watch for at least a few days:

```sql
-- answers per status and decision, and how many tries they took
select status, side, count(*), round(avg(attempts), 2) attempts from hybrid_decisions group by 1, 2 order by 1, 2;
-- why answers were rejected
select fixture_id, publish_round, violations from hybrid_decisions where status <> 'OK' order by decided_at desc limit 20;
-- AI against the rules on the same round
select publish_round, side, legacy->>'outcome' rules, count(*) from hybrid_decisions where status = 'OK' group by 1, 2, 3 order by 1, 2, 3;
```

Go on only if INVALID/ERROR stay rare and the hourly job stays inside its time budget (`model:health`, the run log).

## 4. Hybrid

```
gh variable set PICK_ENGINE --body hybrid
```

Check after the next hourly run:

```sql
select public_id, publish_round, kind, market, selection, line, signal_strength, decision_rule_version, published_at
  from analysis_predictions where decision_rule_version like 'hybrid-%' order by published_at desc limit 20;
```

and a match page with an AI pick: the card shows the pick, the AI's reasoning lines and "วิเคราะห์โดย Hybrid AI". The rules keep running (`analysis_runs` keeps growing; `hybrid_decisions.legacy` has the rules' decision of each round).

## Rollback

```
gh variable set PICK_ENGINE --body legacy
```

Takes effect on the next hourly run: the AI stops, the rules publish again. Nothing is deleted; published AI picks stay in the record and settle normally. A fixture whose EARLY round came from the AI gets a PREMATCH round from the rules (ADR 0009). Only if no AI pick was ever published can the schema go back too (`supabase/rollbacks/0047_rollback.sql`; with AI picks published it keeps the table and the check by design).

-- =====================================================================
-- 0054 Hybrid AI majority of three (docs/adr/0013-hybrid-majority-of-three.md)
--
-- From prompt hybrid-ai-v1.6 the AI answers three times on the same input and the decision is the choice
-- at least two valid answers gave. `votes` keeps every answer's choice, in order:
--   [{ "status": "OK" | "INVALID" | "REFUSED" | "ERROR", "side": "FAVORITE" | ... | "NO_PICK" | null,
--      "confidence": "HIGH" | "MEDIUM" | "LOW" | null, "attempts": n }, ...]
-- `output` stays the raw answer the decision was taken from; `usage` and `attempts` are summed over all answers.
-- Null for decisions stored before v1.6 (one answer) and for rounds with no option (no AI call).
-- =====================================================================

alter table hybrid_decisions add column if not exists votes jsonb;

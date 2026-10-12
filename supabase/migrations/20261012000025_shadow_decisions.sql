-- =====================================================================
-- 0025 shadow_decisions: alternative pick rules run beside the real ones
--
-- The rules pick (rules-v0.3) leans to the underdog on almost every match, because
-- the model is less sharp than the market. rules-v0.4-shadow takes the model's usual
-- lean per selection and line off before measuring the edge. Its decision is kept
-- here, never published: one row per match and rules version, overwritten on each
-- pre-kickoff evaluation, so the row left at kickoff is the shadow pick.
-- Measured against results by `model:shadow-report`.
-- =====================================================================

create table if not exists shadow_decisions (
  fixture_id          bigint       not null references fixtures(id) on delete cascade,
  rules_version       text         not null,
  evaluated_at        timestamptz  not null,
  outcome             text         not null check (outcome in ('SIGNAL','NO_CLEAR_SIGNAL')),
  market              text,
  selection           text,
  line                numeric(5,2),
  odds                numeric(8,3),
  model_probability   numeric(6,5),
  bias                numeric(6,5),
  market_probability  numeric(6,5),
  edge                numeric(6,5),
  strength            text,
  passed              int          not null,
  primary key (fixture_id, rules_version)
);

alter table shadow_decisions enable row level security;

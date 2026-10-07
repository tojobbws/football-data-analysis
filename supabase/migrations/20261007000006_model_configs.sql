-- =====================================================================
-- 0006 MODEL CONFIGS (output of `npm run model:tune`)
-- Append-only history: every tuning run inserts new rows; the latest per
-- (league, purpose) is active. `enabled` = this market may produce
-- candidates (model beat league base rates on a time-split holdout).
-- =====================================================================

create table if not exists model_configs (
  id                bigint generated always as identity primary key,
  league_id         int  not null references leagues(id),
  purpose           text not null check (purpose in ('SIDES','TOTALS','ELO','ENSEMBLE')),
  model_version_id  text not null,
  params            jsonb not null,
  metrics           jsonb not null,
  enabled           boolean not null,
  matches_evaluated int  not null,
  tuned_at          timestamptz not null default now()
);
create index if not exists model_configs_lookup_idx on model_configs (league_id, purpose, tuned_at desc);

drop trigger if exists model_configs_immutable on model_configs;
create trigger model_configs_immutable before update or delete on model_configs
  for each row execute function fp_reject_change();

create or replace view model_configs_latest as
select distinct on (league_id, purpose) *
from model_configs
order by league_id, purpose, tuned_at desc, id desc;

alter table model_configs enable row level security;
drop policy if exists model_configs_public_read on model_configs;
create policy model_configs_public_read on model_configs for select to anon, authenticated using (true);
alter view model_configs_latest set (security_invoker = true);

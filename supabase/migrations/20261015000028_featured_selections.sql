-- =====================================================================
-- 0028 featured_selections: the daily featured list (คู่เด่นประจำวัน), in shadow
-- (see docs/adr/0004-daily-featured-shadow.md)
--
-- One row per football day, list version and match. Every hourly run recomputes the
-- RESERVED slots from the matches not locked yet; at its LINEUP round a match is locked:
--   CONFIRMED  held a reserved slot then (counts in the record)
--   DROPPED    had been reserved, but not any more at its LINEUP round
--   SKIPPED    was never reserved
-- A locked row never changes again. Outcome, closing odds and CLV are read through the
-- prediction, never copied. Admin only: no fan-facing query reads this table.
-- =====================================================================

create table if not exists featured_selections (
  football_date      date         not null,
  version            text         not null,
  fixture_id         bigint       not null references fixtures(id) on delete cascade,
  league_id          int          not null,
  phase              text         not null check (phase in ('RESERVED','CONFIRMED','DROPPED','SKIPPED')),
  rank               int,
  prediction_id      bigint       references analysis_predictions(id),
  support_score      numeric(6,3),
  fair_probability   numeric(6,5),
  first_reserved_at  timestamptz,
  first_rank         int,
  updated_at         timestamptz  not null default now(),
  locked_at          timestamptz,
  primary key (football_date, version, fixture_id),
  check ((phase = 'RESERVED') = (locked_at is null))
);
create index if not exists featured_selections_fixture_idx on featured_selections (fixture_id);

create or replace function fp_featured_guard() returns trigger
language plpgsql as $$
begin
  if old.locked_at is not null then
    raise exception 'featured selection % / % / % is locked', old.football_date, old.version, old.fixture_id;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;

drop trigger if exists featured_selections_guard on featured_selections;
create trigger featured_selections_guard
  before update or delete on featured_selections
  for each row execute function fp_featured_guard();

alter table featured_selections enable row level security;

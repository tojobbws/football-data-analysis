-- =====================================================================
-- 0003 ANALYSIS / 🧭 เข็มทิศเกม / IMMUTABLE TRACK RECORD
--
-- Guarantees enforced by the DATABASE (not by app code):
--  * A prediction can only be published BEFORE kickoff (server clock).
--  * published_at is always set by the DB (no backdating).
--  * Content of a published prediction can never change.
--  * Settlement fields can be written once: PENDING -> final status.
--  * Rows can never be deleted or truncated.
--  * Every prediction is hash-chained (record_hash = sha256(prev_hash | content)).
--    Publish the daily chain head publicly (e.g. on X) -> anyone can verify
--    that no past record was rewritten.
-- =====================================================================

create table if not exists model_versions (
  id           text primary key,                 -- e.g. 'dixon-coles-v0.1'
  description  text,
  params       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

-- Output of the Statistical / Probability Engine (NOT the LLM)
create table if not exists probability_predictions (
  id                bigint generated always as identity primary key,
  fixture_id        bigint not null references fixtures(id),
  model_version_id  text   not null references model_versions(id),
  computed_at       timestamptz not null default now(),
  market            text   not null check (market in ('MATCH_WINNER','ASIAN_HANDICAP','OVER_UNDER','OTHER')),
  selection         text   not null,
  line              numeric(5,2),
  probability       numeric(6,5) not null check (probability >= 0 and probability <= 1),
  inputs            jsonb,
  unique nulls not distinct (fixture_id, model_version_id, computed_at, market, selection, line)
);
create index if not exists probability_predictions_fixture_idx on probability_predictions (fixture_id, computed_at desc);

create table if not exists analysis_runs (
  id                     uuid primary key default gen_random_uuid(),
  fixture_id             bigint not null references fixtures(id),
  model_version_id       text references model_versions(id),
  decision_rule_version  text,
  prompt_version         text,
  outcome                text check (outcome in ('SIGNAL','NO_CLEAR_SIGNAL','ABORTED')),
  notes                  text,
  started_at             timestamptz not null default now(),
  finished_at            timestamptz
);

-- Every market option evaluated BEFORE the decision (kept for "why not the others")
create table if not exists analysis_candidates (
  id                  bigint generated always as identity primary key,
  run_id              uuid   not null references analysis_runs(id),
  fixture_id          bigint not null references fixtures(id),
  market              text   not null,
  selection           text   not null,
  line                numeric(5,2),
  bookmaker_id        int,
  odds                numeric(8,3),
  model_probability   numeric(6,5) not null check (model_probability between 0 and 1),
  market_probability  numeric(6,5) check (market_probability between 0 and 1),  -- no-vig implied
  edge                numeric(6,5) generated always as (model_probability - market_probability) stored,
  support_score       numeric(6,3),
  rank                int,
  factors             jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists analysis_candidates_run_idx on analysis_candidates (run_id);

drop trigger if exists analysis_candidates_immutable on analysis_candidates;
create trigger analysis_candidates_immutable before update or delete on analysis_candidates
  for each row execute function fp_reject_change();

drop trigger if exists probability_predictions_immutable on probability_predictions;
create trigger probability_predictions_immutable before update or delete on probability_predictions
  for each row execute function fp_reject_change();

-- ---------------------------------------------------------------------
-- Published analysis (the track record)
-- ---------------------------------------------------------------------
create table if not exists analysis_predictions (
  id                     bigint generated always as identity primary key,
  chain_seq              bigint unique,               -- set by trigger
  public_id              text   unique,               -- set by trigger, e.g. A000123
  fixture_id             bigint not null references fixtures(id),
  publish_round          text   not null default 'PREMATCH' check (publish_round in ('EARLY','PREMATCH','LINEUP')),
  run_id                 uuid   references analysis_runs(id),
  candidate_id           bigint references analysis_candidates(id),
  kind                   text   not null check (kind in ('SIGNAL','NO_CLEAR_SIGNAL')),

  market                 text check (market in ('MATCH_WINNER','ASIAN_HANDICAP','OVER_UNDER','OTHER')),
  selection              text,
  line                   numeric(5,2),
  bookmaker_id           int references bookmakers(id),
  odds_at_publish        numeric(8,3),
  model_probability      numeric(6,5) check (model_probability between 0 and 1),
  market_probability     numeric(6,5) check (market_probability between 0 and 1),
  signal_strength        text check (signal_strength in ('STRONG','MEDIUM','LEAN')),
  reason                 text,

  model_version_id       text references model_versions(id),
  decision_rule_version  text,
  prompt_version         text,

  kickoff_at             timestamptz not null,        -- copied from fixture by trigger
  published_at           timestamptz not null default now(),
  prev_hash              text not null default '',
  record_hash            text not null default '',

  -- settlement (write-once)
  status                 text not null default 'PENDING'
                         check (status in ('PENDING','WIN','HALF_WIN','LOSS','HALF_LOSS','PUSH','VOID','NO_SIGNAL')),
  result_score           text,
  settled_at             timestamptz,
  closing_odds           numeric(8,3),
  closing_line           numeric(5,2),
  clv                    numeric(8,5),

  created_at             timestamptz not null default now(),

  unique (fixture_id, publish_round),
  check (kind = 'NO_CLEAR_SIGNAL'
         or (market is not null and selection is not null and model_probability is not null))
);
create index if not exists analysis_predictions_published_idx on analysis_predictions (published_at desc);
create index if not exists analysis_predictions_status_idx on analysis_predictions (status);

-- Canonical text of the immutable content (input to the hash)
create or replace function fp_prediction_canonical(p analysis_predictions) returns text
language sql stable as $$
  select jsonb_build_object(
    'chain_seq',             p.chain_seq,
    'public_id',             p.public_id,
    'fixture_id',            p.fixture_id,
    'publish_round',         p.publish_round,
    'kind',                  p.kind,
    'market',                p.market,
    'selection',             p.selection,
    'line',                  p.line,
    'bookmaker_id',          p.bookmaker_id,
    'odds_at_publish',       p.odds_at_publish,
    'model_probability',     p.model_probability,
    'market_probability',    p.market_probability,
    'signal_strength',       p.signal_strength,
    'reason',                p.reason,
    'model_version_id',      p.model_version_id,
    'decision_rule_version', p.decision_rule_version,
    'prompt_version',        p.prompt_version,
    'kickoff_at',            to_char(p.kickoff_at   at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'published_at',          to_char(p.published_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  )::text
$$;

create or replace function fp_prediction_hash(p analysis_predictions) returns text
language sql stable as $$
  select encode(sha256(convert_to(p.prev_hash || '|' || fp_prediction_canonical(p), 'UTF8')), 'hex')
$$;

create or replace function fp_prediction_before_insert() returns trigger
language plpgsql as $$
declare
  v_kickoff  timestamptz;
  v_status   text;
  v_seq      bigint;
  v_hash     text;
begin
  select kickoff_at, status_short into v_kickoff, v_status from fixtures where id = new.fixture_id;
  if not found then
    raise exception 'fixture % not found', new.fixture_id;
  end if;
  if v_status not in ('NS','TBD') or v_kickoff <= now() then
    raise exception 'cannot publish analysis for fixture %: match already started (status %, kickoff %)',
      new.fixture_id, v_status, v_kickoff using errcode = 'P0001';
  end if;

  new.kickoff_at   := v_kickoff;
  new.published_at := now();          -- DB clock; client cannot backdate
  new.created_at   := now();
  new.status       := case when new.kind = 'NO_CLEAR_SIGNAL' then 'NO_SIGNAL' else 'PENDING' end;
  new.result_score := null;
  new.settled_at   := null;
  new.closing_odds := null;
  new.closing_line := null;
  new.clv          := null;

  -- serialise the hash chain
  perform pg_advisory_xact_lock(hashtext('fp_analysis_predictions_chain'));
  select chain_seq, record_hash into v_seq, v_hash
    from analysis_predictions order by chain_seq desc limit 1;

  new.chain_seq   := coalesce(v_seq, 0) + 1;
  new.public_id   := 'A' || lpad(new.chain_seq::text, 6, '0');
  new.prev_hash   := coalesce(v_hash, 'GENESIS');
  new.record_hash := fp_prediction_hash(new);
  return new;
end $$;

create or replace function fp_prediction_before_update() returns trigger
language plpgsql as $$
declare
  v_fixture_status text;
begin
  -- 1) published content is frozen
  if fp_prediction_canonical(new) is distinct from fp_prediction_canonical(old)
     or new.record_hash  is distinct from old.record_hash
     or new.prev_hash    is distinct from old.prev_hash
     or new.run_id       is distinct from old.run_id
     or new.candidate_id is distinct from old.candidate_id
     or new.created_at   is distinct from old.created_at
     or new.id           is distinct from old.id then
    raise exception 'published analysis % is immutable', old.public_id using errcode = 'P0001';
  end if;

  -- 2) closing-line data: write once
  if (old.closing_odds is not null and new.closing_odds is distinct from old.closing_odds)
     or (old.closing_line is not null and new.closing_line is distinct from old.closing_line)
     or (old.clv is not null and new.clv is distinct from old.clv) then
    raise exception 'closing data of % already recorded', old.public_id using errcode = 'P0001';
  end if;

  -- 3) settlement: PENDING -> final, exactly once
  if new.status is distinct from old.status then
    if old.status <> 'PENDING' then
      raise exception 'analysis % already settled as %', old.public_id, old.status using errcode = 'P0001';
    end if;
    if new.status not in ('WIN','HALF_WIN','LOSS','HALF_LOSS','PUSH','VOID') then
      raise exception 'invalid settlement status %', new.status using errcode = 'P0001';
    end if;
    select status_short into v_fixture_status from fixtures where id = old.fixture_id;
    if new.status <> 'VOID' and v_fixture_status not in ('FT','AET','PEN') then
      raise exception 'fixture % not finished (status %)', old.fixture_id, v_fixture_status using errcode = 'P0001';
    end if;
    new.settled_at := now();
  elsif new.settled_at is distinct from old.settled_at
        or new.result_score is distinct from old.result_score then
    raise exception 'settlement fields of % can only change together with status', old.public_id using errcode = 'P0001';
  end if;

  return new;
end $$;

drop trigger if exists analysis_predictions_insert on analysis_predictions;
create trigger analysis_predictions_insert before insert on analysis_predictions
  for each row execute function fp_prediction_before_insert();

drop trigger if exists analysis_predictions_update on analysis_predictions;
create trigger analysis_predictions_update before update on analysis_predictions
  for each row execute function fp_prediction_before_update();

drop trigger if exists analysis_predictions_no_delete on analysis_predictions;
create trigger analysis_predictions_no_delete before delete on analysis_predictions
  for each row execute function fp_reject_change();

drop trigger if exists analysis_predictions_no_truncate on analysis_predictions;
create trigger analysis_predictions_no_truncate before truncate on analysis_predictions
  for each statement execute function fp_reject_change();

-- Re-computes the whole chain; any row with ok = false was tampered with.
create or replace function fp_verify_prediction_chain()
returns table (chain_seq bigint, public_id text, ok boolean, stored_hash text, expected_hash text)
language sql stable as $$
  select
    p.chain_seq,
    p.public_id,
    (p.prev_hash = coalesce(lag(p.record_hash) over (order by p.chain_seq), 'GENESIS')
       and p.record_hash = fp_prediction_hash(p)) as ok,
    p.record_hash,
    fp_prediction_hash(p)
  from analysis_predictions p
  order by p.chain_seq
$$;

-- Daily chain head (Bangkok time) -> post publicly every day
create or replace view prediction_chain_daily as
select distinct on (day) day, chain_seq, public_id, record_hash
from (
  select (published_at at time zone 'Asia/Bangkok')::date as day, chain_seq, public_id, record_hash
  from analysis_predictions
) t
order by day, chain_seq desc;

-- ---------------------------------------------------------------------
-- Snapshot of everything the system knew at publish time (insert-only)
-- ---------------------------------------------------------------------
create table if not exists analysis_snapshots (
  id                       bigint generated always as identity primary key,
  analysis_prediction_id   bigint not null unique references analysis_predictions(id),
  form_snapshot            jsonb,
  xg_snapshot              jsonb,
  injury_snapshot          jsonb,
  lineup_snapshot          jsonb,
  odds_snapshot            jsonb,
  market_snapshot          jsonb,
  api_prediction_snapshot  jsonb,
  model_snapshot           jsonb,
  candidates_snapshot      jsonb,
  ai_reasoning             jsonb,
  snapshot_hash            text not null default '',
  created_at               timestamptz not null default now()
);

create or replace function fp_snapshot_before_insert() returns trigger
language plpgsql as $$
declare
  v_kickoff timestamptz;
begin
  select kickoff_at into v_kickoff from analysis_predictions where id = new.analysis_prediction_id;
  if v_kickoff is null or v_kickoff <= now() then
    raise exception 'snapshot must be stored before kickoff' using errcode = 'P0001';
  end if;
  new.created_at := now();
  new.snapshot_hash := encode(sha256(convert_to(jsonb_build_object(
    'form', new.form_snapshot, 'xg', new.xg_snapshot, 'injury', new.injury_snapshot,
    'lineup', new.lineup_snapshot, 'odds', new.odds_snapshot, 'market', new.market_snapshot,
    'api_prediction', new.api_prediction_snapshot, 'model', new.model_snapshot,
    'candidates', new.candidates_snapshot, 'ai', new.ai_reasoning
  )::text, 'UTF8')), 'hex');
  return new;
end $$;

drop trigger if exists analysis_snapshots_insert on analysis_snapshots;
create trigger analysis_snapshots_insert before insert on analysis_snapshots
  for each row execute function fp_snapshot_before_insert();

drop trigger if exists analysis_snapshots_immutable on analysis_snapshots;
create trigger analysis_snapshots_immutable before update or delete on analysis_snapshots
  for each row execute function fp_reject_change();

-- ---------------------------------------------------------------------
-- 📊 Performance (computed from the immutable records, never stored by hand)
-- Win rate: HALF_WIN / HALF_LOSS count as half a decided result.
-- ---------------------------------------------------------------------
create or replace view analysis_performance as
with base as (
  select p.*, f.league_id,
         to_char(p.published_at at time zone 'Asia/Bangkok', 'YYYY-MM') as month
  from analysis_predictions p
  join fixtures f on f.id = p.fixture_id
)
select
  case
    when grouping(market)    = 0 then 'market'
    when grouping(league_id) = 0 then 'league'
    when grouping(month)     = 0 then 'month'
    else 'all'
  end as dimension,
  coalesce(market, league_id::text, month, 'ALL') as bucket,
  count(*) filter (where kind = 'SIGNAL')           as total_signals,
  count(*) filter (where kind = 'NO_CLEAR_SIGNAL')  as no_signal,
  count(*) filter (where status = 'PENDING')        as pending,
  count(*) filter (where status = 'WIN')            as win,
  count(*) filter (where status = 'HALF_WIN')       as half_win,
  count(*) filter (where status = 'LOSS')           as loss,
  count(*) filter (where status = 'HALF_LOSS')      as half_loss,
  count(*) filter (where status = 'PUSH')           as push,
  count(*) filter (where status = 'VOID')           as void,
  round(
    (count(*) filter (where status = 'WIN') + 0.5 * count(*) filter (where status = 'HALF_WIN'))::numeric
    / nullif(count(*) filter (where status in ('WIN','LOSS'))
             + 0.5 * count(*) filter (where status in ('HALF_WIN','HALF_LOSS')), 0)
  , 4) as win_rate,
  round(avg(clv), 5) as avg_clv,
  round(avg(case when clv > 0 then 1.0 when clv is not null then 0.0 end), 4) as beat_closing_rate
from base
group by grouping sets ((), (market), (league_id), (month));

-- Calibration: when the model says ~60%, does it happen ~60% of the time?
create or replace view analysis_calibration as
select
  width_bucket(model_probability, 0, 1, 10) as bucket,
  round(min(model_probability), 3) as p_min,
  round(max(model_probability), 3) as p_max,
  round(avg(model_probability), 4) as avg_model_probability,
  count(*) as n,
  round(
    (count(*) filter (where status = 'WIN') + 0.5 * count(*) filter (where status = 'HALF_WIN'))::numeric
    / nullif(count(*) filter (where status in ('WIN','LOSS'))
             + 0.5 * count(*) filter (where status in ('HALF_WIN','HALF_LOSS')), 0)
  , 4) as actual_win_rate
from analysis_predictions
where kind = 'SIGNAL' and status in ('WIN','HALF_WIN','LOSS','HALF_LOSS')
group by 1
order by 1;

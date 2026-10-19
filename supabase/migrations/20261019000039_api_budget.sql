-- =====================================================================
-- 0039 API-Football request budget (slice 05)
--
-- The plan allows 7,500 requests a day (the API's day starts at 00:00 UTC). Measured over 2026-10-05..18:
-- busiest day 4,952 attempts; live polling 2,800+ attempts of which ~60% were rejected by the per-minute
-- rate limit, and rejected requests do NOT count against the day (checked against /status).
-- So sync_runs.requests_used now holds the requests that count, and requests_rejected the ones the API refused.
--
--   api_job_groups  which budget group a job belongs to (a job not listed is in 'sync')
--   api_budgets     per group: the day's cap, and whether a job in the group is skipped once it is reached
--   'critical'      results, lineups: counted, never skipped (settlement and the LINEUP round depend on them)
--
-- A job that finds its group's cap reached does not call the API: it records a skipped run
-- (params.skipped = 'budget') and does nothing, so re-running it later is always safe.
-- Admin-only: nothing here is readable by anon.
-- =====================================================================

alter table sync_runs add column if not exists requests_rejected int not null default 0;
alter table sync_runs add column if not exists api_daily_remaining int;

create table if not exists api_budgets (
  group_name  text primary key,
  daily_cap   int         not null check (daily_cap >= 0),
  enforced    boolean     not null default true,
  note        text,
  updated_at  timestamptz not null default now()
);

create table if not exists api_job_groups (
  job         text primary key,
  group_name  text not null references api_budgets(group_name)
);

insert into api_budgets (group_name, daily_cap, enforced, note) values
  ('live',     2000, true,  'live score polling'),
  ('odds',     3000, true,  'odds-sync'),
  ('sync',     1500, true,  'everything else: fixtures, details, injuries, predictions, standings, players, support'),
  ('critical', 1000, false, 'results and lineups: counted, never skipped (reserve)')
on conflict do nothing;

insert into api_job_groups (job, group_name) values
  ('live', 'live'), ('odds', 'odds'), ('results', 'critical'), ('lineups', 'critical')
on conflict do nothing;

create index if not exists sync_runs_started_idx on sync_runs (started_at desc);

alter table api_budgets enable row level security;
alter table api_job_groups enable row level security;
drop policy if exists api_budgets_admin_read on api_budgets;
create policy api_budgets_admin_read on api_budgets for select to authenticated using (fp_is_admin());
drop policy if exists api_job_groups_admin_read on api_job_groups;
create policy api_job_groups_admin_read on api_job_groups for select to authenticated using (fp_is_admin());

-- Today's use and cap per group (the API day starts at 00:00 UTC), for the job guard and the admin page.
create or replace function fp_api_usage_today() returns table (group_name text, used int, daily_cap int, enforced boolean, ratio numeric)
language sql stable as $$
  select b.group_name,
         coalesce(u.used, 0)::int,
         b.daily_cap,
         b.enforced,
         case when b.daily_cap = 0 then null else round(coalesce(u.used, 0)::numeric / b.daily_cap, 3) end
    from api_budgets b
    left join (
      select coalesce(j.group_name, 'sync') as g, sum(r.requests_used) as used
        from sync_runs r
        left join api_job_groups j on j.job = r.job
       where r.started_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
       group by 1
    ) u on u.g = b.group_name
   order by b.group_name;
$$;
revoke all on function fp_api_usage_today() from public, anon, authenticated;

-- For /admin: today per group, the last 7 UTC days, and the API's own remaining count from the latest run.
create or replace function fp_admin_api_usage() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not fp_is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'today', coalesce((select jsonb_agg(to_jsonb(t)) from fp_api_usage_today() t), '[]'::jsonb),
    'days', coalesce((
      select jsonb_agg(d order by d->>'day' desc) from (
        select jsonb_build_object('day', (r.started_at at time zone 'utc')::date, 'requests', sum(r.requests_used)::int, 'rejected', sum(r.requests_rejected)::int) as d
          from sync_runs r
         where r.started_at >= (date_trunc('day', now() at time zone 'utc') - interval '6 days') at time zone 'utc'
         group by (r.started_at at time zone 'utc')::date
      ) x), '[]'::jsonb),
    'remaining', (select api_daily_remaining from sync_runs where api_daily_remaining is not null order by started_at desc limit 1),
    'remaining_at', (select started_at from sync_runs where api_daily_remaining is not null order by started_at desc limit 1)
  );
end $$;
revoke all on function fp_admin_api_usage() from public;
grant execute on function fp_admin_api_usage() to authenticated;

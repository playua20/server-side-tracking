-- ─────────────────────────────────────────────────────────────────────────
-- track-demo — database schema
-- Run this once in Supabase → SQL Editor → New query → paste → Run.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists events (
  id          bigint generated always as identity primary key,
  type        text not null default 'pageview',   -- pageview / click / lead / test
  site        text,                                -- which lander sent it (data-site)
  clickid     text,
  sub1 text, sub2 text, sub3 text, sub4 text, sub5 text,
  country     text,                                -- real geo, from the edge
  city        text,
  device      text,                                -- mobile / tablet / desktop
  browser     text,
  os          text,
  referer     text,
  user_agent  text,
  -- Salted SHA-256 of the IP, for rate limiting only: visitors are counted,
  -- never identified, and the raw IP is never stored.
  ip_hash     text,
  created_at  timestamptz not null default now()
);

-- Safe to re-run on a table created before the rate limiter existed.
alter table events add column if not exists ip_hash text;

create index if not exists idx_events_created  on events (created_at desc);
create index if not exists idx_events_type     on events (type);
create index if not exists idx_events_country  on events (country);
create index if not exists idx_events_ip       on events (ip_hash, created_at desc);

-- ─── Aggregate views the dashboard reads (server-side, via service_role) ───
-- security_invoker: a plain view runs as its owner and would bypass RLS,
-- exposing the aggregates to the public anon key. With it, RLS applies.

create or replace view stats_by_type with (security_invoker = true) as
  select type, count(*)::int as n
  from events group by type order by n desc;

create or replace view stats_by_country with (security_invoker = true) as
  select coalesce(country, '??') as country, count(*)::int as n
  from events group by 1 order by n desc;

create or replace view stats_by_device with (security_invoker = true) as
  select coalesce(device, 'unknown') as device, count(*)::int as n
  from events group by 1 order by n desc;

-- Newest first, so `limit 48` means "the last 48 hours"; the API re-sorts for the chart.
create or replace view stats_by_hour with (security_invoker = true) as
  select date_trunc('hour', created_at) as hour, count(*)::int as n
  from events group by 1 order by 1 desc;

-- RLS stays ON (enabled at project creation). No policies are added on purpose:
-- only the server's service_role key touches this data, and it bypasses RLS.
-- The public/anon role therefore has no access — which is exactly what we want.
alter table events enable row level security;

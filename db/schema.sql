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
create index if not exists idx_events_clickid  on events (clickid);

-- ─── Conversions: what a network's S2S postback creates ───────────────────
-- A postback says "click X converted, here is the payout". It knows nothing
-- about the traffic source — the campaign/ad ids live on the click itself, so
-- they are copied here at match time. That copy is what makes a per-ad revenue
-- report possible with one query instead of a join per row.
create table if not exists conversions (
  id         bigint generated always as identity primary key,
  -- The network's own transaction id. UNIQUE is the whole idempotency story:
  -- networks retry on timeout, and a retry must not create a second payout.
  txid       text not null unique,
  clickid    text not null,
  event_id   bigint references events (id) on delete set null,
  status     text not null default 'pending',   -- pending / approved / rejected
  payout     numeric(12, 2) not null default 0,
  currency   text not null default 'USD',
  -- Copied from the matched click (Facebook macros: campaign / adset / ad).
  sub1 text, sub2 text, sub3 text,
  country    text,
  -- False when no click with that clickid exists. Real traffic produces these
  -- (lost pixel, cleared storage), and hiding them would fake the numbers.
  matched    boolean not null default false,
  -- Same salted hash as events: the caller is rate limited, never identified.
  ip_hash    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table conversions add column if not exists ip_hash text;

create index if not exists idx_conv_created on conversions (created_at desc);
create index if not exists idx_conv_clickid on conversions (clickid);

alter table conversions enable row level security;

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

-- Revenue counts approved conversions only: a rejected one is a reversal, and
-- pending money is not money. That is the same rule every network report uses.
create or replace view stats_conversions with (security_invoker = true) as
  select count(*)::int                                                as n,
         count(*) filter (where status = 'approved')::int             as approved,
         count(*) filter (where status = 'pending')::int              as pending,
         count(*) filter (where status = 'rejected')::int             as rejected,
         count(*) filter (where not matched)::int                     as orphans,
         coalesce(sum(payout) filter (where status = 'approved'), 0)::numeric(12,2) as revenue
  from conversions;

-- The point of the whole chain: which ad actually paid. sub1/sub3 arrive on the
-- click from the ad platform's macros and are copied onto the conversion.
create or replace view stats_by_ad with (security_invoker = true) as
  select coalesce(sub1, '—') as campaign,
         coalesce(sub3, '—') as ad,
         count(*)::int       as conversions,
         coalesce(sum(payout) filter (where status = 'approved'), 0)::numeric(12,2) as revenue
  from conversions
  group by 1, 2
  order by revenue desc, conversions desc;

-- RLS stays ON (enabled at project creation). No policies are added on purpose:
-- only the server's service_role key touches this data, and it bypasses RLS.
-- The public/anon role therefore has no access — which is exactly what we want.
alter table events enable row level security;

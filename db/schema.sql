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
-- Ad-platform click identifiers, needed to match a server event to its click:
-- fbclid comes in the landing URL, _fbp is the cookie the browser pixel sets.
alter table events add column if not exists fbclid text;
alter table events add column if not exists fbp text;

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
-- A network may pass the lead's e-mail or phone. They are hashed at the door
-- (SHA-256, after Meta's normalisation) and only the hash is stored, so the
-- database never holds a readable address even for a moment.
alter table conversions add column if not exists em_hash text;
alter table conversions add column if not exists ph_hash text;

create index if not exists idx_conv_created on conversions (created_at desc);
create index if not exists idx_conv_clickid on conversions (clickid);

alter table conversions enable row level security;

-- ─── CAPI deliveries: what we send OUTWARD, and what came back ────────────
-- The browser pixel gets blocked, so the server tells the ad platform about a
-- conversion itself. Every attempt is recorded: the exact payload, the HTTP
-- answer, the latency and the attempt number. A delivery pipeline you cannot
-- inspect is a delivery pipeline you cannot debug.
create table if not exists capi_deliveries (
  id            bigint generated always as identity primary key,
  conversion_id bigint references conversions (id) on delete cascade,
  -- Dedupe key, shared with the browser pixel: the platform drops a duplicate
  -- when both sides send the same event_id, and so do we before even sending.
  event_id      text not null unique,
  event_name    text not null default 'Lead',
  destination   text not null,                    -- 'meta' or 'sink'
  status        text not null default 'pending',  -- pending / delivered / failed / skipped
  http_status   int,
  attempts      int not null default 0,
  latency_ms    int,
  request       jsonb,                            -- exactly what was sent
  response      jsonb,                            -- exactly what came back
  next_try_at   timestamptz,                      -- set when a retry is due
  -- How many times the same event_id was offered again after delivery. Kept as
  -- a counter rather than extra rows: the duplicate is suppressed, not hidden.
  duplicates    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_capi_created on capi_deliveries (created_at desc);
create index if not exists idx_capi_retry   on capi_deliveries (status, next_try_at);

alter table capi_deliveries enable row level security;

create or replace view stats_capi with (security_invoker = true) as
  select count(*)::int                                            as n,
         count(*) filter (where status = 'delivered')::int         as delivered,
         count(*) filter (where status = 'failed')::int            as failed,
         count(*) filter (where status = 'skipped')::int           as skipped,
         coalesce(round(avg(latency_ms) filter (where status = 'delivered')), 0)::int as avg_ms
  from capi_deliveries;

-- ─── Aggregate views the dashboard reads (server-side, via service_role) ───
-- security_invoker: a plain view runs as its owner and would bypass RLS,
-- exposing the aggregates to the public anon key. With it, RLS applies.

-- Unique visitors, the figure a tracker's admin panel actually shows. Counted
-- from the salted IP hash we already keep for rate limiting: the number is real
-- and the addresses behind it were never stored.
create or replace view stats_overview with (security_invoker = true) as
  select count(*)::int                    as events,
         count(distinct ip_hash)::int     as visitors
  from events;

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

-- ─── One call for the whole dashboard, with the filters applied ───────────
-- The views above answer "everything, for all time", which is what a single
-- source needs and no more. A panel has a period and a source selector, and
-- those cannot be baked into a view — so the aggregation moves here, where the
-- filters are arguments and the work stays in the database. One round trip
-- instead of ten, and it keeps working when the table is not tiny.
create or replace function dashboard_stats(p_site text default null,
                                           p_since timestamptz default null)
returns jsonb
language sql
stable
security invoker
as $$
  with ev as (
    select * from events
    where (p_site is null or site = p_site)
      and (p_since is null or created_at >= p_since)
  ), cv as (
    select c.* from conversions c
    -- A conversion belongs to the source of the click it was matched to.
    where (p_site is null or exists (
            select 1 from events e where e.id = c.event_id and e.site = p_site))
      and (p_since is null or c.created_at >= p_since)
  )
  select jsonb_build_object(
    'total',    (select count(*) from ev),
    'visitors', (select count(distinct ip_hash) from ev),
    'byType',   (select coalesce(jsonb_agg(jsonb_build_object('type', type, 'n', n) order by n desc), '[]')
                 from (select type, count(*)::int as n from ev group by type) t),
    'byCountry',(select coalesce(jsonb_agg(jsonb_build_object('country', country, 'n', n) order by n desc), '[]')
                 from (select coalesce(country, '??') as country, count(*)::int as n
                       from ev group by 1 order by 2 desc limit 12) t),
    'byDevice', (select coalesce(jsonb_agg(jsonb_build_object('device', device, 'n', n) order by n desc), '[]')
                 from (select coalesce(device, 'unknown') as device, count(*)::int as n from ev group by 1) t),
    'byHour',   (select coalesce(jsonb_agg(jsonb_build_object('hour', hour, 'n', n) order by hour), '[]')
                 from (select date_trunc('hour', created_at) as hour, count(*)::int as n
                       from ev group by 1 order by 1 desc limit 48) t),
    'sites',    (select coalesce(jsonb_agg(site order by site), '[]')
                 from (select distinct site from events where site is not null) s),
    'recent',   (select coalesce(jsonb_agg(r), '[]') from (
                   select type, site, country, device, browser, created_at
                   from ev order by created_at desc limit 30) r),
    'conversions', (select jsonb_build_object(
                     'n', count(*),
                     'approved', count(*) filter (where status = 'approved'),
                     'pending',  count(*) filter (where status = 'pending'),
                     'rejected', count(*) filter (where status = 'rejected'),
                     'orphans',  count(*) filter (where not matched),
                     'revenue',  coalesce(sum(payout) filter (where status = 'approved'), 0)) from cv),
    'byAd',     (select coalesce(jsonb_agg(to_jsonb(x) order by x.revenue desc, x.conversions desc), '[]') from (
                   select coalesce(sub1, '—') as campaign,
                          coalesce(sub3, '—') as ad,
                          count(*)::int       as conversions,
                          coalesce(sum(payout) filter (where status = 'approved'), 0)::numeric(12,2) as revenue
                   from cv group by 1, 2 order by revenue desc limit 10) x),
    'capi',     (select jsonb_build_object(
                   'n', count(*),
                   'delivered', count(*) filter (where status = 'delivered'),
                   'failed',    count(*) filter (where status = 'failed'),
                   'skipped',   count(*) filter (where status = 'skipped'),
                   'avg_ms',    coalesce(round(avg(latency_ms) filter (where status = 'delivered')), 0))
                 from capi_deliveries d
                 where p_site is null or exists (
                   select 1 from cv where cv.id = d.conversion_id)),
    'deliveries', (select coalesce(jsonb_agg(d order by (d->>'created_at') desc), '[]') from (
                   select to_jsonb(x) as d from (
                     select id, event_id, event_name, destination, status, http_status,
                            attempts, latency_ms, duplicates, request, response, created_at
                     from capi_deliveries
                     where p_site is null or exists (select 1 from cv where cv.id = conversion_id)
                     order by created_at desc limit 10) x) y)
  );
$$;

-- RLS stays ON (enabled at project creation). No policies are added on purpose:
-- only the server's service_role key touches this data, and it bypasses RLS.
-- The public/anon role therefore has no access — which is exactly what we want.
alter table events enable row level security;

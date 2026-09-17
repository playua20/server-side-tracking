# Track Demo — live server-side tracking dashboard

A tiny **server-side tracking pixel + public live dashboard**. A one-line snippet
on any lander sends events to a serverless endpoint, which records the visitor's
**real** country/device (from the edge) into Postgres. A public dashboard renders
it live — click a button and watch your own event appear in seconds.

**Live demo: https://server-side-pixel.vercel.app** — click the button and your own
event shows up, with the country and device the server read from your request.

Portfolio piece for an **Affiliate / AdTech front-end developer**: it shows the
full data path — event → server-side capture → DB → visualization — the same
model as Google/Meta pixels, but self-owned and resistant to ad-blockers.

## Stack (all free tier)

- **Vercel** — hosting + Node serverless functions (`/api/*`), Fluid Compute.
- **Supabase** — Postgres database (accessed server-side via `service_role`).
- **Chart.js** — dashboard charts (CDN, no build step).

## How it works — demo vs production

Same principle in both, different stack. The **demo** (this repo) runs free and
always-online on serverless; the **production** build for a real client runs on
ordinary **PHP + MySQL shared hosting**.

### 1. Demo — Node + Vercel + Supabase (this repo)

```
lander (t.js snippet)  ──POST──▶  /api/track (Node)  ──▶  Supabase / Postgres
                                                               │
   public dashboard   ◀──JSON──   /api/stats (Node)  ◀─────────┘
   (index.html + Chart.js)        (one aggregate function)
```

### 2. Production — PHP + MySQL on shared hosting (reference architecture, not in this repo)

```
lander (t.js snippet)  ──POST──▶  track.php  ──▶  MySQL (events table)
                                                     │
   dashboard.php       ◀──────────  MySQL  ◀─────────┘
   (server-rendered + Chart.js)
```

**Why two stacks:** a portfolio demo must be *free and always-online*, which fits
serverless (Node/Vercel) — nothing to keep alive, no auto-suspension. A paying
client runs the same flow on ordinary **PHP + MySQL shared hosting**, where
commercial use is allowed and the endpoint is always up.

Geo/device are resolved **server-side**, never in the browser: the device, OS and
browser come from the user-agent, and the country from the platform's own edge
header — `x-vercel-ip-country` here, `CF-IPCountry` behind Cloudflare, or a local
GeoIP database (MaxMind GeoLite2) on plain shared hosting. No external lookup, so
nothing to block. The browser never talks to the database directly; only the
server does, so the DB stays private (RLS on in Supabase; server-only creds in PHP).

## The endpoint is public, so it is guarded

A tracking endpoint has to accept anonymous POSTs from any domain — that is what a
pixel is. What keeps it from being a free write API into the database:

| Guard | Where |
|---|---|
| only `pageview` / `click` / `lead` / `test` are accepted | `api/track.js` |
| request body capped at 2 KB | `api/track.js` |
| 10 events per minute per visitor → `429` | `api/track.js` |
| events older than 30 days are pruned | `api/track.js` (no scheduler needed) |
| every value is escaped before it reaches the dashboard | `public/index.html` |
| the database is reachable only through the server's key; RLS on, no public policies | `db/schema.sql` |

Rate limiting counts visitors without identifying them: the IP is salted and hashed
(SHA-256, truncated) and the raw address is never stored. Optional `IP_SALT` env var,
otherwise the server key is used as the salt.

## The money half: S2S postbacks

A pixel records traffic; a **postback** is how the money finds its way back to the
ad that produced it. The network calls one URL when a lead is approved, rejected
or still pending — and it knows nothing about your campaigns, only its own
`clickid`. The campaign and ad ids arrive earlier, on the click itself, from the
ad platform's macros in the landing URL. Joining the two by `clickid` is the whole
trick, and it is what the **Revenue by ad** card on the dashboard shows.

```
ad platform  ──▶  lander?clickid=abc&sub1={{campaign.id}}&sub3={{ad.id}}
                        │  t.js → /api/track → events (clickid + sub1..sub5)
                        ▼
network  ──▶  /api/postback?clickid=abc&txid=987&payout=12.50&status=approved
                        │  matched by clickid → conversion inherits the ad ids
                        ▼
                  which ad actually paid
```

Try it against the live demo — open the dashboard, it shows your click id and the
exact command:

```bash
curl "https://server-side-pixel.vercel.app/api/postback\
?token=demo-8bc1544c0aecb0ecce&clickid=YOUR-CLICKID&txid=tx-1&payout=12.50&status=approved"
```

| Parameter | Meaning |
|---|---|
| `token` | shared secret. **Published here deliberately** so the demo can be tried; a real deployment keeps `POSTBACK_TOKEN` private |
| `clickid` | the click to attribute to (`click_id` / `cid` also accepted) |
| `txid` | the network's transaction id (`transaction_id` / `conversion_id` also accepted) |
| `status` | `pending` / `approved` / `rejected` — revenue counts approved only, so a rejection is a reversal |
| `payout`, `currency` | amount and ISO code, capped at 10000 |

What the handler is careful about, because these are the things that actually
break in production:

- **Retries must not pay twice.** `txid` is unique and the write is an upsert, so a
  repeated postback updates that one conversion. The response says `repeated: true`,
  and `was: pending` when the status changed.
- **A 500 is a request to retry.** Transient database errors answer 500 on purpose —
  safe, because of the point above. Bad input answers 400 and is not retried.
- **Postbacks arrive for clicks you never saw** (lost pixel, cleared session). Those
  are stored with `matched: false` and counted separately rather than dropped, since
  dropping them would quietly overstate attribution.
- **An open postback endpoint is free money for whoever finds it** — hence the token,
  the payout cap and a 10-per-minute limit per caller.

## Reporting back: the Conversions API bridge

A browser pixel is blocked often enough that ad platforms now expect the **server**
to report conversions. So every approved postback also queues one outbound
delivery, and the dashboard shows the log: destination, HTTP status, latency,
attempt number, and the exact payload that was sent.

**Where it goes.** With `META_PIXEL_ID` and `META_ACCESS_TOKEN` set, deliveries go
to the real Graph API. Without them they go to `api/capi-sink.js` — our own
endpoint answering with the same contract, including a `400` for a malformed
payload and a `500` on `?fail=1` to exercise retries. The dashboard states which
destination is in use, and the sink's response carries `stand_in: true`. Nothing
pretends to be Meta; attaching credentials changes the destination, not the code.

**The parts that are actually hard**, none of which is the `fetch`:

- **`fbc` is not the raw `fbclid`.** The platform wants
  `fb.1.<clickTimeSeconds>.<fbclid>` and reads the click time out of it. Getting
  this wrong is the usual reason a server event never matches its click, and it
  fails silently — the event is accepted and simply attributed to nobody.
- **`event_id` is shared with the browser pixel.** Both sides sending the same id
  is what lets the platform drop the duplicate. Our own queue applies the same
  rule before sending: offered twice, the second is suppressed and counted, so the
  log shows the call arrived rather than hiding it.
- **Personal data is hashed at the door.** The postback hashes e-mail and phone on
  intake — normalise, then SHA-256, as the platform specifies — and only the hash
  is stored. The database never holds a readable address, so the payload cannot
  leak one even by mistake. Empty fields are omitted rather than sent blank.
- **`event_time` is clamped to the 7-day window** the platform accepts, because a
  postback can arrive later than that and a rejected batch is worse than a
  slightly adjusted timestamp.
- **Failures wait in the table, not in memory.** A serverless function cannot hold
  a background worker, so a failed delivery keeps `next_try_at` and the Cloudflare
  cron sweeps what is due every 15 minutes with a growing delay (1m, 5m, 25m, 2h,
  10h, then given up at five attempts). The sweeper lives on Cloudflare on
  purpose: the thing that repairs deliveries should not depend on the deployment
  whose deliveries broke.
- **A delivery never breaks a postback.** The network gets its `200` whatever the
  platform is doing; the delivery outcome is reported alongside, not instead.

## Tests

```bash
npm test            # 60 checks against the API
npm run test:browser  # 28 checks in a real browser
```

They run against a **deployed** instance — real HTTP, real Postgres, no mocks —
and delete every row they create, so the public demo is not left holding test
data. Both take a base URL as an argument, so a preview deployment can be
checked the same way. They need `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (the
assertions read the database), `POSTBACK_TOKEN` and `CRON_TOKEN`.

`tests/api.mjs` covers the event guards, keyset pagination walking the whole
table exactly once, the stand-in's contract, postback validation, attribution,
idempotency, reversal, the payload's shape and hashing, the retry sweeper and
the stats response. `tests/browser.mjs` walks a visitor's path at two widths —
arrive on a landing URL with ad macros, send a lead, fire the postback the page
prints, open the delivered payload — while failing on any console error or any
4xx/5xx, and sweeps 19 viewport widths for sideways scrolling.

The suite has already earned its keep twice: it caught the dashboard sending no
`fbclid` (so its own deliveries would have matched nobody), and a postback retry
with fewer parameters erasing the hashed identifiers the first call had stored.

## Period and source, like any tracker panel

Two selectors sit above everything: the period first, then the source. Tiles,
charts and tables all obey them, and both live in the URL so a filtered view can
be linked to. Without them the dashboard reads fine with one source and turns to
mush with two — every number becomes a blend of sites nobody asked to combine.

The aggregation is one database function, `dashboard_stats(p_site, p_since)`
(see `db/schema.sql`), which returns the whole payload as JSON. A view cannot
take arguments, and pulling rows out to count them in JavaScript is the version
that falls over once the table stops being small.

## The demo is tracked by its own pixel

Both pages carry `t.js` — the same single line a lander would add — so the
figures on the dashboard describe real visits rather than only the people who
pressed a button. That also means the first thing a visitor sees is their own
event: open the page, and the live tail already has your country and device in
it, read from the request on the server.

Automated browsers are skipped (`navigator.webdriver`): a test run opening the
page across twenty viewport widths is not twenty visitors, and counting it would
quietly inflate every number on the page.

## Two details worth a second look

**The log pages by cursor, not `offset`.** `/api/events` takes the last row seen as
`(created_at, id)` and asks for "older than this exact event". Under a live insert
stream `offset` is wrong, not just slow: a row arriving between two requests shifts
everything after it, so page 2 repeats a row page 1 already showed and another is
skipped. The cursor is also a plain index seek instead of walking and discarding rows.

**The dashboard has no polling timer.** Each refresh is a function invocation plus six
queries, so a tab left open on an interval would spend the free tier's egress on a page
nobody is watching. It refreshes on open, after your own event, and when the tab is
brought back — and a Cloudflare Worker pings `api/keepalive` every 3 days, because a
free Supabase project is paused after a week of inactivity and has to be restored by
hand. That cron deliberately does not live on Vercel: the job that keeps the site alive
should not depend on the deployment it watches.

## Files

| Path | What |
|------|------|
| `public/index.html` | the live dashboard (Chart.js) |
| `public/events.html` | the full event log — filters, cursor paging |
| `public/app.css`, `public/app.js` | shared styles and helpers (icons, flags, escaping) |
| `public/t.js` | the tracking snippet (the "pixel") |
| `api/track.js` | receives an event, resolves geo/device, writes to Supabase |
| `api/stats.js` | returns aggregates for the dashboard |
| `api/events.js` | the log's API — keyset pagination, filters |
| `api/postback.js` | S2S postback receiver — attribution, idempotency, statuses |
| `api/_capi.js` | Conversions API payload builder, hashing, transport, backoff |
| `api/_deliver.js` | the delivery queue: one attempt per row, dedupe, retry state |
| `api/capi-sink.js` | stand-in for the platform's endpoint when no pixel is attached |
| `api/capi-retry.js` | redelivers what failed; called by the cron, token-protected |
| `api/_shared.js` | hashed-IP rate limiting and retention, used by both writers |
| `api/keepalive.js` | one cheap query, called by the cron below |
| `cron/` | Cloudflare Worker that pings keepalive every 3 days |
| `db/schema.sql` | table `events` + aggregate views — run in Supabase (idempotent) |
| `tests/api.mjs`, `tests/browser.mjs` | end-to-end suites, run against a deployment |
| `.env.local` | local secrets (gitignored) |

**Worth a look:** `api/track.js` — geo/device resolution, the guards and the hashed
rate limiter; `db/schema.sql` — the aggregate views and why they are `security_invoker`;
`public/t.js` — 45 lines, derives its own endpoint, never throws on the host page.

---

## Setup / deploy (next steps)

1. **Supabase project** (org `playua20's Org`, FREE, region Europe, RLS enabled).
2. In Supabase → **SQL Editor** → paste `db/schema.sql` → **Run**.
3. Supabase → **Settings → API** → copy **Project URL** and **service_role key**.
   - put them in `.env.local` locally, and
   - in **Vercel → Project → Settings → Environment Variables**:
     - `SUPABASE_URL`
     - `SUPABASE_SERVICE_ROLE_KEY`
4. `npm install` (installs `@supabase/supabase-js`).
5. Deploy: push to GitHub → import in Vercel (or `vercel` CLI). Vercel serves
   `public/` statically and `api/*` as functions.
6. Open the deployed site → click **“Send a test event”** → it appears live.
   (`t.js` needs no editing: it derives the endpoint from its own `src`.)

### Embedding the snippet on a lander

One line records the pageview and reads `clickid`, `fbclid` and the `sub` values
out of the landing URL:

```html
<script src="https://server-side-pixel.vercel.app/t.js" data-site="my-lander" defer></script>
```

**Wiring it to the form.** Point the snippet at the form and its submit becomes a
lead — no handler to write:

```html
<script src="https://server-side-pixel.vercel.app/t.js"
        data-site="my-lander" data-lead-form="#order" defer></script>
```

Or call it yourself, which is what you want when the form posts over AJAX and
you only count a lead once the server has accepted it:

```html
<script>
  fetch('/order.php', { method: 'POST', body: data })
    .then(r => r.json())
    .then(res => { if (res.ok && window.track) window.track('lead', { sub5: 'form-main' }); });
</script>
```

Two things worth getting right on a real lander:

- **`window.track` may not exist yet.** The snippet is deferred, so guard the call
  (`window.track && window.track(...)`) or use `data-lead-form`, which attaches
  as soon as the snippet loads and fires on capture — even if the page's own
  handler stops propagation.
- **The click id has to survive the journey.** `t.js` reads it from the URL, so a
  lead sent from a thank-you page has no `clickid` unless you carry it there —
  in a hidden field, in the redirect, or in `sessionStorage`. Without it the
  network's postback has nothing to match, and the conversion lands as
  `matched: false`.

---

_Status: live at https://server-side-pixel.vercel.app_

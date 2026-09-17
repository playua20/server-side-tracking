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
   (index.html + Chart.js)        (aggregate views)
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

## Files

| Path | What |
|------|------|
| `public/index.html` | the live dashboard (Chart.js) |
| `public/t.js` | the tracking snippet (the "pixel") |
| `api/track.js` | receives an event, resolves geo/device, writes to Supabase |
| `api/stats.js` | returns aggregates for the dashboard |
| `db/schema.sql` | table `events` + aggregate views — run in Supabase (idempotent) |
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

```html
<script src="https://server-side-pixel.vercel.app/t.js" data-site="my-lander" defer></script>
<!-- custom event, e.g. on form submit: -->
<script>window.track('lead', { sub1: 'abc' });</script>
```

---

_Status: live at https://server-side-pixel.vercel.app_

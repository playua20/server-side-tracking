import { createClient } from '@supabase/supabase-js';
import { ipHash, overLimit, pruneSometimes, isBot } from './_shared.js';

// Server-side Supabase client (service_role bypasses RLS — server only, never shipped to the browser).
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

/** Tiny dependency-free UA classifier → device / os / browser. */
function parseUA(ua = '') {
  const s = ua.toLowerCase();
  let device = 'desktop';
  if (/mobile|iphone|windows phone/.test(s) || (/android/.test(s) && /mobile/.test(s))) device = 'mobile';
  else if (/ipad|tablet|(android(?!.*mobile))/.test(s)) device = 'tablet';

  let os = 'other';
  if (/windows/.test(s)) os = 'Windows';
  else if (/android/.test(s)) os = 'Android';
  else if (/iphone|ipad|ios/.test(s)) os = 'iOS';
  else if (/mac os/.test(s)) os = 'macOS';
  else if (/linux/.test(s)) os = 'Linux';

  let browser = 'other';
  if (/edg\//.test(s)) browser = 'Edge';
  else if (/chrome|crios/.test(s)) browser = 'Chrome';
  else if (/firefox|fxios/.test(s)) browser = 'Firefox';
  else if (/safari/.test(s)) browser = 'Safari';

  return { device, os, browser };
}

const str = (v, max) => (v == null ? null : String(v).slice(0, max));

/**
 * Where the visitor came from, reduced to a grouping key.
 *   none            → 'direct'   (typed, bookmarked, or an app that strips it)
 *   the page itself → 'internal' (navigation inside the same site)
 *   anything else   → the host, without www.
 * Parsed on the server because a malformed URL must not be able to break the
 * beacon, and because the host is what a report groups by.
 */
function refHost(ref, ownHost) {
  if (!ref) return 'direct';
  try {
    const host = new URL(ref).hostname.replace(/^www\./, '');
    return host && host === ownHost ? 'internal' : host;
  } catch (e) {
    return 'unknown';
  }
}

// The endpoint is public by design (that is what a pixel is), so it is guarded:
const TYPES = new Set(['pageview', 'click', 'lead', 'test']); // anything else is refused
const MAX_BODY = 2000;      // bytes — a legitimate event is a few hundred
const MAX_PER_MINUTE = 10;  // per visitor, by salted IP hash — see _shared.js
const KEEP_DAYS = 30;       // older events are pruned, so the free tier can't fill up

export default async function handler(req, res) {
  // CORS — the snippet runs on other domains (client landers).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    // Checked before anything else touches the database: a crawler costs us a
    // regex, not a write and two queries. The answer is a plain 200 — nothing
    // is served by telling a scraper what was recognised.
    if (isBot(req.headers['user-agent'])) {
      return res.status(200).json({ ok: true, ignored: 'bot' });
    }

    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY) return res.status(413).json({ ok: false, error: 'payload too large' });

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const type = str(b.type, 32) || 'pageview';
    if (!TYPES.has(type)) return res.status(400).json({ ok: false, error: 'unknown event type' });

    const ip_hash = ipHash(req);
    if (await overLimit(supabase, 'events', ip_hash, MAX_PER_MINUTE)) {
      return res.status(429).json({ ok: false, error: 'too many events' });
    }

    const { device, os, browser } = parseUA(req.headers['user-agent']);

    const row = {
      type,
      ip_hash,
      site:    str(b.site, 64),
      clickid: str(b.clickid, 128),
      // Ad-platform click ids, needed later to match a server-side conversion.
      fbclid:  str(b.fbclid, 255),
      fbp:     str(b.fbp, 128),
      sub1: str(b.sub1, 255), sub2: str(b.sub2, 255), sub3: str(b.sub3, 255),
      sub4: str(b.sub4, 255), sub5: str(b.sub5, 255),
      // Real geo, straight from Vercel's edge headers — no external lookup needed.
      country: req.headers['x-vercel-ip-country'] || null,
      city:    req.headers['x-vercel-ip-city'] ? decodeURIComponent(req.headers['x-vercel-ip-city']) : null,
      device, os, browser,
      referer:    req.headers['referer'] || null,
      user_agent: str(req.headers['user-agent'], 512),
      // The traffic source, as the browser reported it — not the header above,
      // which is always the page that fired the beacon.
      ref_url:    str(b.ref, 512),
      ref_host:   refHost(b.ref, (() => {
        try { return new URL(req.headers['referer'] || '').hostname.replace(/^www\./, ''); }
        catch (e) { return null; }
      })()),
    };

    const { error } = await supabase.from('events').insert(row);
    if (error) throw error;

    await pruneSometimes(supabase, 'events', KEEP_DAYS);

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

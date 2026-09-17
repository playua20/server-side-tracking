import { createHash } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

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

// The endpoint is public by design (that is what a pixel is), so it is guarded:
const TYPES = new Set(['pageview', 'click', 'lead', 'test']); // anything else is refused
const MAX_BODY = 2000;      // bytes — a legitimate event is a few hundred
const MAX_PER_MINUTE = 10;  // per visitor, see ipHash below
const KEEP_DAYS = 30;       // older events are pruned, so the free tier can't fill up

/** Visitors are counted, not identified: the IP is salted and hashed, never stored raw. */
function ipHash(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  if (!ip) return null;
  const salt = process.env.IP_SALT || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  return createHash('sha256').update(ip + salt).digest('hex').slice(0, 32);
}

export default async function handler(req, res) {
  // CORS — the snippet runs on other domains (client landers).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    if (raw.length > MAX_BODY) return res.status(413).json({ ok: false, error: 'payload too large' });

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const type = str(b.type, 32) || 'pageview';
    if (!TYPES.has(type)) return res.status(400).json({ ok: false, error: 'unknown event type' });

    const ip_hash = ipHash(req);
    if (ip_hash) {
      const since = new Date(Date.now() - 60_000).toISOString();
      const { count } = await supabase.from('events')
        .select('*', { count: 'exact', head: true })
        .eq('ip_hash', ip_hash).gte('created_at', since);
      if ((count || 0) >= MAX_PER_MINUTE) return res.status(429).json({ ok: false, error: 'too many events' });
    }

    const { device, os, browser } = parseUA(req.headers['user-agent']);

    const row = {
      type,
      ip_hash,
      site:    str(b.site, 64),
      clickid: str(b.clickid, 128),
      sub1: str(b.sub1, 255), sub2: str(b.sub2, 255), sub3: str(b.sub3, 255),
      sub4: str(b.sub4, 255), sub5: str(b.sub5, 255),
      // Real geo, straight from Vercel's edge headers — no external lookup needed.
      country: req.headers['x-vercel-ip-country'] || null,
      city:    req.headers['x-vercel-ip-city'] ? decodeURIComponent(req.headers['x-vercel-ip-city']) : null,
      device, os, browser,
      referer:    req.headers['referer'] || null,
      user_agent: str(req.headers['user-agent'], 512),
    };

    const { error } = await supabase.from('events').insert(row);
    if (error) throw error;

    // Retention, without a scheduler: roughly one request in a hundred prunes
    // whatever has aged out. Failure here must never fail the event itself.
    if (Math.random() < 0.01) {
      const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString();
      await supabase.from('events').delete().lt('created_at', cutoff);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

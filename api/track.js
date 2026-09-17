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

export default async function handler(req, res) {
  // CORS — the snippet runs on other domains (client landers).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { device, os, browser } = parseUA(req.headers['user-agent']);

    const row = {
      type:    str(b.type, 32) || 'pageview',
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

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

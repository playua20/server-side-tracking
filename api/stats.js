import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// A panel has a period and a source selector, and everything below obeys them —
// so the aggregation lives in one database function that takes both as
// arguments (db/schema.sql → dashboard_stats). One round trip, and the counting
// happens where the rows are.
const PERIODS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30, all: null };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    const period = Object.hasOwn(PERIODS, q.period) ? q.period : '30d';
    const hours = PERIODS[period];
    // The site name comes from the page's own data-site, so it is untrusted:
    // keep it to the shape a site name actually has.
    const site = /^[\w.-]{1,64}$/.test(q.site || '') ? q.site : null;

    const { data, error } = await supabase.rpc('dashboard_stats', {
      p_site: site,
      p_since: hours ? new Date(Date.now() - hours * 3600e3).toISOString() : null,
    });
    if (error) throw error;

    res.status(200).json({ ...data, period, site });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

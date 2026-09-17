import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Read-only aggregates for the public dashboard. Runs server-side (service_role),
// so the browser never touches Supabase directly.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const [total, byType, byCountry, byDevice, byHour, recent, conv, byAd] = await Promise.all([
      supabase.from('events').select('*', { count: 'exact', head: true }),
      supabase.from('stats_by_type').select('*'),
      supabase.from('stats_by_country').select('*').limit(12),
      supabase.from('stats_by_device').select('*'),
      supabase.from('stats_by_hour').select('*').limit(48),
      supabase.from('events')
        .select('type,site,country,device,browser,created_at')
        .order('created_at', { ascending: false })
        .limit(30), // a scrollable tail of the newest events, not a full archive
      supabase.from('stats_conversions').select('*').maybeSingle(),
      supabase.from('stats_by_ad').select('*').limit(10),
    ]);

    res.status(200).json({
      total:     total.count || 0,
      byType:    byType.data || [],
      byCountry: byCountry.data || [],
      byDevice:  byDevice.data || [],
      byHour:    (byHour.data || []).reverse(), // view is newest-first; chart wants oldest-first
      recent:    recent.data || [],
      // The money side: postback-created conversions, and which ad they came from.
      conversions: conv?.data || { n: 0, approved: 0, pending: 0, rejected: 0, orphans: 0, revenue: 0 },
      byAd:      byAd?.data || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

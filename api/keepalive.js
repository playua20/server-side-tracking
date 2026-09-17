import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Supabase pauses a free project after a week without activity, and a paused
// project does NOT wake up on its own — the owner has to restore it by hand.
// So an external cron (Cloudflare Worker, see cron/) calls this every 3 days.
// One cheap query is enough to reset the clock; /api/stats would cost six.
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { count, error } = await supabase
      .from('events').select('*', { count: 'exact', head: true });
    if (error) throw error;
    return res.status(200).json({ ok: true, events: count ?? 0, at: new Date().toISOString() });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
